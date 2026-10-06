// `vx-migrate [--from turbo|nx] [--native|--keep] [--no-install] [--dry]
// [--force] [--mjs]` — one vx.config.ts per workspace package from an
// existing Turbo or Nx setup (`--keep`: the workspace file that reads it
// live instead, as `vx init` writes it), and vx installed with the repo's
// manager.
// Without either mode flag a terminal is asked; anything else is native. Source auto-detect: turbo.json → Turbo;
// .nx/workspace-data/project-graph.json or nx.json → Nx (the resolved graph, exported by nx if absent);
// The mappers return a plan; core's migration seam
// (`applyMigration`) renders, guards, writes and reports, so what this
// package writes reads exactly like what `vx init` writes.

import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyMigration,
  findWorkspaceRoot,
  isUserError,
  listProjectMetas,
  loadWorkspace,
  type MigrationFormat,
  type MigrationPlan,
  UserError,
} from '@vzn/vx'
import { migrateNx, NX_GRAPH_REL } from './migrate-nx.js'
import { exportGraph } from './nx/export-graph.js'
import {
  type AdoptionMode,
  install,
  missingPackages,
  MODE_QUESTION,
  parseModeAnswer,
} from './adopt.js'
import { migrateTurbo } from './migrate-turbo.js'
import { turboConfigFile } from './turbo/turbo-map.js'

export interface MigrateArgs {
  dry: boolean
  force: boolean
  /** `vx.config.mjs` (and `vx-preset.mjs`) instead of `.ts`. */
  mjs: boolean
  from?: 'turbo' | 'nx'
  /** `--native` / `--keep`; unset asks a terminal and is native elsewhere. */
  mode?: AdoptionMode
  /** `--no-install`: leave package.json's dependencies alone. */
  noInstall?: boolean
  /** `--help` / `-h`: the usage on stdout, exit 0 (as `nx-env --help`). */
  help?: boolean
  error?: string
}

const USAGE =
  'usage: vx-migrate [--from turbo|nx] [--native|--keep] [--no-install] [--dry] [--force] [--mjs]'

export function parseMigrateArgs(args: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { dry: false, force: false, mjs: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--mjs') out.mjs = true
    else if (a === '--no-install') out.noInstall = true
    else if (a === '--native' || a === '--keep') {
      const mode = a === '--native' ? 'native' : 'keep'
      if (out.mode !== undefined && out.mode !== mode) {
        return { ...out, error: '--native and --keep are two answers to one question; pass one' }
      }
      out.mode = mode
    } else if (a === '--from' || a?.startsWith('--from=')) {
      const v = a === '--from' ? args[++i] : a.slice('--from='.length)
      if (v !== 'turbo' && v !== 'nx') {
        return {
          ...out,
          error: `--from must be turbo or nx (package.json scripts: \`vx init\`)`,
        }
      }
      out.from = v
    } else if (a === '--help' || a === '-h') return { ...out, help: true }
    else if (a?.startsWith('-')) return { ...out, error: `unknown flag: ${a}\n${USAGE}` }
    else return { ...out, error: `unexpected argument: ${a}\n${USAGE}` }
  }
  return out
}

/**
 * Core finds a root by a package manager's workspace file; a Rush repo can
 * have none. Say which tool is there and what vx needs from it.
 */
async function noRootReason(cwd: string, err: Error): Promise<Error> {
  if (await Bun.file(path.join(cwd, 'rush.json')).exists()) {
    return new UserError(
      'a Rush workspace: vx does not yet discover projects from rush.json (it finds them through package.json workspaces or pnpm-workspace.yaml)',
    )
  }
  return err
}

/** The command: detect the source, map it, hand the plan to core. Returns the exit code. */
export async function migrateCmd(args: readonly string[]): Promise<number> {
  const parsed = parseMigrateArgs(args)
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (parsed.error) {
    process.stderr.write(`vx-migrate: ${parsed.error}\n`)
    return 1
  }
  const root = await findWorkspaceRoot(process.cwd()).catch(async (err: unknown) => {
    throw isUserError(err) ? await noRootReason(process.cwd(), err) : err
  })
  const metas = await listProjectMetas(await loadWorkspace(root))

  const turboFile = await turboConfigFile(root)
  const hasTurbo = turboFile !== null
  const hasGraph = await Bun.file(path.join(root, NX_GRAPH_REL)).exists()
  const hasNxJson = await Bun.file(path.join(root, 'nx.json')).exists()

  // Evaluating teams routinely have two runners checked in — never
  // ask anyone to delete anything; --from disambiguates.
  const found = (
    [
      ['turbo', hasTurbo, 'turbo.json'],
      ['nx', hasGraph || hasNxJson, 'an nx workspace'],
    ] as const
  ).filter(([, present]) => present)
  if (parsed.from === undefined && found.length > 1) {
    const what = found.map(([, , label]) => label)
    const listed =
      what.length === 2
        ? `both ${what[0]} and ${what[1]}`
        : `${what.slice(0, -1).join(', ')} and ${what.at(-1)}`
    throw new UserError(
      `${listed} are present — pass ${found.map(([id]) => `--from ${id}`).join(' or ')}`,
    )
  }
  if (parsed.from === 'turbo' && !hasTurbo) {
    throw new UserError('--from turbo, but no turbo.json at the workspace root')
  }

  const runner: 'turbo' | 'nx' | undefined =
    parsed.from ?? (hasTurbo ? 'turbo' : hasGraph || hasNxJson ? 'nx' : undefined)
  if (runner === undefined) {
    throw new UserError(
      'nothing to migrate: no turbo.json and no Nx workspace — ' +
        'for package.json scripts, run `vx init`',
    )
  }
  const mode = parsed.mode ?? (await askMode(runner, parsed.dry))
  if (mode === 'keep') return keep(root, runner, hasTurbo, parsed)

  const format: MigrationFormat = parsed.mjs ? 'mjs' : 'ts'
  let source: string
  let plan: MigrationPlan
  if (runner === 'nx') {
    if (hasGraph) {
      source = NX_GRAPH_REL
      plan = await migrateNx(root, metas, format)
    } else {
      // Modern Nx stores the graph in SQLite, so the JSON snapshot exists only
      // when exported. The workspace's own nx exports it, as `nx()` does, into
      // a temp file; the user ran that step by hand until 2026-10-01.
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-nx-'))
      try {
        const snapshot = path.join(tmp, 'project-graph.json')
        const why = await exportGraph(root, snapshot)
        if (why !== null) {
          throw new UserError(
            `no resolved Nx graph found, and exporting one failed (${why}) — export it with ` +
              '`nx graph --file=.nx/workspace-data/project-graph.json`, then re-run vx-migrate',
          )
        }
        source = 'nx graph'
        plan = await migrateNx(root, metas, format, snapshot)
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    }
  } else {
    source = path.basename(turboFile ?? 'turbo.json')
    plan = await migrateTurbo(root, metas, format)
  }
  // Before the write, so the report's `next:` line runs the installed vx;
  // not when the write will be refused for a config already there.
  const configName = `vx.config.${format}`
  const refused =
    !parsed.force &&
    (plan.projects.some(
      (p) =>
        p.tasks.length > 0 &&
        (metas.some((m) => m.dir === p.dir && m.configPath) ||
          existsSync(path.join(p.dir, configName))),
    ) ||
      plan.extraFiles.some((f) => existsSync(path.join(root, f.relPath))))
  const headerNotes = refused ? [] : await prepareRepo(root, 'native', parsed)
  return applyMigration({
    root,
    metas,
    plan,
    source,
    verb: 'vx-migrate',
    notes: headerNotes,
    dry: parsed.dry,
    force: parsed.force,
    format,
  })
}

/** A terminal is asked which adoption it wants; anything else gets native. */
async function askMode(runner: 'turbo' | 'nx', dry: boolean): Promise<AdoptionMode> {
  if (dry || !process.stdin.isTTY || !process.stdout.isTTY) return 'native'
  const source = runner === 'turbo' ? 'turbo.json' : 'nx.json'
  for (;;) {
    const mode = parseModeAnswer(prompt(MODE_QUESTION(runner, source)))
    if (mode !== undefined) return mode
  }
}

/**
 * Install what the written files import. Returns the report's line;
 * installs nothing under `--dry`.
 */
async function prepareRepo(root: string, mode: AdoptionMode, args: MigrateArgs): Promise<string[]> {
  const notes: string[] = []
  const missing = args.noInstall === true ? [] : missingPackages(root, mode)
  if (missing.length > 0) {
    if (args.dry) notes.push(`would install ${missing.join(' ')} (dry run)`)
    else notes.push(`installed ${missing.join(' ')} (${await install(root, missing)})`)
  }
  return notes
}

/**
 * `--keep`: the workspace file `vx init` writes, declaring `turbo()` or
 * `nx()`, so the runner's own config stays the source. `vx init` is the
 * one writer of that file; this runs the installed one.
 */
async function keep(
  root: string,
  runner: 'turbo' | 'nx',
  hasTurbo: boolean,
  args: MigrateArgs,
): Promise<number> {
  // `vx init` reads turbo.json first.
  if (runner === 'nx' && hasTurbo) {
    throw new UserError(
      '--keep with --from nx: turbo.json is here too, and vx init adopts it first',
    )
  }
  for (const note of await prepareRepo(root, 'keep', args)) {
    process.stdout.write(`vx-migrate: ${note}\n`)
  }
  // A resolve that misses from a directory with no node_modules is an
  // auto-install under Bun: ask the root only where it has the package.
  const installed = path.join(root, 'node_modules', '@vzn', 'vx')
  const core = existsSync(path.join(installed, 'package.json'))
    ? path.join(realpathSync(installed), 'src', 'index.ts')
    : Bun.resolveSync('@vzn/vx', import.meta.dir)
  const flags = [args.dry && '--dry', args.force && '--force', args.mjs && '--mjs'].filter(
    (f): f is string => typeof f === 'string',
  )
  return Bun.spawn(
    [process.execPath, '--no-install', path.join(path.dirname(core), 'bin.ts'), 'init', ...flags],
    { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] },
  ).exited
}
