// nx() is the edge source of an Nx repo: Nx's graph (package deps,
// `implicitDependencies`, imports) orders `^build`. With no lockfile
// plugin, an integrated repo's `^build` was refused for want of edges.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '@vzn/vx'
import { planRun } from '@vzn/vx/testing'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-graph-edges-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const silent = (): Logger => new Proxy({}, { get: () => () => {} }) as Logger
// The exported graph carries nx.json's targetDefaults resolved.
const build = {
  executor: 'nx:run-commands',
  options: { command: 'true' },
  dependsOn: ['^build'],
}

it('orders ^build by the Nx graph, with no lockfile plugin', async () => {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  for (const d of ['libs/util', 'apps/cli']) await mkdir(path.join(root, d), { recursive: true })
  const nodes = {
    util: { name: 'util', data: { root: 'libs/util', targets: { build } } },
    cli: { name: 'cli', data: { root: 'apps/cli', targets: { build } } },
  }
  const dependencies = {
    util: [{ source: 'util', target: 'npm:typescript', type: 'static' }],
    cli: [{ source: 'cli', target: 'util', type: 'implicit' }],
  }
  await writeFile(path.join(root, 'graph.json'), JSON.stringify({ graph: { nodes, dependencies } }))
  const index = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { nx } from ${JSON.stringify(index)}\nexport default { plugins: [nx({ graph: 'graph.json' })] }\n`,
  )
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
  const deps = Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.node.deps]))
  expect(deps).toEqual({ 'util#build': [], 'cli#build': ['util#build'] })
}, 30_000)

// One-to-one: `^build` and `^test` are each direct dependency's own task;
// vx does not draw the extra edges Nx's graph adds below a dependency that
// lacks one of them.
it('a ^name reaches each direct dependency only, as vx reads it', async () => {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  for (const d of ['a', 'b', 'c']) await mkdir(path.join(root, d), { recursive: true })
  const run = { executor: 'nx:run-commands', options: { command: 'true' } }
  const nodes = {
    a: {
      name: 'a',
      data: { root: 'a', targets: { build: { ...run, dependsOn: ['^build', '^test'] } } },
    },
    b: { name: 'b', data: { root: 'b', targets: { test: run } } },
    c: { name: 'c', data: { root: 'c', targets: { build: run, test: run } } },
  }
  const dependencies = {
    a: [{ source: 'a', target: 'b', type: 'static' }],
    b: [{ source: 'b', target: 'c', type: 'static' }],
    c: [],
  }
  await writeFile(path.join(root, 'graph.json'), JSON.stringify({ graph: { nodes, dependencies } }))
  const index = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { nx } from ${JSON.stringify(index)}\nexport default { plugins: [nx({ graph: 'graph.json' })] }\n`,
  )
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const plan = await planRun({ cwd: root, tasks: ['a#build'], log: silent() })
  const deps = Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.node.deps]))
  expect(deps['a#build']).not.toContain('c#test')
}, 30_000)
