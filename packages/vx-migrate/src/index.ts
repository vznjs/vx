// `vx-migrate [--from turbo|nx] [--dry] [--force] [--mjs]` — one
// vx.config.ts per workspace package from an existing Turbo or Nx
// setup. Source auto-detect: turbo.json → Turbo;
// .nx/workspace-data/project-graph.json or nx.json → Nx (the resolved graph, exported by nx if absent);
// The mappers return a plan; core's migration seam
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
import { migrateNx, NX_GRAPH_REL } from './migrate-nx.js'
import { exportGraph } from './nx/export-graph.js'
import { migrateTurbo } from './migrate-turbo.js'
import { turboConfigFile } from './turbo/turbo-map.js'

// The plugins: the Turbo and Nx project stages (a repo runs
// unchanged), and the two remote caches speaking Turbo's and Nx's wire.
export * from './turbo/index.js'
export * from './nx/index.js'
export * from './turbo-cache/index.js'
export * from './nx-cache/index.js'

export interface MigrateArgs {
  dry: boolean
  force: boolean
  /** `vx.config.mjs` (and `vx-preset.mjs`) instead of `.ts`. */
  mjs: boolean
  from?: 'turbo' | 'nx'
  /** `--help` / `-h`: the usage on stdout, exit 0 (as `nx-env --help`). */
  help?: boolean
  error?: string
}

const USAGE = 'usage: vx-migrate [--from turbo|nx] [--dry] [--force] [--mjs]'

export function parseMigrateArgs(args: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { dry: false, force: false, mjs: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--mjs') out.mjs = true
    else if (a === '--from' || a?.startsWith('--from=')) {
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
        'nothing to migrate: no turbo.json and no Nx workspace — ' +
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
