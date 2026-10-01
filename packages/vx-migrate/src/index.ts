// `vx-migrate [--from turbo|nx|moon|wireit|lage|scripts] [--dry] [--force] [--mjs]` — one
// vx.config.ts per workspace package from an existing Turbo, Nx, moon, wireit or lage
// setup. Source auto-detect: turbo.json → Turbo;
// .nx/workspace-data/project-graph.json or nx.json → Nx (the resolved graph, exported by nx if absent);
// .moon/workspace.yml → moon; a package.json `wireit` block → wireit;
// lage.config.js → lage. The mappers return a plan; core's migration seam
// (`applyMigration`) renders, guards, writes and reports, so what this
// package writes reads exactly like what `vx init` writes.

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
import { migrateLage } from './migrate-lage.js'
import { migrateMoon } from './migrate-moon.js'
import { migrateNx, NX_GRAPH_REL } from './migrate-nx.js'
import { exportGraph } from './nx/export-graph.js'
import { migrateScripts } from './migrate-scripts.js'
import { rootScripts } from './scripts/index.js'
import { parseFanOut } from './scripts/scripts-map.js'
import { migrateWireit } from './migrate-wireit.js'
import { migrateTurbo } from './migrate-turbo.js'
import { lageConfigFile } from './lage/lage-map.js'
import { moonWorkspaceFile } from './moon/moon-map.js'
import { turboConfigFile } from './turbo/turbo-map.js'
import { wireitOf } from './wireit/wireit-map.js'

// The plugins: the Turbo, Nx and moon project stages (a repo runs
// unchanged), and the two remote caches speaking Turbo's and Nx's wire.
export * from './turbo/index.js'
export * from './nx/index.js'
export * from './moon/index.js'
export * from './wireit/index.js'
export * from './lage/index.js'
export * from './scripts/index.js'
export * from './turbo-cache/index.js'
export * from './nx-cache/index.js'

export interface MigrateArgs {
  dry: boolean
  force: boolean
  /** `vx.config.mjs` (and `vx-preset.mjs`) instead of `.ts`. */
  mjs: boolean
  from?: 'turbo' | 'nx' | 'moon' | 'wireit' | 'lage' | 'scripts'
  /** `--help` / `-h`: the usage on stdout, exit 0 (as `nx-env --help`). */
  help?: boolean
  error?: string
}

const USAGE =
  'usage: vx-migrate [--from turbo|nx|moon|wireit|lage|scripts] [--dry] [--force] [--mjs]'

export function parseMigrateArgs(args: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { dry: false, force: false, mjs: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--mjs') out.mjs = true
    else if (a === '--from' || a?.startsWith('--from=')) {
      const v = a === '--from' ? args[++i] : a.slice('--from='.length)
      if (
        v !== 'turbo' &&
        v !== 'nx' &&
        v !== 'moon' &&
        v !== 'wireit' &&
        v !== 'lage' &&
        v !== 'scripts'
      ) {
        return {
          ...out,
          error: `--from must be turbo, nx, moon, wireit, lage or scripts (package.json scripts: \`vx init\`)`,
        }
      }
      out.from = v
    } else if (a === '--help' || a === '-h') return { ...out, help: true }
    else if (a?.startsWith('-')) return { ...out, error: `unknown flag: ${a}\n${USAGE}` }
    else return { ...out, error: `unexpected argument: ${a}\n${USAGE}` }
  }
  return out
}

/** Whether a root script fans a script out to the packages. */
async function hasFanOut(root: string): Promise<boolean> {
  const scripts = await rootScripts(root)
  return Object.values(scripts).some(
    (b) => typeof b === 'string' && b.split(/&&|;/).some((c) => parseFanOut(c.trim()) !== null),
  )
}

/**
 * Core finds a root by a package manager's workspace file; a moon or Rush
 * repo can have neither (OpenCut: `.moon/` and a Cargo workspace, no root
 * `package.json`). Say which tool is there and what vx needs from it.
 */
async function noRootReason(cwd: string, err: Error): Promise<Error> {
  if ((await moonWorkspaceFile(cwd)) !== null) {
    return new UserError(
      'a moon workspace with no root package.json or pnpm-workspace.yaml: vx finds projects through the package manager\'s workspaces — list the moon projects that have a package.json under "workspaces" and re-run',
    )
  }
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
  const moonFile = await moonWorkspaceFile(root)
  const hasWireit = metas.some((m) => Object.keys(wireitOf(m)).length > 0)
  const lageFile = await lageConfigFile(root)

  // Evaluating teams routinely have two runners checked in — never
  // ask anyone to delete anything; --from disambiguates.
  const found = (
    [
      ['turbo', hasTurbo, 'turbo.json'],
      ['nx', hasGraph || hasNxJson, 'an nx workspace'],
      ['moon', moonFile !== null, 'a moon workspace'],
      ['wireit', hasWireit, 'wireit scripts'],
      ['lage', lageFile !== null, 'a lage config'],
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
  if (parsed.from === 'moon' || (parsed.from === undefined && found[0]?.[0] === 'moon')) {
    if (moonFile === null)
      throw new UserError('--from moon, but no .moon/workspace.yml at the workspace root')
    const format: MigrationFormat = parsed.mjs ? 'mjs' : 'ts'
    return applyMigration({
      root,
      metas,
      plan: await migrateMoon(root, metas),
      source: path.relative(root, moonFile),
      verb: 'vx-migrate',
      dry: parsed.dry,
      force: parsed.force,
      format,
    })
  }
  // The last source: a root package.json whose scripts fan out through the
  // package manager. Every other runner wins over it, as it wraps them too.
  const fanOuts =
    parsed.from === 'scripts' || (parsed.from === undefined && found.length === 0)
      ? await hasFanOut(root)
      : false
  if (parsed.from === 'scripts' || fanOuts) {
    if (!fanOuts) {
      throw new UserError(
        '--from scripts, but no root package.json script fans out (`pnpm -r`, `npm --workspaces`, …) — for package.json scripts, run `vx init`',
      )
    }
    return applyMigration({
      root,
      metas,
      plan: await migrateScripts(root, metas),
      source: 'package.json scripts',
      verb: 'vx-migrate',
      dry: parsed.dry,
      force: parsed.force,
      format: parsed.mjs ? 'mjs' : 'ts',
    })
  }
  if (parsed.from === 'lage' || (parsed.from === undefined && found[0]?.[0] === 'lage')) {
    if (lageFile === null)
      throw new UserError('--from lage, but no lage.config.js at the workspace root')
    return applyMigration({
      root,
      metas,
      plan: await migrateLage(root, metas, lageFile),
      source: path.basename(lageFile),
      verb: 'vx-migrate',
      dry: parsed.dry,
      force: parsed.force,
      format: parsed.mjs ? 'mjs' : 'ts',
    })
  }
  if (parsed.from === 'wireit' || (parsed.from === undefined && found[0]?.[0] === 'wireit')) {
    if (!hasWireit) throw new UserError('--from wireit, but no package declares a wireit script')
    return applyMigration({
      root,
      metas,
      plan: await migrateWireit(root, metas),
      source: 'package.json wireit',
      verb: 'vx-migrate',
      dry: parsed.dry,
      force: parsed.force,
      format: parsed.mjs ? 'mjs' : 'ts',
    })
  }
  if (parsed.from === 'turbo' && !hasTurbo) {
    throw new UserError('--from turbo, but no turbo.json at the workspace root')
  }

  const format: MigrationFormat = parsed.mjs ? 'mjs' : 'ts'
  let source: string
  let plan: MigrationPlan
  if (parsed.from === 'nx' || (parsed.from === undefined && !hasTurbo)) {
    if (hasGraph) {
      source = NX_GRAPH_REL
      plan = await migrateNx(root, metas, format)
    } else if (hasNxJson || parsed.from === 'nx') {
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
    } else {
      throw new UserError(
        'nothing to migrate: no turbo.json, Nx, moon or lage workspace, no wireit script and no root script that fans out — ' +
          'for package.json scripts, run `vx init`',
      )
    }
  } else {
    source = path.basename(turboFile ?? 'turbo.json')
    plan = await migrateTurbo(root, metas, format)
  }
  return applyMigration({
    root,
    metas,
    plan,
    source,
    verb: 'vx-migrate',
    dry: parsed.dry,
    force: parsed.force,
    format,
  })
}
