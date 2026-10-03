// The shipped planner reads `Bun` and `process` through globals the bundle
// publishes at load. Importing the shim's SOURCE later (playground-shim's
// rows do) once repointed them at the source shim's VFS, and every
// playground-page row after it failed with "workspace root /toy has
// neither pnpm-workspace.yaml nor package.json" — on macOS, whose file
// order runs bundle, shim, page.
import { expect, it } from 'bun:test'
import path from 'node:path'
import { PLANNER_FILE } from '../scripts/build-playground.js'
import { PLAYGROUND_ROOT, type Planner } from '../src/components/demos/model/playground-view.js'
import { CONFIG_TEXTS, ENV, FILES, TASKS } from '../src/playground/workspace.js'

it('a loaded bundle still plans after the shim source is imported', async () => {
  const planner = (await import(path.resolve(import.meta.dir, '../dist', PLANNER_FILE))) as Planner
  await import('../src/playground/shim/platform.js')
  const configs: Record<string, unknown> = {}
  for (const [name, t] of Object.entries(CONFIG_TEXTS)) {
    configs[name] = ((await planner.evaluateConfig(t, 10_000)) as { config: unknown }).config
  }
  const plan = await planner.planPlayground({
    root: PLAYGROUND_ROOT,
    files: FILES,
    configs,
    env: ENV,
    tasks: TASKS,
  })
  expect(plan.tasks.map((t) => t.id).sort()).toEqual(
    ['api', 'app', 'ui', 'utils'].flatMap((p) => [`${p}#build`, `${p}#test`]),
  )
})
