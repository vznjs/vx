// `workspaceScripts()` — a workspace with no orchestrator under vx with
// nothing written: the root package.json's fan-out scripts (`pnpm -r run
// build`, `npm run test --workspaces`, …) as tasks in the packages they
// select, through the mapper `bunx @vzn/vx-migrate --from scripts` renders
// files from. A task the package's own vx.config declares wins.

import path from 'node:path'
import type { ProjectMeta, VxPlugin } from '@vzn/vx'
import { type AdoptionRun, adoptionPlugin } from '../adoption-plugin.js'
import type { AdoptionMapping } from '../mapping-cache.js'
import { collectGaps } from '../plugin-gaps.js'
import { mapScriptsWorkspace, type ScriptsMappedProject } from './scripts-map.js'

const PERSISTENT_NOTE =
  'a long-running script — vx runs it as a persistent task that is ready on spawn; ' +
  'add `exec.persistent.readyWhen` in a vx.config to gate dependents on its output'

/** The plugin: the adoption skeleton over `mapScriptsWorkspace`, one mapping per run. */
export function workspaceScripts(): VxPlugin {
  return adoptionPlugin(import.meta, (ctx) => run(ctx.workspaceRoot, ctx.projects), [
    'package.json',
  ])
}

/** The root manifest's scripts, `{}` when it has none. */
export async function rootScripts(root: string): Promise<Record<string, unknown>> {
  const pj = (await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => ({}))) as { scripts?: unknown }
  const s = pj.scripts
  return typeof s === 'object' && s !== null && !Array.isArray(s)
    ? (s as Record<string, unknown>)
    : {}
}

async function run(root: string, metas: readonly ProjectMeta[]): Promise<AdoptionRun> {
  const scripts = await rootScripts(root)
  return {
    name: 'scripts',
    reads: [
      root,
      JSON.stringify(scripts),
      JSON.stringify(metas.map((m) => [m.name, m.dir, m.packageJson])),
    ],
    map: async () => mapAll(root, scripts, metas),
  }
}

function mapAll(
  root: string,
  scripts: Record<string, unknown>,
  metas: readonly ProjectMeta[],
): AdoptionMapping {
  const mapped = mapScriptsWorkspace(root, scripts, metas, { persistentTodo: PERSISTENT_NOTE })
  const byName = new Map<string, ScriptsMappedProject>()
  for (const project of mapped.projects) byName.set(project.name, project)
  return { byName, gaps: collectGaps(mapped.projects, mapped.notes) }
}

export {
  mapScriptsWorkspace,
  type ScriptsMappedProject,
  type ScriptsMappedTask,
  type ScriptsMapping,
} from './scripts-map.js'
