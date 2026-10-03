// openstatus's root `build` env lists `\*`, which Turbo reads as the one
// variable `*` and core cannot key. The gap is the entry's, not a
// task's: it wrote the same TODO into 45 configs. Reported once.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

it('a literal env name vx cannot key is one note with its task count, no task todo', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-envlit-'))
  try {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { env: ['\\*', 'API'] }, test: { env: ['API'] } } }),
    )
    const metas: ProjectMeta[] = []
    for (const name of ['a', 'b', 'c']) {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      const scripts = { build: 'b', test: 't' }
      metas.push({ name, dir, packageJson: { name, scripts } as never, configPath: null })
    }
    const m = await mapTurboWorkspace(root, metas, { splice: (_k, v) => v, persistentTodo: 'P' })
    expect({
      todos: m.projects.flatMap((p) => p.tasks.flatMap((t) => t.todos)),
      notes: m.notes,
    }).toEqual({
      todos: [],
      notes: [
        'env "\\\\*": Turbo reads this as the one variable "*" (only `*` is a wildcard), a name vx cannot key — dropped (3 tasks)',
      ],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
