// An atomized target's per-spec tasks keep their cache over the target
// they split: cypress gives `e2e` the whole `videos` dir and each
// `e2e-ci--<spec>` a subdir, and the first-declared `e2e` kept the cache
// while every spec's CI task ran uncached (nx-examples).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-atomized-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function cachedTasks(targets: Record<string, unknown>): Promise<string[]> {
  const dir = path.join(root, 'apps', 'e2e')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"e2e"}')
  const meta: ProjectMeta = {
    name: 'e2e',
    dir,
    packageJson: { name: 'e2e' } as never,
    configPath: null,
  }
  const graph = { nodes: { e2e: { data: { root: 'apps/e2e', targets } } }, dependencies: {} }
  const m = await mapNxWorkspace(root, [meta], graph as NxGraph, {
    cacheable: new Set(),
  })
  return m.projects[0]!.tasks.filter((t) => t.task?.['cache'] !== undefined).map((t) => t.name)
}

const spec = (outputs: string[]) => ({
  command: 'cypress run',
  cache: true,
  outputs,
  metadata: { nonAtomizedTarget: 'e2e' },
})

it('cypress: each spec keeps its own subdir cached; the split e2e yields', async () => {
  const dir = '{workspaceRoot}/dist/cypress/videos'
  expect(
    await cachedTasks({
      e2e: { command: 'cypress run', cache: true, outputs: [dir] },
      'e2e-ci--a.cy.ts': spec([`${dir}/a`]),
      'e2e-ci--b.cy.ts': spec([`${dir}/b`]),
    }),
  ).toEqual(['e2e-ci--a.cy.ts', 'e2e-ci--b.cy.ts'])
})

it('jest: specs on the split target’s one path change nothing, so it keeps the cache', async () => {
  const dir = '{workspaceRoot}/coverage/e2e'
  expect(
    await cachedTasks({
      e2e: { command: 'jest', cache: true, outputs: [dir] },
      'e2e-ci--a.spec.ts': spec([dir]),
      'e2e-ci--b.spec.ts': spec([dir]),
    }),
  ).toEqual(['e2e'])
})
