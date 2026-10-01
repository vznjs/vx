// `bunx @vzn/vx-migrate --from nx`: the resolved graph snapshot on disk,
// through the mapper the `nx()` plugin runs live, as a migration plan.

import path from 'node:path'
import {
  type MigrationFormat,
  type MigrationPlan,
  PERSISTENT_TODO,
  type ProjectMeta,
} from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from './nx/nx-map.js'
import { trackedFiles, trackedKinds } from './tracked-outputs.js'

export const NX_GRAPH_REL = '.nx/workspace-data/project-graph.json'

/** `snapshot`: the graph file to read, absolute; the checked-in one by default. */
export async function migrateNx(
  root: string,
  metas: readonly ProjectMeta[],
  format: MigrationFormat = 'ts',
  snapshot = path.join(root, NX_GRAPH_REL),
): Promise<MigrationPlan> {
  const graph = parseNxGraph(await Bun.file(snapshot).text(), path.relative(root, snapshot))
  const tracked = await trackedFiles(root)
  const mapped = await mapNxWorkspace(root, metas, graph, {
    persistentTodo: PERSISTENT_TODO,
    cacheable: new Set(),
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    // The file this writes is each task's config.
    ownConfig: () => `vx.config.${format}`,
  })
  return {
    headerNotes: [
      'migrating from the resolved project-graph snapshot — plugin-inferred targets ' +
        'are frozen as static config; executor targets run through `nx-exec` and ' +
        'targets with `.env` files through `nx-env` (keep @vzn/vx-migrate and nx installed)',
    ],
    projects: mapped.projects,
    extraFiles: [],
    notes: mapped.notes,
  }
}
