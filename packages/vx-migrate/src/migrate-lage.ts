// `bunx @vzn/vx-migrate --from lage`: the evaluated `lage.config.js`,
// through the mapper `lage()` runs live, as a migration plan.

import type { MigrationPlan, ProjectMeta } from '@vzn/vx'
import { loadLageConfig, mapLageWorkspace, rootPackageName } from './lage/lage-map.js'

export async function migrateLage(
  root: string,
  metas: readonly ProjectMeta[],
  file: string,
): Promise<MigrationPlan> {
  const mapped = mapLageWorkspace(
    root,
    metas,
    await loadLageConfig(root, file),
    await rootPackageName(root),
  )
  return {
    headerNotes: [],
    projects: mapped.projects.map((p) => ({ ...p, importLines: [] })),
    extraFiles: [],
    notes: mapped.notes,
  }
}
