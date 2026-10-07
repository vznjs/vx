// `vx-migrate [--from turbo|nx] [--native|--keep] [--no-install] [--dry]
// [--force] [--mjs]` — one vx.config.ts per workspace package from an
// existing Turbo or Nx setup (`--keep`: the workspace file that reads it
// live instead, as `vx init` writes it), and vx installed with the repo's
// manager.
// Without either mode flag a terminal is asked; anything else is native. Source auto-detect: turbo.json → Turbo;
// .nx/workspace-data/project-graph.json, nx.json or a Lerna-on-Nx lerna.json → Nx (the resolved
// graph, exported by nx if absent);
// The mappers return a plan; core's migration seam
// (`applyMigration`) renders, guards, writes and reports, so what this
// package writes reads exactly like what `vx init` writes.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
  ownVersion,
  parseModeAnswer,
} from './adopt.js'
import { migrateTurbo } from './migrate-turbo.js'
import { turboConfigFile } from './turbo/turbo-map.js'
import {
  extendWorkspaceFile,
  undeclared,
  renderWorkspaceFile,
  workspaceFileAt,
  workspacePlugins,
  type WorkspacePlugin,
} from './workspace-plugins.js'

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
  // A Turbo repo's lerna.json publishes; Turbo runs its tasks.
  const lerna = !hasTurbo && !hasGraph && !hasNxJson && lernaOnNx(root)

  // Evaluating teams routinely have two runners checked in — never
  // ask anyone to delete anything; --from disambiguates.
  const found = (
    [
      ['turbo', hasTurbo, 'turbo.json'],
      ['nx', hasGraph || hasNxJson || lerna, 'an nx workspace'],
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
    parsed.from ?? (hasTurbo ? 'turbo' : hasGraph || hasNxJson || lerna ? 'nx' : undefined)
  if (runner === undefined) {
    throw new UserError(
      'nothing to migrate: no turbo.json and no Nx workspace — ' +
        'for package.json scripts, run `vx init`',
    )
  }
  const mode = parsed.mode ?? (await askMode(runner, lerna ? 'lerna.json' : undefined, parsed.dry))
  if (mode === 'keep') return keep(root, runner, hasTurbo, lerna, parsed)

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
  // No workspace file yet: write one declaring the plugins the repo calls
  // for, and drop the note that told the user to declare the lockfile one.
  const plugins = workspaceFileAt(root) === undefined ? workspacePlugins(root) : []
  if (plugins.length > 0) {
    plan = {
      ...plan,
      headerNotes: plan.headerNotes.filter((n) => !n.includes('from @vzn/vx-lockfile')),
      extraFiles: [
        ...plan.extraFiles,
        { relPath: `vx.workspace.${format}`, contents: renderWorkspaceFile(plugins, format) },
      ],
    }
  }
  const headerNotes = refused
    ? []
    : await prepareRepo(root, ['@vzn/vx', ...plugins.map((p) => p.pkg)], parsed)
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
async function askMode(
  runner: 'turbo' | 'nx',
  file: string | undefined,
  dry: boolean,
): Promise<AdoptionMode> {
  if (dry || !process.stdin.isTTY || !process.stdout.isTTY) return 'native'
  const source = file ?? (runner === 'turbo' ? 'turbo.json' : 'nx.json')
  for (;;) {
    const mode = parseModeAnswer(prompt(MODE_QUESTION(runner, source)))
    if (mode !== undefined) return mode
  }
}

/**
 * Install what the written files import. Returns the report's line;
 * installs nothing under `--dry`.
 */
async function prepareRepo(
  root: string,
  wanted: readonly string[],
  args: MigrateArgs,
): Promise<string[]> {
  const notes: string[] = []
  const version = ownVersion()
  const missing = args.noInstall === true ? [] : missingPackages(root, wanted, version)
  if (missing.length > 0) {
    if (args.dry) notes.push(`would install ${missing.join(' ')} (dry run)`)
    else notes.push(`installed ${missing.join(' ')} (${await install(root, missing, version)})`)
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
  lerna: boolean,
  args: MigrateArgs,
): Promise<number> {
  // `vx init` reads turbo.json first.
  if (runner === 'nx' && hasTurbo) {
    throw new UserError(
      '--keep with --from nx: turbo.json is here too, and vx init adopts it first',
    )
  }
  // The plugins go into the file `vx init` writes, or into one already
  // here in that shape; another shape is the user's, and left alone.
  const existing = workspaceFileAt(root)
  const plugins =
    existing === undefined ||
    extendWorkspaceFile(readFileSync(path.join(root, existing), 'utf8'), []) !== null
      ? workspacePlugins(root)
      : []
  for (const note of await prepareRepo(
    root,
    ['@vzn/vx', '@vzn/vx-migrate', ...plugins.map((p) => p.pkg)],
    args,
  )) {
    process.stdout.write(`vx-migrate: ${note}\n`)
  }
  // `vx init` adopts nx() by nx.json, and a Lerna repo may have none: it
  // would map the scripts instead, so the file is written here.
  if (lerna) return keepLerna(root, plugins, args)
  // A resolve that misses from a directory with no node_modules is an
  // auto-install under Bun: ask the root only where it has the package.
  const installed = path.join(root, 'node_modules', '@vzn', 'vx')
  const core = existsSync(path.join(installed, 'package.json'))
    ? path.join(realpathSync(installed), 'src', 'index.ts')
    : Bun.resolveSync('@vzn/vx', import.meta.dir)
  const flags = [args.dry && '--dry', args.force && '--force', args.mjs && '--mjs'].filter(
    (f): f is string => typeof f === 'string',
  )
  const code = await Bun.spawn(
    [process.execPath, '--no-install', path.join(path.dirname(core), 'bin.ts'), 'init', ...flags],
    { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] },
  ).exited
  const written = workspaceFileAt(root)
  if (code !== 0 || args.dry || written === undefined || plugins.length === 0) return code
  const file = path.join(root, written)
  const text = readFileSync(file, 'utf8')
  const extended = extendWorkspaceFile(text, plugins)
  if (extended !== null && extended !== text) {
    await Bun.write(file, extended)
    const names = undeclared(text, plugins).map((p) => `${p.factory}()`)
    process.stdout.write(`vx-migrate: declared ${names.join(', ')} in ${written}\n`)
  }
  return code
}

/** `--keep` in a Lerna repo with no nx.json: the workspace file declaring `nx()`. */
async function keepLerna(
  root: string,
  plugins: readonly WorkspacePlugin[],
  args: MigrateArgs,
): Promise<number> {
  const format = args.mjs ? 'mjs' : 'ts'
  const name = `vx.workspace.${format}`
  const existing = workspaceFileAt(root)
  const all = [{ pkg: '@vzn/vx-migrate', factory: 'nx' }, ...plugins]
  if (existing !== undefined && !args.force) {
    const text = readFileSync(path.join(root, existing), 'utf8')
    const extended = extendWorkspaceFile(text, all)
    if (extended === null) {
      throw new UserError(
        `${existing} exists; add nx() from @vzn/vx-migrate to its plugins, or --force replaces it`,
      )
    }
    if (!args.dry && extended !== text) await Bun.write(path.join(root, existing), extended)
    const names = undeclared(text, all).map((p) => `${p.factory}()`)
    if (names.length > 0)
      process.stdout.write(
        `vx-migrate: ${args.dry ? 'would declare' : 'declared'} ${names.join(', ')} in ${existing}\n`,
      )
    return 0
  }
  const text = renderWorkspaceFile(all, format)
  if (args.dry) {
    process.stdout.write(`── ${name} ──\n${text}\nvx-migrate: would write ${name} (dry run)\n`)
    return 0
  }
  if (existing !== undefined && existing !== name) await rm(path.join(root, existing))
  await Bun.write(path.join(root, name), text)
  process.stdout.write(`vx-migrate: lerna.json found — wrote ${name} declaring nx()\n`)
  return 0
}

/**
 * Lerna 6+ runs `lerna run` on Nx's task runner over the graph `nx graph`
 * exports, nx.json or not, unless lerna.json says `useNx: false`; Lerna 5
 * ran its own unless it said `useNx: true`. The version is the installed
 * one, else the root manifest's range; unknown is a current Lerna.
 */
function lernaOnNx(root: string): boolean {
  let useNx: unknown
  try {
    useNx = (JSON.parse(readFileSync(path.join(root, 'lerna.json'), 'utf8')) as { useNx?: unknown })
      ?.useNx
  } catch {
    return false
  }
  if (typeof useNx === 'boolean') return useNx
  const json = (file: string): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  const installed = json(path.join(root, 'node_modules', 'lerna', 'package.json'))?.['version']
  const manifest = json(path.join(root, 'package.json'))
  const declared = ['devDependencies', 'dependencies']
    .map((k) => (manifest?.[k] as Record<string, unknown> | undefined)?.['lerna'])
    .find((v): v is string => typeof v === 'string')
  const major = /\d+/.exec(typeof installed === 'string' ? installed : (declared ?? ''))?.[0]
  return major === undefined || Number(major) >= 6
}
