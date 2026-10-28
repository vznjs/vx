// Vite Task's path globs are wax's, which refuses a `**` glued to text
// (`src/**.ts`); core refuses it too, so copied verbatim the written config
// failed the load. Such a glob takes the no-safe-form path: an input widens,
// an output runs the task uncached.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { mapViteTaskWorkspace } from '../src/vite-task/vite-task-map.js'

let root: string
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a ** glued to text widens an input and uncaches an output, with a todo', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vtg-'))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(dir, 'vite.config.ts'),
    `export default { run: { tasks: {
      build: { command: 'tsc', cache: { input: ['src/**.ts'], output: ['dist/**'] } },
      pack: { command: 'p', cache: { input: ['src/**'], output: ['out/**.js'] } },
    } } }`,
  )
  const meta = { name: 'a', dir, packageJson: { name: 'a' } as never, configPath: null }
  const m = await mapViteTaskWorkspace(root, [meta])
  const tasks = Object.fromEntries(m.projects[0]!.tasks.map((t) => [t.name, t]))
  expect({
    build: (tasks['build']!.task!['inputs'] as { files: string[] }).files,
    buildTodos: tasks['build']!.todos,
    packCache: tasks['pack']!.task!['cache'],
    packTodos: tasks['pack']!.todos,
  }).toEqual({
    build: ['**/*'],
    buildTodos: ['input "src/**.ts": glob syntax vx cannot take — widened to every package file'],
    packCache: undefined,
    packTodos: [
      'output "out/**.js": glob syntax vx cannot take — task runs uncached; declare the exact outputs in a vx.config to cache it',
    ],
  })
})
