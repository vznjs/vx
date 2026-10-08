// `lerna run <x>` runs each package's <x> after its dependencies' <x>
// (Lerna 6+ hands Nx `^<x>`), unless nx.json `targetDefaults` or a
// package's `nx` key configures Nx's task dependencies. The exported graph
// holds no such edge, and a Lerna repo mapped from it built b beside a.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { planRun, type Logger, type ProjectMeta } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-lerna-order-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const script = (name: string) => ({ executor: 'nx:run-script', options: { script: name } })

async function deps(files: Record<string, string>, bNx?: unknown) {
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(root, rel), text)
  const metas: ProjectMeta[] = []
  for (const name of ['a', 'b']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    const pkg = {
      name,
      scripts: { build: 'tsc' },
      ...(name === 'b' ? { dependencies: { a: '*' } } : {}),
      ...(name === 'b' && bNx !== undefined ? { nx: bNx } : {}),
    }
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg))
    metas.push({ name, dir, packageJson: pkg as never, configPath: null })
  }
  const nodes = {
    a: { data: { root: 'packages/a', targets: { build: script('build') } } },
    b: { data: { root: 'packages/b', targets: { build: script('build') } } },
  }
  const graph = { nodes, dependencies: { b: [{ source: 'b', target: 'a' }] } } as NxGraph
  const m = await mapNxWorkspace(root, metas, graph, { cacheable: new Set() })
  return Object.fromEntries(
    m.projects.map((p) => [p.name, p.tasks.find((t) => t.name === 'build')!.task!['dependsOn']]),
  )
}

const LERNA = { 'lerna.json': '{ "version": "1.0.0" }' }

it('orders each target after its dependencies’ under lerna.json', async () => {
  expect(await deps(LERNA)).toEqual({ a: ['^build'], b: ['^build'] })
})

it('an nx.json without targetDefaults keeps Lerna’s order', async () => {
  expect(await deps({ ...LERNA, 'nx.json': '{ "namedInputs": {} }' })).toEqual({
    a: ['^build'],
    b: ['^build'],
  })
})

// Controls: Nx's own order is the graph's (none here).
it('no lerna.json: the graph’s order', async () => {
  expect(await deps({})).toEqual({ a: undefined, b: undefined })
})

it('nx.json targetDefaults: the graph’s order', async () => {
  const nxJson = '{ "targetDefaults": { "lint": {} } }'
  expect(await deps({ ...LERNA, 'nx.json': nxJson })).toEqual({ a: undefined, b: undefined })
})

it('a package.json `nx` key on a package with the target: the graph’s order', async () => {
  expect(await deps(LERNA, {})).toEqual({ a: undefined, b: undefined })
})

const silent = (): Logger => new Proxy({}, { get: () => () => {} }) as Logger

// nx() keeps its mapping between runs: lerna.json is one of its reads.
it('nx() re-maps when lerna.json appears', async () => {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
  await deps({})
  const nodes = {
    a: { name: 'a', data: { root: 'packages/a', targets: { build: script('build') } } },
    b: { name: 'b', data: { root: 'packages/b', targets: { build: script('build') } } },
  }
  await writeFile(
    path.join(root, 'graph.json'),
    JSON.stringify({
      graph: { nodes, dependencies: { a: [], b: [{ source: 'b', target: 'a', type: 'static' }] } },
    }),
  )
  const index = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource(
      [`nx({ graph: 'graph.json' })`],
      `import { nx } from ${JSON.stringify(index)}\n`,
    ),
  )
  await writeFile(path.join(root, '.gitignore'), '.vx\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const bDeps = async () =>
    (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks.find(
      (t) => t.node.id === 'b#build',
    )!.deps
  expect(await bDeps()).toEqual([])
  await writeFile(path.join(root, 'lerna.json'), LERNA['lerna.json'])
  expect(await bDeps()).toEqual(['a#build'])
}, 30_000)
