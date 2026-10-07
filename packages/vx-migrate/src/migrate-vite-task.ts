// `bunx @vzn/vx-migrate --from vite-task`: each package's `vite.config`
// `run` block (vite-plus's `vp run`) and its package.json scripts, as a
// migration plan.

import { type MigrationFormat, type MigrationPlan, type ProjectMeta } from '@vzn/vx'
import { spareTrackedOutputs, trackedFiles, trackedKinds } from './tracked-outputs.js'
import { mapViteTaskWorkspace, viteTaskProjects } from './vite-task/vite-task-map.js'

export async function migrateViteTask(
  root: string,
  metas: readonly ProjectMeta[],
  format: MigrationFormat = 'ts',
): Promise<MigrationPlan> {
  const withRoot = await viteTaskProjects(root, metas)
  const tracked = await trackedFiles(root)
  const mapped = await mapViteTaskWorkspace(root, withRoot.metas, {
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    ownConfig: () => `vx.config.${format}`,
  })
  // A committed file under an output is taken back, or the first run's
  // clean deletes it (Vite Task never cleans).
  if (tracked !== null)
    for (const [id, todo] of spareTrackedOutputs(root, mapped.projects, tracked)) {
      const at = id.lastIndexOf('#')
      const p = mapped.projects.find((x) => x.name === id.slice(0, at))
      p?.tasks.find((t) => t.name === id.slice(at + 1))?.todos.push(todo)
    }
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
