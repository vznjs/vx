// `bunx @vzn/vx-migrate --from vite-task`: each package's `vite.config`
// `run` block (vite-plus's `vp run`) and its package.json scripts, as a
// migration plan.

import { type MigrationFormat, type MigrationPlan } from '@vzn/vx'
import type { PackageMeta } from './packages.js'
import { spareTrackedTodos, trackedFiles, trackedKinds } from './tracked-outputs.js'
import { mapViteTaskWorkspace, viteTaskProjects } from './vite-task/vite-task-map.js'

export async function migrateViteTask(
  root: string,
  metas: readonly PackageMeta[],
  format: MigrationFormat = 'ts',
): Promise<MigrationPlan> {
  const withRoot = await viteTaskProjects(root, metas)
  const tracked = await trackedFiles(root)
  const mapped = await mapViteTaskWorkspace(root, withRoot.metas, {
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    ownConfig: () => `vx.config.${format}`,
  })
  // A reader whose `!` hides a committed file under another task's output
  // runs uncached.
  spareTrackedTodos(root, mapped.projects, tracked)
  return {
    headerNotes: [
      'each `run.tasks` entry and package.json script became a task; a task whose files ' +
        'Vite Task traced (no `cache.input` / `cache.output`, or `{ auto: true }`) runs ' +
        'uncached until its TODO declares them',
    ],
    projects: mapped.projects,
    extraFiles: [],
    notes: [...withRoot.notes, ...mapped.notes],
  }
}
