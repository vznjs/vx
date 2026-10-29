// A same-project edge to a target the mapper writes no task for (an
// `nx:noop` with nothing to chain) was kept: only `pkg#task` edges were
// checked, so `vx lock` refused "dependsOn a#prep but no such task is
// declared". Nx runs the noop as nothing, so the edge goes.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-skipped-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('an edge to a same-project target written as no task is dropped', async () => {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"a"}')
  const meta: PackageMeta = {
    name: 'a',
    dir,
    packageJson: { name: 'a' } as never,
    configPath: null,
  }
  const m = await mapNxWorkspace(
    root,
    [meta],
    {
      nodes: {
        a: {
          data: {
            root: 'packages/a',
            targets: {
              prep: { executor: 'nx:noop', dependsOn: ['codegen'] },
              lint: { command: 'l' },
              deploy: { command: 'echo hi', dependsOn: ['prep', 'lint'] },
            },
          },
        },
      },
      dependencies: {},
    } as NxGraph,
    { cacheable: new Set<string>() },
  )
  const tasks = m.projects[0]!.tasks
  const deploy = tasks.find((t) => t.name === 'deploy')!
  expect([tasks.find((t) => t.name === 'prep')!.task, deploy.task!['dependsOn']]).toEqual([
    null,
    ['lint'],
  ])
})
