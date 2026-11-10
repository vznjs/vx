// A task skipped behind a failure never consulted a cache, and counted as
// a miss it printed "0 cached (0%)" on a run in which no task has a cache
// block.
import { describe, expect, it } from 'bun:test'
import { formatRunSummary } from '../src/report/summary.js'
import { markKeyFailed, type TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function outcome(id: string, status: TaskOutcome['status'], cache?: object): TaskOutcome {
  return {
    node: {
      id,
      config: { exec: { command: 'noop' }, ...(cache ? { cache: true } : {}) },
    } as TaskNode,
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 100,
  }
}

const footer = (outcomes: TaskOutcome[]): string[] =>
  formatRunSummary(
    outcomes,
    40,
    { enabled: false },
    {
      version: '0.0.0',
      packageCount: 1,
      remoteCacheEnabled: false,
    },
  )

// The result row is gone (2026-10-14: it only repeated other rows); the
// cache legend is where a skipped task must still not read as a miss.
describe('a skipped task is no cache miss', () => {
  it('no task with a cache: no miss', () => {
    const lines = footer([
      outcome('a#x', 'failed'),
      outcome('c#x', 'success'),
      outcome('b#x', 'skipped'),
    ])
    expect(lines.find((l) => l.includes('no-cache'))).toBe('            2 no-cache')
  })

  it('a skipped cached task is no miss', () => {
    const lines = footer([
      outcome('a#x', 'cache-hit', {}),
      outcome('b#x', 'failed', {}),
      outcome('c#x', 'skipped', {}),
    ])
    expect(lines.find((l) => l.includes('miss'))).toBe('            1 miss · 1 up-to-date')
  })
})

describe('a task with no key is no cache bucket', () => {
  it('an uncached task whose key failed is counted once, not twice', () => {
    // Taken out of the misses as no-cache AND as key-failed, the bar got a
    // negative segment and the run ended in a RangeError (2026-11-10).
    const lines = footer([outcome('a#x', 'cache-hit', {}), markKeyFailed(outcome('b#x', 'failed'))])
    expect(lines.find((l) => l.includes('up-to-date'))).toBe('            1 up-to-date')
  })
})
