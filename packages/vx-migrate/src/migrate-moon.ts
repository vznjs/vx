// `bunx @vzn/vx-migrate --from moon`: `.moon/` and each `moon.yml`, through
// the mapper `moon()` runs live, as a migration plan.

import { type MigrationPlan, PERSISTENT_TODO, type ProjectMeta } from '@vzn/vx'
import { mapMoonWorkspace } from './moon/moon-map.js'

export async function migrateMoon(
  root: string,
  metas: readonly ProjectMeta[],
): Promise<MigrationPlan> {
  const mapped = await mapMoonWorkspace(root, metas, { persistentTodo: PERSISTENT_TODO })
  return {
    headerNotes: [],
    projects: mapped.projects.map((p) => ({ ...p, importLines: [] })),
    extraFiles: [],
    notes: mapped.notes,
  }
}
