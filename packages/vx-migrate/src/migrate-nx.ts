// `bunx @vzn/vx-migrate --from nx`: the resolved graph snapshot on disk,
// through the mapper the `nx()` plugin runs live, as a migration plan.

import path from 'node:path'
import { type MigrationPlan, PERSISTENT_TODO, type ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from './nx/nx-map.js'

export const NX_GRAPH_REL = '.nx/workspace-data/project-graph.json'

export async function migrateNx(
  root: string,
  metas: readonly ProjectMeta[],
): Promise<MigrationPlan> {
  const graph = parseNxGraph(await Bun.file(path.join(root, NX_GRAPH_REL)).text(), NX_GRAPH_REL)
  const mapped = await mapNxWorkspace(root, metas, graph, {
    persistentTodo: PERSISTENT_TODO,
    cacheable: new Set(),
  })
  return {
    headerNotes: [
      'migrating from the resolved project-graph snapshot — plugin-inferred targets ' +
        'are frozen as static config; executor targets run through `nx-exec` (keep ' +
        '@vzn/vx-migrate and nx installed)',
    ],
    projects: mapped.projects,
    extraFiles: [],
    notes: mapped.notes,
  }
}
