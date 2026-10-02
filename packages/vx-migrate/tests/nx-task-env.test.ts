// What Nx hands every task (`getNxEnvVariablesForTask`): the target's
// project, name and configuration, and `LERNA_PACKAGE_NAME`, which Lerna
// (on Nx's runner) documents to scripts and vx left unset.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-task-env-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('every task gets the target Nx names, a configuration task its configuration too', async () => {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"@acme/a"}')
  const meta: ProjectMeta = {
    name: '@acme/a',
    dir,
    packageJson: { name: '@acme/a' } as never,
    configPath: null,
  }
  const nodes = {
    a: {
      name: 'a',
      data: {
        root: 'packages/a',
        targets: { gen: { command: 'gen', configurations: { ci: {} } } },
      },
    },
  }
  const m = await mapNxWorkspace(root, [meta], { nodes, dependencies: {} } as NxGraph, {
    persistentTodo: 'PERSIST',
    cacheable: new Set(),
  })
  const define = (name: string) =>
    (
      m.projects[0]!.tasks.find((t) => t.name === name)!.task!['exec'] as {
        env: { define: Record<string, string> }
      }
    ).env.define
  expect([define('gen'), define('gen:ci')]).toEqual([
    { NX_TASK_TARGET_PROJECT: 'a', NX_TASK_TARGET_TARGET: 'gen', LERNA_PACKAGE_NAME: 'a' },
    {
      NX_TASK_TARGET_PROJECT: 'a',
      NX_TASK_TARGET_TARGET: 'gen',
      LERNA_PACKAGE_NAME: 'a',
      NX_TASK_TARGET_CONFIGURATION: 'ci',
    },
  ])
})
