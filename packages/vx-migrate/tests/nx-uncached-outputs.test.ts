// What a target writes only matters to a task vx caches. Nx's default
// `build` outputs note (`{root}/build` and `{root}/public`) sat on every
// uncached `build` that declares no outputs. CONTROL: a cached one keeps it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-uncached-outputs-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('an uncached target carries no output todo; a cached one does', async () => {
  const todos: Record<string, string[]> = {}
  for (const cache of [false, true]) {
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), '{"name":"a"}')
    const meta: ProjectMeta = {
      name: 'a',
      dir,
      packageJson: { name: 'a' } as never,
      configPath: null,
    }
    const nodes = {
      a: {
        name: 'a',
        data: {
          root: 'packages/a',
          targets: { build: { command: 'b', cache, options: { outputPath: 7 } } },
        },
      },
    }
    const m = await mapNxWorkspace(root, [meta], { nodes, dependencies: {} } as NxGraph, {
      persistentTodo: 'PERSIST',
      cacheable: new Set(),
    })
    todos[String(cache)] = m.projects[0]!.tasks.find((t) => t.name === 'build')!.todos
  }
  expect(todos).toEqual({
    false: [],
    true: [
      'no outputs declared: Nx also caches packages/a/build and packages/a/public for this target — vx cleans an output before the run, so add them to the outputs by hand only if they hold nothing committed',
    ],
  })
})
