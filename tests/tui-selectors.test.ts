// Tests for state selectors. Each selector is pure (State) => result.

import { describe, expect, it } from 'bun:test'
import {
  selectParallelPct,
  selectReadyQueue,
  selectBlockedQueue,
  selectTopBlockers,
  selectSlowVsHistory,
  selectCacheMissImpact,
} from '../src/tui/state/selectors.ts'
import { initialState, reduce } from '../src/tui/state/store.ts'
import type { ObserverEvent, HistoryTable } from '../src/orchestrator/observer.ts'
import type { TaskNode } from '../src/graph/task-graph.js'

const tnode = (id: string, deps: string[] = []): TaskNode => ({
  id,
  projectName: id.split('#')[0]!,
  projectDir: '/tmp',
  taskName: id.split('#')[1]!,
  config: { exec: { command: 'noop' } },
  deps,
  requested: true,
})

const event = (e: ObserverEvent) => ({ type: 'event' as const, event: e })

const seed = (nodes: TaskNode[], concurrency: number, history: HistoryTable = new Map()) =>
  reduce(
    initialState(),
    event({
      kind: 'runStart',
      runId: '01',
      nodes,
      concurrency,
      remoteCacheEnabled: false,
      startedAtMs: 0,
      historyTable: history,
    }),
  )

describe('selectParallelPct', () => {
  it('returns 0 when nothing is running', () => {
    const s = seed([tnode('a'), tnode('b')], 4)
    expect(selectParallelPct(s)).toBe(0)
  })

  it('returns the integer percent of busy slots', () => {
    let s = seed([tnode('a'), tnode('b'), tnode('c'), tnode('d')], 4)
    s = reduce(s, event({ kind: 'taskStart', nodeId: 'a', startNs: 1n, slot: 0 }))
    expect(selectParallelPct(s)).toBe(25)
    s = reduce(s, event({ kind: 'taskStart', nodeId: 'b', startNs: 1n, slot: 1 }))
    expect(selectParallelPct(s)).toBe(50)
  })
})

describe('ready / blocked queues', () => {
  it('classifies waiting tasks with all-finished deps as ready', () => {
    let s = seed([tnode('a'), tnode('b', ['a'])], 2)
    expect(selectReadyQueue(s).map((r) => r.id)).toEqual(['a'])
    expect(selectBlockedQueue(s).map((r) => r.id)).toEqual(['b'])

    s = reduce(
      s,
      event({
        kind: 'taskComplete',
        outcome: {
          node: tnode('a'),
          status: 'success',
          exitCode: 0,
          durationMs: 0,
        },
      }),
    )
    expect(selectReadyQueue(s).map((r) => r.id)).toEqual(['b'])
    expect(selectBlockedQueue(s)).toEqual([])
  })

  it('does not count a task in the ready queue while it is running', () => {
    let s = seed([tnode('a')], 1)
    s = reduce(s, event({ kind: 'taskStart', nodeId: 'a', startNs: 1n, slot: 0 }))
    expect(selectReadyQueue(s)).toEqual([])
  })
})

describe('selectTopBlockers', () => {
  it('ranks waiting/running tasks by dependentsCount desc', () => {
    // Diamond: a → b, a → c, both → d, plus an isolated e.
    const nodes = [
      tnode('a'),
      tnode('b', ['a']),
      tnode('c', ['a']),
      tnode('d', ['b', 'c']),
      tnode('e'),
    ]
    const s = seed(nodes, 4)
    const top = selectTopBlockers(s, 3)
    // `a` blocks b, c, d (3 dependents). b and c each block d.
    expect(top[0]?.id).toBe('a')
    expect(top[0]?.dependentsCount).toBe(3)
  })

  it('excludes finished tasks', () => {
    const nodes = [tnode('a'), tnode('b', ['a']), tnode('c', ['a'])]
    let s = seed(nodes, 4)
    s = reduce(
      s,
      event({
        kind: 'taskComplete',
        outcome: { node: tnode('a'), status: 'success', exitCode: 0, durationMs: 0 },
      }),
    )
    expect(selectTopBlockers(s, 5).map((r) => r.id)).not.toContain('a')
  })
})

describe('selectSlowVsHistory', () => {
  it('returns running tasks whose elapsed exceeds 1.5× their history avg', () => {
    const history: HistoryTable = new Map([
      [
        'a#build',
        { runs: 5, avgMs: 100, p50Ms: 100, p99Ms: 110, successRate: 1, hitRate: 0, recent: [] },
      ],
    ])
    let s = seed([tnode('a#build')], 1, history)
    s = reduce(s, event({ kind: 'taskStart', nodeId: 'a#build', startNs: 0n, slot: 0 }))
    // Pretend "now" is 250ms after start (250ms / 100ms = 2.5×).
    const slow = selectSlowVsHistory(s, 250)
    expect(slow.map((r) => r.id)).toEqual(['a#build'])
  })

  it('omits tasks within 1.5× threshold', () => {
    const history: HistoryTable = new Map([
      [
        'a#build',
        { runs: 5, avgMs: 100, p50Ms: 100, p99Ms: 110, successRate: 1, hitRate: 0, recent: [] },
      ],
    ])
    let s = seed([tnode('a#build')], 1, history)
    s = reduce(s, event({ kind: 'taskStart', nodeId: 'a#build', startNs: 0n, slot: 0 }))
    expect(selectSlowVsHistory(s, 120)).toEqual([])
  })

  it('omits tasks with no history', () => {
    let s = seed([tnode('a#build')], 1)
    s = reduce(s, event({ kind: 'taskStart', nodeId: 'a#build', startNs: 0n, slot: 0 }))
    expect(selectSlowVsHistory(s, 9999)).toEqual([])
  })
})

describe('selectCacheMissImpact', () => {
  it('ranks cache-miss tasks by their history avg', () => {
    const history: HistoryTable = new Map([
      [
        'a#build',
        { runs: 5, avgMs: 500, p50Ms: 500, p99Ms: 500, successRate: 1, hitRate: 0, recent: [] },
      ],
      [
        'b#build',
        { runs: 5, avgMs: 1500, p50Ms: 1500, p99Ms: 1500, successRate: 1, hitRate: 0, recent: [] },
      ],
    ])
    let s = seed([tnode('a#build'), tnode('b#build')], 2, history)
    s = reduce(s, event({ kind: 'cacheProbe', nodeId: 'a#build', status: 'miss' }))
    s = reduce(s, event({ kind: 'cacheProbe', nodeId: 'b#build', status: 'miss' }))
    expect(selectCacheMissImpact(s).map((r) => r.id)).toEqual(['b#build', 'a#build'])
  })

  it('skips hits and no-cache tasks', () => {
    const history: HistoryTable = new Map([
      [
        'a#build',
        { runs: 5, avgMs: 500, p50Ms: 500, p99Ms: 500, successRate: 1, hitRate: 0, recent: [] },
      ],
      [
        'b#build',
        { runs: 5, avgMs: 1500, p50Ms: 1500, p99Ms: 1500, successRate: 1, hitRate: 0, recent: [] },
      ],
    ])
    let s = seed([tnode('a#build'), tnode('b#build')], 2, history)
    s = reduce(s, event({ kind: 'cacheProbe', nodeId: 'a#build', status: 'hit-local' }))
    s = reduce(s, event({ kind: 'cacheProbe', nodeId: 'b#build', status: 'no-cache' }))
    expect(selectCacheMissImpact(s)).toEqual([])
  })
})
