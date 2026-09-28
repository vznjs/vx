// `bunx @vzn/vx-migrate --from wireit`: each package.json's `wireit` block,
// through the mapper `wireit()` runs live, as a migration plan.

import { type MigrationPlan, PERSISTENT_TODO, type ProjectMeta } from '@vzn/vx'
import { mapWireitWorkspace } from './wireit/wireit-map.js'

export async function migrateWireit(
  root: string,
  metas: readonly ProjectMeta[],
): Promise<MigrationPlan> {
  const mapped = await mapWireitWorkspace(root, metas, { persistentTodo: PERSISTENT_TODO })
  return {
    headerNotes: [],
    projects: mapped.projects.map((p) => ({ ...p, importLines: [] })),
    extraFiles: [],
    notes: mapped.notes,
  }
}
