// Nx draws no edge from a task to itself (`processTasksForSingleProject`
// skips `task.id === selfTaskId`), so `projects: "*"` on `lint` means
// every OTHER project's lint. vx kept `a#lint -> a#lint`, and `vx lock`
// refused the whole workspace as a cycle.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-self-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function meta(name: string): Promise<PackageMeta> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  return { name, dir, packageJson: { name } as never, configPath: null }
}

it('a dependsOn that matches the task itself draws no self edge', async () => {
  const metas = [await meta('a'), await meta('b')]
  const node = (rel: string, targets: Record<string, unknown>, tags: string[] = []) => ({
    data: { root: rel, targets, tags },
  })
  const m = await mapNxWorkspace(
    root,
    metas,
    {
      nodes: {
        a: node(
          'packages/a',
          {
            lint: { command: 'x', dependsOn: [{ projects: '*', target: 'lint' }] },
            test: {
              command: 't',
              dependsOn: ['test', 'a:test', { projects: 'tag:ui', target: 'test' }],
            },
          },
          ['ui'],
        ),
        b: node('packages/b', { lint: { command: 'y' }, test: { command: 'u' } }, ['ui']),
      },
      dependencies: {},
    } as NxGraph,
    { cacheable: new Set<string>() },
  )
  const a = m.projects.find((p) => p.name === 'a')!.tasks
  const deps = (name: string) => a.find((t) => t.name === name)!.task!['dependsOn']
  expect([deps('lint'), deps('test')]).toEqual([['b#lint'], ['b#test']])
})
