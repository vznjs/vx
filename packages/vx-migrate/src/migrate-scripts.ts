// `bunx @vzn/vx-migrate --from scripts`: the root package.json's fan-out
// scripts, through the mapper `workspaceScripts()` runs live, as a plan.

import { type MigrationPlan, PERSISTENT_TODO, type ProjectMeta } from '@vzn/vx'
import { rootScripts } from './scripts/index.js'
import { mapScriptsWorkspace } from './scripts/scripts-map.js'

export async function migrateScripts(
  root: string,
  metas: readonly ProjectMeta[],
): Promise<MigrationPlan> {
  const mapped = mapScriptsWorkspace(root, await rootScripts(root), metas, {
    persistentTodo: PERSISTENT_TODO,
  })
  return {
    headerNotes: [],
    projects: mapped.projects.map((p) => ({ ...p, importLines: [] })),
    extraFiles: [],
    notes: mapped.notes,
  }
}
