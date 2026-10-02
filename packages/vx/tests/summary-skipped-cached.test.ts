// The result line's hit rate is over tasks that consulted a cache. A task
// skipped behind a failure never did, and counted as a miss it printed
// "0 cached (0%)" on a run in which no task has a cache block.
import { describe, expect, it } from 'bun:test'
import { formatRunSummary } from '../src/orchestrator/summary.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function outcome(id: string, status: TaskOutcome['status'], cache?: object): TaskOutcome {
  return {
    node: { id, config: { exec: { command: 'noop' }, ...(cache ? { cache } : {}) } } as TaskNode,
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 100,
  }
}

const result = (outcomes: TaskOutcome[]): string | undefined =>
  formatRunSummary(
    outcomes,
    40,
    { enabled: false },
    {
      version: '0.0.0',
      packageCount: 1,
      remoteCacheEnabled: false,
    },
  ).at(-1)

describe('the result line — a skipped task is no cache miss', () => {
  it('no task with a cache: no hit rate', () => {
    expect(
      result([outcome('a#x', 'failed'), outcome('c#x', 'success'), outcome('b#x', 'skipped')]),
    ).toBe('  result    3 tasks · 1 failed · 2 no-cache · 40ms')
  })

  it('a skipped cached task is left out of the rate', () => {
    expect(
      result([
        outcome('a#x', 'cache-hit', {}),
        outcome('b#x', 'failed', {}),
        outcome('c#x', 'skipped', {}),
      ]),
    ).toBe('  result    3 tasks · 1 failed · 1 cached (50%) · 40ms')
  })
})
