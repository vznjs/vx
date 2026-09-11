// `vx init [--dry] [--force] [--mjs]` — a workspace from nowhere: one vx.config.ts
// per package from its package.json scripts, and the workspace file every
// run needs. Turbo and Nx are not read here; a runner's own config beside
// the scripts is the richer source, and `@vzn/vx-migrate` maps it.

import path from 'node:path'
import { seeHelp } from './help.js'
import {
  applyMigration,
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  migrateScripts,
} from '../workspace/index.js'

export interface InitArgs {
  dry: boolean
  force: boolean
  /** `vx.config.mjs` instead of `.ts` — see `ApplyMigrationArgs.format`. */
  mjs: boolean
  error?: string
}

export function parseInitArgs(args: readonly string[]): InitArgs {
  const out: InitArgs = { dry: false, force: false, mjs: false }
  for (const a of args) {
    if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--mjs') out.mjs = true
    else if (a.startsWith('-')) return { ...out, error: `unknown flag: ${a}${seeHelp('init')}` }
    else return { ...out, error: `unexpected argument: ${a}` }
  }
  return out
}

export async function initCmd(args: readonly string[]): Promise<number> {
  const parsed = parseInitArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx init: ${parsed.error}\n`)
    return 1
  }
  const root = await findWorkspaceRoot(process.cwd())
  const metas = await listProjects(await loadWorkspace(root))
  // `init` reads scripts only; a runner's own config beside them is the
  // richer source (dependsOn, inputs, outputs) and was ignored without a
  // word — the walkthrough on a Turbo repo (2026-09-09) got the scripts'
  // TODOs and none of the edges turbo.json already declared.
  const notes: string[] = []
  if (await Bun.file(path.join(root, 'turbo.json')).exists()) {
    notes.push(
      'turbo.json found and not read — `bunx @vzn/vx-migrate` maps it (dependsOn, inputs, ' +
        'outputs), or `plugins: [turbo()]` from @vzn/vx-migrate runs it with nothing written',
    )
  } else if (
    (await Bun.file(path.join(root, 'nx.json')).exists()) ||
    (await Bun.file(path.join(root, '.nx', 'workspace-data', 'project-graph.json')).exists())
  ) {
    notes.push(
      'an Nx workspace found and not read — `bunx @vzn/vx-migrate --from nx` maps its ' +
        'exported project graph',
    )
  }
  return applyMigration({
    root,
    metas,
    plan: migrateScripts(metas),
    source: 'package.json scripts',
    verb: 'vx init',
    dry: parsed.dry,
    force: parsed.force,
    init: true,
    notes,
    format: parsed.mjs ? 'mjs' : 'ts',
  })
}
