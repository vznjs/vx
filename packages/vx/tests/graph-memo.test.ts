// The task graph memo (orchestrator/graph-memo.ts) reads a graph back when
// the lock's bytes, the projects and their edges have not moved. What it
// reads back must be the graph the builder makes, and anything the builder
// reads must move the token.

import { Database } from 'bun:sqlite'
import { expect, it } from 'bun:test'
import type { TaskConfig } from '../src/config.js'
import { IndexFoldMemo } from '../src/cache/fold-memo.js'
import { buildTaskGraph, type ProjectEntry } from '../src/graph/task-graph.js'
import { memoGraph, type GraphMemo } from '../src/orchestrator/graph-memo.js'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import type { ProjectMeta } from '../src/workspace/workspace.js'

const metas: ProjectMeta[] = [
  { name: 'a', dir: '/ws/a', configPath: '/ws/a/vx.config.ts', deps: [] },
  { name: 'b', dir: '/ws/b', configPath: '/ws/b/vx.config.ts', deps: ['a'] },
]

const tasks = (bDeps: string[]): Map<string, ProjectEntry> => {
  const build: TaskConfig = { dependsOn: ['^build'], exec: { command: 'tsc' } }
  return new Map([
    ['a', { name: 'a', dir: '/ws/a', config: { tasks: { build } } }],
    [
      'b',
      {
        name: 'b',
        dir: '/ws/b',
        config: { tasks: { build, test: { dependsOn: bDeps, exec: { command: 'bun test' } } } },
      },
    ],
  ])
}

const memoOn = (lock: string, list = metas): GraphMemo => {
  const db = new Database(':memory:')
  db.exec(
    'CREATE TABLE fold_memo (task_id TEXT PRIMARY KEY, probe TEXT NOT NULL, key TEXT NOT NULL, seen_at INTEGER NOT NULL)',
  )
  return { folds: new IndexFoldMemo(db, true), lock, metas: list }
}

const options = (projects: Map<string, ProjectEntry>, list = metas) => ({
  projects,
  packageGraph: buildPackageGraph(list),
  requested: [
    { project: 'b', task: 'test' },
    { project: 'a', task: 'build' },
  ],
  workspaceRoot: '/ws',
  rules: { locked: true },
})

it('a graph read back is the graph the builder makes', () => {
  const memo = memoOn('lock-1')
  const first = memoGraph(options(tasks(['build'])), memo)
  const again = memoGraph(options(tasks(['build'])), memo)
  expect(again.token).toBe(first.token!)
  expect(again.nodes).not.toBe(first.nodes)
  expect([...again.nodes.entries()]).toEqual([
    ...buildTaskGraph(options(tasks(['build']))).entries(),
  ])
})

it('a read back is a hit: the configs it was built from are not read again', () => {
  const memo = memoOn('lock-1')
  memoGraph(options(tasks(['build'])), memo)
  // Same lock, other configs: only a hit can answer with the remembered edge.
  const hit = memoGraph(options(tasks([])), memo)
  expect(hit.nodes.get('b#test')!.deps).toEqual(['b#build'])
})

it('another lock, another edge, another project each build afresh', () => {
  const memo = memoOn('lock-1')
  const first = memoGraph(options(tasks(['build'])), memo).token
  const relocked = memoGraph(options(tasks([])), { ...memo, lock: 'lock-2' })
  expect(relocked.token).not.toBe(first)
  expect(relocked.nodes.get('b#test')!.deps).toEqual([])

  const unlinked = metas.map((m) => ({ ...m, deps: [] }))
  const edges = memoGraph(options(tasks(['build']), unlinked), { ...memo, metas: unlinked })
  expect(edges.token).not.toBe(first)
  expect(edges.nodes.get('b#build')!.deps).toEqual([])

  const moved = metas.map((m) => (m.name === 'a' ? { ...m, configPath: null } : m))
  expect(memoGraph(options(tasks(['build'])), { ...memo, metas: moved }).token).not.toBe(first)
})

it('a scoped load is never remembered', () => {
  const memo = memoOn('lock-1')
  const scoped = memoGraph({ ...options(tasks(['build'])), undeclaredDeps: () => {} }, memo)
  expect(scoped.token).toBeUndefined()
  expect(memoGraph(options(tasks([])), memo).nodes.get('b#test')!.deps).toEqual([])
})

it('a graph read back keeps its addition marks: task ids, and the globs that add', () => {
  const memo = memoOn('lock-1')
  const writes = (files: string[], dependsOn: string[] = []): TaskConfig => ({
    dependsOn,
    exec: { command: 'tsc' },
    inputs: { files: ['src/**'] },
    cache: { outputs: { files } },
  })
  const projects = new Map<string, ProjectEntry>([
    [
      'a',
      {
        name: 'a',
        dir: '/ws/a',
        config: { tasks: { build: writes(['dist/**']), gen: writes(['dist/gen/**'], ['build']) } },
      },
    ],
  ])
  const opts = {
    ...options(projects),
    requested: [{ project: 'a', task: 'gen' }],
    rules: { locked: true, exclusiveOutputs: false },
  }
  const built = buildTaskGraph(opts)
  expect(built.get('a#gen')!.addsToOutputsOf).toEqual(['a#build'])
  expect(built.get('a#build')!.outputsAddedToBy).toEqual(['dist/gen/**'])
  memoGraph(opts, memo)
  expect([...memoGraph(opts, memo).nodes.entries()]).toEqual([...built.entries()])
})
