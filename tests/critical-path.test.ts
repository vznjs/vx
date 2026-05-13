// Topo-DP critical-path tests. Pure function over a node + outcome
// snapshot. See docs/design/tui-design.md §11.2.

import { describe, expect, it } from 'bun:test'
import { computeCriticalPath, type CriticalPathInput } from '../src/tui/state/critical-path.ts'

interface MiniRow {
  id: string
  deps: string[]
  status: 'waiting' | 'ready' | 'running' | 'success' | 'failed' | 'skipped'
  actualMs?: number
  currentElapsedMs?: number
  /** History average duration (ms) for not-yet-finished tasks. */
  historyAvgMs?: number
  persistent?: boolean
}

const baseInput = (rows: MiniRow[]): CriticalPathInput => ({
  tasks: rows.map((r) => ({
    id: r.id,
    deps: r.deps,
    status: r.status,
    persistent: r.persistent ?? false,
    ...(r.actualMs !== undefined ? { actualMs: r.actualMs } : {}),
    ...(r.currentElapsedMs !== undefined ? { currentElapsedMs: r.currentElapsedMs } : {}),
    ...(r.historyAvgMs !== undefined ? { historyAvgMs: r.historyAvgMs } : {}),
  })),
})

describe('computeCriticalPath', () => {
  it('returns an empty path on no tasks', () => {
    const out = computeCriticalPath(baseInput([]))
    expect(out.path).toEqual([])
    expect(out.totalMs).toBe(0)
  })

  it('picks the single chain when there is only one', () => {
    const out = computeCriticalPath(
      baseInput([
        { id: 'a', deps: [], status: 'success', actualMs: 100 },
        { id: 'b', deps: ['a'], status: 'success', actualMs: 200 },
      ]),
    )
    expect(out.path).toEqual(['a', 'b'])
    expect(out.totalMs).toBe(300)
  })

  it('picks the heavier of two parallel chains', () => {
    const out = computeCriticalPath(
      baseInput([
        { id: 'a', deps: [], status: 'success', actualMs: 100 },
        { id: 'b', deps: ['a'], status: 'success', actualMs: 200 }, // a → b = 300
        { id: 'c', deps: ['a'], status: 'success', actualMs: 500 }, // a → c = 600
      ]),
    )
    expect(out.path).toEqual(['a', 'c'])
    expect(out.totalMs).toBe(600)
  })

  it('uses currentElapsedMs for running tasks', () => {
    const out = computeCriticalPath(
      baseInput([
        { id: 'a', deps: [], status: 'success', actualMs: 100 },
        { id: 'b', deps: ['a'], status: 'running', currentElapsedMs: 400 },
      ]),
    )
    expect(out.path).toEqual(['a', 'b'])
    expect(out.totalMs).toBe(500)
  })

  it('uses historyAvgMs for waiting / ready tasks', () => {
    const out = computeCriticalPath(
      baseInput([
        { id: 'a', deps: [], status: 'success', actualMs: 100 },
        { id: 'b', deps: ['a'], status: 'waiting', historyAvgMs: 300 },
      ]),
    )
    expect(out.totalMs).toBe(400)
  })

  it('treats skipped / failed tasks as weight 0', () => {
    const out = computeCriticalPath(
      baseInput([
        { id: 'a', deps: [], status: 'failed' },
        { id: 'b', deps: ['a'], status: 'skipped' },
      ]),
    )
    expect(out.totalMs).toBe(0)
  })

  it('excludes persistent tasks entirely (they never terminate)', () => {
    const out = computeCriticalPath(
      baseInput([
        { id: 'srv', deps: [], status: 'running', persistent: true, currentElapsedMs: 9999 },
        { id: 'a', deps: [], status: 'success', actualMs: 100 },
        { id: 'b', deps: ['a'], status: 'success', actualMs: 50 },
      ]),
    )
    expect(out.path).toEqual(['a', 'b'])
    expect(out.totalMs).toBe(150)
  })

  it('chooses a stable predecessor when multiple deps tie on dist', () => {
    // Determinism: when two parent chains tie at the same length, the
    // earlier-listed `deps` entry wins.
    const out = computeCriticalPath(
      baseInput([
        { id: 'a', deps: [], status: 'success', actualMs: 100 },
        { id: 'b', deps: [], status: 'success', actualMs: 100 },
        { id: 'c', deps: ['a', 'b'], status: 'success', actualMs: 50 },
      ]),
    )
    expect(out.path).toEqual(['a', 'c'])
    expect(out.totalMs).toBe(150)
  })
})
