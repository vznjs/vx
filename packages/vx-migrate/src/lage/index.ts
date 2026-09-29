// `lage()` — a lage workspace under vx with nothing written. Fills the
// `project` stage from `lage.config.js` and each package's scripts,
// through the mapper `bunx @vzn/vx-migrate --from lage` renders files
// from. A task the package's own vx.config declares wins.

import type { ProjectMeta, VxPlugin } from '@vzn/vx'
import { type AdoptionRun, adoptionPlugin } from '../adoption-plugin.js'
import type { AdoptionMapping } from '../mapping-cache.js'
import { collectGaps } from '../plugin-gaps.js'
import {
  type LageMappedProject,
  lageConfigFile,
  loadLageConfig,
  mapLageWorkspace,
  rootPackageName,
} from './lage-map.js'

/** The plugin: the adoption skeleton over `mapLageWorkspace`, one mapping per run. */
export function lage(): VxPlugin {
  return adoptionPlugin(import.meta, (ctx) => run(ctx.workspaceRoot, ctx.projects), [
    'lage.config.js',
    'lage.config.cjs',
    'lage.config.mjs',
  ])
}

/**
 * The key is the EVALUATED config (functions as markers), not its file:
 * the file may require others, and their edits must remap.
 */
async function run(root: string, metas: readonly ProjectMeta[]): Promise<AdoptionRun> {
  const file = await lageConfigFile(root)
  const config = file === null ? {} : await loadLageConfig(root, file)
  const rootName = await rootPackageName(root)
  return {
    name: 'lage',
    spareTracked: true,
    reads: [
      root,
      String(rootName),
      JSON.stringify(config),
      JSON.stringify(metas.map((m) => [m.name, m.dir, m.packageJson])),
    ],
    map: async () => mapAll(root, metas, config, rootName),
  }
}

function mapAll(
  root: string,
  metas: readonly ProjectMeta[],
  config: Record<string, unknown>,
  rootName: string | undefined,
): AdoptionMapping {
  const mapped = mapLageWorkspace(root, metas, config, rootName)
  const byName = new Map<string, LageMappedProject>()
  for (const project of mapped.projects) byName.set(project.name, project)
  return { byName, gaps: collectGaps(mapped.projects, mapped.notes) }
}

export {
  mapLageWorkspace,
  type LageMappedProject,
  type LageMappedTask,
  type LageMapping,
} from './lage-map.js'
