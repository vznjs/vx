// The schedule plugin's priority function — recovered from core's
// removed predictive mode (2026-09-02); the seam it now proves is
// `VxPlugin.schedule`.
import { describe, expect, it } from 'bun:test'
import type { HistoryTable, TaskHistory, TaskNode } from '@vzn/vx'
import { criticalPathPriorities } from '../src/index.js'

function node(id: string, deps: string[] = []): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: '/ws/' + projectName,
    taskName,
    config: { exec: { command: 'echo' } } as TaskNode['config'],
    deps,
    requested: false,
  }
}

function hist(p50: number, runs = 5): TaskHistory {
  return {
    runs,
    p50DurationMs: p50,
    p99DurationMs: p50 * 2,
    successRate: 1,
    hitRate: 0,
    failureMode: 'stable',
  }
}

describe('criticalPathPriorities', () => {
  it('a leaf node gets its own p50 as priority', () => {
    const history: HistoryTable = new Map([['pkg#test', hist(2000)]])
    const out = criticalPathPriorities([node('pkg#test')], history)
    expect(out.get('pkg#test')).toBe(2000)
  })

  it('a node with dependents folds the max downstream chain', () => {
    const nodes = [
      node('pkg#build'),
      node('pkg#test', ['pkg#build']),
      node('pkg#publish', ['pkg#test']),
    ]
    const history: HistoryTable = new Map([
      ['pkg#build', hist(100)],
      ['pkg#test', hist(2000)],
      ['pkg#publish', hist(50)],
    ])
    const out = criticalPathPriorities(nodes, history)
    expect(out.get('pkg#publish')).toBe(50)
    expect(out.get('pkg#test')).toBe(2050)
    expect(out.get('pkg#build')).toBe(2150)
  })

  it('falls back to workspace median when a node has no history', () => {
    const nodes = [node('pkg#known'), node('pkg#unknown')]
    const history: HistoryTable = new Map([['pkg#known', hist(500)]])
    const out = criticalPathPriorities(nodes, history)
    expect(out.get('pkg#unknown')).toBe(500)
  })

  it('falls back to default duration when history is entirely empty', () => {
    const out = criticalPathPriorities([node('pkg#anything')], new Map())
    expect(out.get('pkg#anything')).toBe(1000)
  })

  it('prefers the slowest downstream chain when there are siblings', () => {
    const nodes = [node('pkg#root'), node('pkg#fast', ['pkg#root']), node('pkg#slow', ['pkg#root'])]
    const history: HistoryTable = new Map([
      ['pkg#root', hist(100)],
      ['pkg#fast', hist(50)],
      ['pkg#slow', hist(5000)],
    ])
    const out = criticalPathPriorities(nodes, history)
    expect(out.get('pkg#root')).toBe(5100)
  })

  // The graph Map inserts a dependent BEFORE the deps it pulls in
  // (pre-order from the requested roots), so the fold must not assume any
  // scan direction over `nodes`. The old traversal effectively processed
  // reverse-insertion order, which collapsed every upstream's priority to
  // its own duration on a real graph.
  it('folds chains regardless of node order (real pre-order insertion)', () => {
    const nodes = [
      node('pkg#publish', ['pkg#test']),
      node('pkg#test', ['pkg#build']),
      node('pkg#build'),
    ]
    const history: HistoryTable = new Map([
      ['pkg#build', hist(100)],
      ['pkg#test', hist(2000)],
      ['pkg#publish', hist(50)],
    ])
    const out = criticalPathPriorities(nodes, history)
    expect(out.get('pkg#publish')).toBe(50)
    expect(out.get('pkg#test')).toBe(2050)
    expect(out.get('pkg#build')).toBe(2150)
  })

  it('a diamond head reflects the long branch, in insertion order', () => {
    // app ← fast ← base and app ← slow ← base; the long chain hangs off
    // the shared head `base`, whose own duration is short. Insertion
    // order is the graph's real pre-order (requested task first).
    const nodes = [
      node('pkg#app', ['pkg#fast', 'pkg#slow']),
      node('pkg#fast', ['pkg#base']),
      node('pkg#base'),
      node('pkg#slow', ['pkg#base']),
    ]
    const history: HistoryTable = new Map([
      ['pkg#app', hist(10)],
      ['pkg#fast', hist(10)],
      ['pkg#slow', hist(1000)],
      ['pkg#base', hist(10)],
    ])
    const out = criticalPathPriorities(nodes, history)
    expect(out.get('pkg#app')).toBe(10)
    expect(out.get('pkg#fast')).toBe(20)
    expect(out.get('pkg#slow')).toBe(1010)
    // base's priority = own + the SLOW branch chain — the lookahead LPT
    // ordering exists for. Own-duration collapse would report 10.
    expect(out.get('pkg#base')).toBe(1020)
  })
})

describe('criticalPathPriorities — assumed durations for the cold run', () => {
  // The CI shape: a long leaf (the docs build) beside a chain of short
  // tasks. With no history at all every node weighs the flat default, so
  // the chain's head outranks the leaf by chain length alone.
  const shape = [
    node('docs#build'),
    node('vx#shard'),
    node('vx#test', ['vx#shard']),
    node('vx#ci', ['vx#test', 'docs#build']),
  ]

  it('CONTROL: with no history and no assumption the chain head outranks the long leaf', () => {
    const p = criticalPathPriorities(shape, new Map())
    expect(p.get('vx#shard')).toBeGreaterThan(p.get('docs#build')!)
  })

  it('an assumed duration lifts a history-less leaf above the chain', () => {
    const p = criticalPathPriorities(shape, new Map(), { 'docs#build': 30_000 })
    expect(p.get('docs#build')).toBe(30_000 + 1000)
    expect(p.get('docs#build')).toBeGreaterThan(p.get('vx#shard')!)
  })

  it('a recorded p50 wins over an assumption', () => {
    const history: HistoryTable = new Map([['docs#build', hist(500)]])
    const p = criticalPathPriorities(shape, history, { 'docs#build': 30_000 })
    // 500 own + the median (500, the only p50) for `ci` behind it.
    expect(p.get('docs#build')).toBe(1000)
  })

  it('assumptions never feed the workspace median', () => {
    const history: HistoryTable = new Map([['vx#shard', hist(100)]])
    const p = criticalPathPriorities(shape, history, { 'docs#build': 30_000 })
    // `test` and `ci` have no history and no assumption: the median of the
    // one recorded p50 (100), not the 30 s assumed for the docs build.
    expect(p.get('vx#test')).toBe(200)
  })
})
