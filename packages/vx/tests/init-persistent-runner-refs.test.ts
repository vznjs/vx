// A script that runs servers through a runner is persistent too:
// `concurrently "npm:web" "npm:api"` and `run-p web api` mapped as one-shot
// tasks, so a dependent waited on a task that never ends.
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

it('follows a runner to the servers it starts', () => {
  const scripts: Record<string, string> = {
    web: 'vite',
    api: 'nodemon server.js',
    both: 'concurrently "npm:web" "npm:api"',
    para: 'run-p web api',
    globbed: 'npm-run-all --parallel w*',
    // CONTROLS: a runner over one-shot scripts.
    lib: 'tsc',
    checks: 'run-s lib',
  }
  const tasks = migrateScripts([
    { name: 'a', dir: '/w/a', packageJson: { name: 'a', scripts } as never, configPath: null },
  ]).projects[0]!.tasks
  expect(
    Object.fromEntries(
      tasks.map((t) => [
        t.name,
        (t.task?.['exec'] as { persistent?: unknown } | undefined)?.persistent !== undefined,
      ]),
    ),
  ).toEqual({
    web: true,
    api: true,
    both: true,
    para: true,
    globbed: true,
    lib: false,
    checks: false,
  })
})
