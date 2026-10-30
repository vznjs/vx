// A run's dependents count is the scheduler's baseline, and every row's
// `blocks` shows that same count: one closure, built once and remembered
// with the graph. The closure over 11k nodes cost ~100 ms of every
// 9,603-task warm run and three times that cold, and a second count for
// the rows alone was a pass of its own (2026-10-29).

import { Database } from 'bun:sqlite'
import { expect, it } from 'bun:test'
import { IndexFoldMemo } from '../src/cache/fold-memo.js'
import { computeReverseDepCount, runGraph } from '../src/graph/index.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { graphCounts } from '../src/orchestrator/graph-memo.js'
import { createForecast } from '../src/report/index.js'

const node = (id: string, deps: string[] = [], group = false): TaskNode => ({
  id,
  projectName: id.split('#')[0]!,
  projectDir: '/tmp',
  taskName: id.split('#')[1]!,
  config: group ? { dependsOn: deps } : { exec: { command: 'noop' } },
  deps,
  requested: true,
})

// A diamond under a group: diamonds double-count under naive sums, and a
// group counts as the scheduler counts it.
const graph = (): Map<string, TaskNode> =>
  new Map(
    [
      node('a#build'),
      node('b#build', ['a#build']),
      node('c#build', ['a#build']),
      node('d#install', ['b#build', 'c#build'], true),
      node('d#test', ['d#install']),
      node('e#lint'),
    ].map((n) => [n.id, n]),
  )

const folds = () => {
  const db = new Database(':memory:')
  db.exec(
    'CREATE TABLE fold_memo (task_id TEXT PRIMARY KEY, probe TEXT NOT NULL, key TEXT NOT NULL, seen_at INTEGER NOT NULL)',
  )
  return new IndexFoldMemo(db, true)
}

it('a row’s blocks is the scheduler’s own count, groups counted', () => {
  const nodes = graph()
  const counts = graphCounts(nodes, folds(), 'graph-token')
  expect(counts).toEqual(computeReverseDepCount(nodes))
  expect(counts.get('a#build')).toBe(4)
  // The live rows read the count they are handed, never a pass of their own.
  const live = createForecast(nodes, new Map(), 4, counts)(new Set(), new Map([['a#build', 0]]), 0)
  expect(live.blockedBy.get('a#build')).toBe(4)
})

it('a remembered graph’s counts are read back, not built again', () => {
  const memo = folds()
  const first = graphCounts(graph(), memo, 'graph-token')
  // Same token and tasks, other edges: only a read back answers with the
  // counts of the graph it was built from.
  const edited = graph()
  edited.get('b#build')!.deps = []
  edited.get('c#build')!.deps = []
  const again = graphCounts(edited, memo, 'graph-token')
  expect(again).toEqual(first)
  expect(again.get('a#build')).toBe(4)
})

it('another token or another task set builds afresh', () => {
  const memo = folds()
  graphCounts(graph(), memo, 'graph-token')
  const edited = graph()
  edited.get('b#build')!.deps = []
  edited.get('c#build')!.deps = []
  expect(graphCounts(edited, memo, 'other-token').get('a#build')).toBe(0)
  // A run that prunes the graph (`--affected`) keeps the token; the tasks differ.
  const pruned = graph()
  pruned.delete('e#lint')
  pruned.get('b#build')!.deps = []
  expect(graphCounts(pruned, memo, 'graph-token').get('a#build')).toBe(3)
})

it('no token means no memo: counted from the nodes', () => {
  const memo = folds()
  const edited = graph()
  graphCounts(graph(), memo, undefined)
  edited.get('b#build')!.deps = []
  edited.get('c#build')!.deps = []
  expect(graphCounts(edited, memo, undefined).get('a#build')).toBe(0)
})

it('the scheduler ranks by the dependents counts it is handed', async () => {
  // Without them, a#hub (two dependents) starts first; handed counts that
  // rank z#leaf higher, z#leaf does.
  const nodes = new Map(
    [node('a#hub'), node('b#x', ['a#hub']), node('c#y', ['a#hub']), node('z#leaf')].map((n) => [
      n.id,
      n,
    ]),
  )
  const started: string[] = []
  const ok = (n: TaskNode): TaskOutcome => ({
    node: n,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
  })
  await runGraph({
    nodes,
    concurrency: 1,
    reverseDeps: () => new Map([['z#leaf', 9]]),
    execute: async (n) => {
      started.push(n.id)
      return ok(n)
    },
  })
  expect(started[0]).toBe('z#leaf')
})
