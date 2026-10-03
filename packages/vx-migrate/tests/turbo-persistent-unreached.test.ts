// create-t3-turbo: the root `dev` depends on `^dev` and each app's own
// turbo.json `extends` it to persistent. Nothing depends on an app, yet
// each app's `dev` carried the note asking for `readyWhen` so dependents
// unblock: core's prune matched the `^dev` by name alone.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

it("drops a persistent task's readiness note when no edge reaches it, keeps it when one does", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-persist-'))
  try {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { dev: { dependsOn: ['^dev'], cache: false, persistent: false } } }),
    )
    const pkg = async (
      rel: string,
      name: string,
      deps: Record<string, string>,
      persistent: boolean,
    ) => {
      const dir = path.join(root, rel)
      await mkdir(dir, { recursive: true })
      if (persistent)
        await writeFile(
          path.join(dir, 'turbo.json'),
          JSON.stringify({ extends: ['//'], tasks: { dev: { persistent: true } } }),
        )
      const packageJson = { name, scripts: { dev: 'run-dev' }, dependencies: deps }
      return { name, dir, packageJson: packageJson as never, configPath: null } as ProjectMeta
    }
    const metas = [
      await pkg('apps/nextjs', '@acme/nextjs', { '@acme/ui': 'workspace:*' }, true),
      await pkg('packages/ui', '@acme/ui', { '@acme/api': 'workspace:*' }, true),
      await pkg('packages/api', '@acme/api', {}, false),
    ]
    const m = await mapTurboWorkspace(root, metas, {
      splice: (_k, v) => v,
      persistentTodo: 'READY',
    })
    const todos = Object.fromEntries(m.projects.map((p) => [p.name, p.tasks[0]!.todos]))
    expect(todos).toEqual({ '@acme/nextjs': [], '@acme/ui': ['READY'], '@acme/api': [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
