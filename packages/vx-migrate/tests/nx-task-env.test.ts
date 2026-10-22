// What Nx hands every task (`getNxEnvVariablesForTask`): the target's
// project, name and configuration, and `LERNA_PACKAGE_NAME`, which Lerna
// (on Nx's runner) documents to scripts and vx left unset. Only a command
// that still runs Nx or Lerna gets them: a native task names no other runner.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-task-env-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a task still running Nx gets the target Nx names, a configuration task its configuration too; a plain one none', async () => {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"@acme/a"}')
  const meta: PackageMeta = {
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
        targets: {
          gen: { command: 'nx exec -- gen', configurations: { ci: {} } },
          plain: { command: 'tsc' },
        },
      },
    },
  }
  const m = await mapNxWorkspace(root, [meta], { nodes, dependencies: {} } as NxGraph, {
    cacheable: new Set(),
  })
  const define = (name: string) =>
    (
      m.projects[0]!.tasks.find((t) => t.name === name)!.task!['exec'] as {
        env?: { define: Record<string, string> }
      }
    ).env?.define
  expect([define('gen'), define('gen:ci'), define('plain')]).toEqual([
    { NX_TASK_TARGET_PROJECT: 'a', NX_TASK_TARGET_TARGET: 'gen', LERNA_PACKAGE_NAME: 'a' },
    {
      NX_TASK_TARGET_PROJECT: 'a',
      NX_TASK_TARGET_TARGET: 'gen',
      LERNA_PACKAGE_NAME: 'a',
      NX_TASK_TARGET_CONFIGURATION: 'ci',
    },
    undefined,
  ])
})

// Nx tags every package.json project `npm:public` or `npm:private`; written
// into a native config, it was a tag no user set.
it("keeps a project's own tags and drops Nx's npm:public / npm:private", async () => {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"a"}')
  const meta: PackageMeta = {
    name: 'a',
    dir,
    packageJson: { name: 'a' } as never,
    configPath: null,
  }
  const tagsOf = async (tags: string[]) => {
    const nodes = {
      a: { name: 'a', data: { root: 'packages/a', tags, targets: { b: { command: 'tsc' } } } },
    }
    const m = await mapNxWorkspace(root, [meta], { nodes, dependencies: {} } as NxGraph, {
      cacheable: new Set(),
    })
    return m.projects[0]!.tags
  }
  expect([await tagsOf(['npm:public', 'scope:ui']), await tagsOf(['npm:private'])]).toEqual([
    ['scope:ui'],
    undefined,
  ])
})
