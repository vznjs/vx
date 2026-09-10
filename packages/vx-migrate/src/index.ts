// `vx-migrate [--from turbo|nx] [--dry] [--force]` — one vx.config.ts per
// workspace package from an existing Turbo or Nx setup. Source auto-detect:
// turbo.json → Turbo; .nx/workspace-data/project-graph.json → Nx (the
// resolved snapshot). The mappers return a plan; core's migration seam
// (`applyMigration`) renders, guards, writes and reports, so what this
// package writes reads exactly like what `vx init` writes.

import path from 'node:path'
import {
  applyMigration,
  findWorkspaceRoot,
  listProjectMetas,
  loadWorkspace,
  type MigrationPlan,
  UserError,
} from '@vzn/vx'
import { migrateNx } from './migrate-nx.js'
import { migrateTurbo } from './migrate-turbo.js'

export { migrateNx } from './migrate-nx.js'
export { migrateTurbo } from './migrate-turbo.js'

export interface MigrateArgs {
  dry: boolean
  force: boolean
  from?: 'turbo' | 'nx'
  error?: string
}

const USAGE = 'usage: vx-migrate [--from turbo|nx] [--dry] [--force]'

export function parseMigrateArgs(args: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { dry: false, force: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--from' || a?.startsWith('--from=')) {
      const v = a === '--from' ? args[++i] : a.slice('--from='.length)
      if (v !== 'turbo' && v !== 'nx') {
        return { ...out, error: `--from must be turbo or nx (package.json scripts: \`vx init\`)` }
      }
      out.from = v
    } else if (a === '--help' || a === '-h') return { ...out, error: USAGE }
    else if (a?.startsWith('-')) return { ...out, error: `unknown flag: ${a}\n${USAGE}` }
    else return { ...out, error: `unexpected argument: ${a}\n${USAGE}` }
  }
  return out
}

const GRAPH_REL = path.join('.nx', 'workspace-data', 'project-graph.json')

/** The command: detect the source, map it, hand the plan to core. Returns the exit code. */
export async function migrateCmd(args: readonly string[]): Promise<number> {
  const parsed = parseMigrateArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx-migrate: ${parsed.error}\n`)
    return 1
  }
  const root = await findWorkspaceRoot(process.cwd())
  const metas = await listProjectMetas(await loadWorkspace(root))

  const hasTurbo = await Bun.file(path.join(root, 'turbo.json')).exists()
  const hasGraph = await Bun.file(path.join(root, GRAPH_REL)).exists()
  const hasNxJson = await Bun.file(path.join(root, 'nx.json')).exists()

  // Evaluating teams routinely have both runners checked in — never
  // ask anyone to delete anything; --from disambiguates.
  if (parsed.from === undefined && hasTurbo && (hasGraph || hasNxJson)) {
    throw new UserError(
      'both turbo.json and an nx workspace are present — pass --from turbo or --from nx',
    )
  }
  if (parsed.from === 'turbo' && !hasTurbo) {
    throw new UserError('--from turbo, but no turbo.json at the workspace root')
  }

  let source: string
  let plan: MigrationPlan
  if (parsed.from === 'nx' || (parsed.from === undefined && !hasTurbo)) {
    if (hasGraph) {
      source = '.nx/workspace-data/project-graph.json'
      plan = await migrateNx(root, metas)
    } else if (hasNxJson || parsed.from === 'nx') {
      // Modern Nx stores the graph in SQLite — the JSON snapshot only
      // exists when exported explicitly.
      throw new UserError(
        'no resolved Nx graph found — export one with ' +
          '`nx graph --file=.nx/workspace-data/project-graph.json`, then re-run vx-migrate',
      )
    } else {
      throw new UserError(
        'nothing to migrate: no turbo.json and no Nx workspace at the workspace root — ' +
          'for package.json scripts, run `vx init`',
      )
    }
  } else {
    source = 'turbo.json'
    plan = await migrateTurbo(root, metas)
  }
  return applyMigration({
    root,
    metas,
    plan,
    source,
    verb: 'vx-migrate',
    dry: parsed.dry,
    force: parsed.force,
  })
}
