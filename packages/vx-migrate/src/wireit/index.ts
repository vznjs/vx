// `wireit()` — a wireit workspace under vx with nothing written. Fills the
// `project` stage from each package.json's `wireit` block, through the
// mapper `bunx @vzn/vx-migrate --from wireit` renders files from. A task
// the package's own vx.config declares wins; the plugin never overwrites it.

import path from 'node:path'
import type { ProjectMeta, VxPlugin } from '@vzn/vx'
import { type AdoptionRun, adoptionPlugin } from '../adoption-plugin.js'
import type { AdoptionMapping } from '../mapping-cache.js'
import { collectGaps } from '../plugin-gaps.js'
import { mapWireitWorkspace, type WireitMappedProject } from './wireit-map.js'

const PERSISTENT_NOTE =
  'a wireit service with no readyWhen — vx runs it as a persistent task that is ready on spawn; ' +
  'add `exec.persistent.readyWhen` in a vx.config to gate dependents on its output'

/** The plugin: the adoption skeleton over `mapWireitWorkspace`, one mapping per run. */
export function wireit(): VxPlugin {
  return adoptionPlugin(import.meta, (ctx) => run(ctx.workspaceRoot, ctx.projects))
}

/** The root manifest (its wireit block is reported) and every package manifest. */
async function run(root: string, metas: readonly ProjectMeta[]): Promise<AdoptionRun> {
  const rootManifest = await Bun.file(path.join(root, 'package.json'))
    .text()
    .catch(() => '\0absent')
  return {
    name: 'wireit',
    reads: [root, rootManifest, JSON.stringify(metas.map((m) => [m.name, m.dir, m.packageJson]))],
    map: () => mapAll(root, metas),
  }
}

async function mapAll(root: string, metas: readonly ProjectMeta[]): Promise<AdoptionMapping> {
  const mapped = await mapWireitWorkspace(root, metas, { persistentTodo: PERSISTENT_NOTE })
  const byName = new Map<string, WireitMappedProject>()
  for (const project of mapped.projects) byName.set(project.name, project)
  return { byName, gaps: collectGaps(mapped.projects, mapped.notes) }
}

export {
  mapWireitWorkspace,
  type MapWireitOptions,
  type WireitMappedProject,
  type WireitMappedTask,
  type WireitMapping,
} from './wireit-map.js'
