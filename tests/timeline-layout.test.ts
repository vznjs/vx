// Pure-math tests for the timeline layout (the Gantt bars in the
// Timeline view). Input: per-task wallclock span; output: bar
// position + width in cells.

import { describe, expect, it } from 'bun:test'
import { layoutTimeline, type TimelineTask } from '../src/tui/primitives/timeline-layout.ts'

const t = (id: string, startNs: bigint, endNs: bigint, status = 'success'): TimelineTask => ({
  id,
  startNs,
  endNs,
  status,
})

describe('layoutTimeline', () => {
  it('returns an empty layout when there are no tasks', () => {
    const out = layoutTimeline({ tasks: [], width: 60, totalNs: 1000n })
    expect(out.rows).toEqual([])
    expect(out.totalNs).toBe(1000n)
  })

  it('uses the supplied totalNs as the timeline span', () => {
    const tasks = [t('a', 0n, 500_000_000n), t('b', 500_000_000n, 1_000_000_000n)]
    const out = layoutTimeline({ tasks, width: 40, totalNs: 1_000_000_000n })
    expect(out.totalNs).toBe(1_000_000_000n)
  })

  it('places a task starting at t=0 at column 0', () => {
    const tasks = [t('a', 0n, 1n)]
    const out = layoutTimeline({ tasks, width: 100, totalNs: 1_000_000_000n })
    expect(out.rows[0]?.startCol).toBe(0)
  })

  it('places a task starting at totalNs at the last column', () => {
    const tasks = [t('a', 1_000_000_000n, 1_000_000_000n)]
    const out = layoutTimeline({ tasks, width: 100, totalNs: 1_000_000_000n })
    expect(out.rows[0]?.startCol).toBe(99)
  })

  it('scales width proportionally to the task duration', () => {
    // Task fills half the timeline → bar = half the width.
    const tasks = [t('a', 0n, 500_000_000n)]
    const out = layoutTimeline({ tasks, width: 100, totalNs: 1_000_000_000n })
    expect(out.rows[0]?.widthCols).toBe(50)
  })

  it('guarantees a minimum bar width of 1 cell for visible work', () => {
    // Tiny task: 1 ns out of 1 s → 0 cols by float math, but we
    // floor-1 so the bar stays visible.
    const tasks = [t('a', 0n, 1n)]
    const out = layoutTimeline({ tasks, width: 100, totalNs: 1_000_000_000n })
    expect(out.rows[0]?.widthCols).toBe(1)
  })

  it('clamps a task that runs past totalNs to the right edge', () => {
    const tasks = [t('a', 0n, 2_000_000_000n)]
    const out = layoutTimeline({ tasks, width: 50, totalNs: 1_000_000_000n })
    expect(out.rows[0]?.startCol).toBe(0)
    expect((out.rows[0]?.startCol ?? 0) + (out.rows[0]?.widthCols ?? 0)).toBeLessThanOrEqual(50)
  })

  it('preserves input order in rows[] (one row per task)', () => {
    const tasks = [t('c', 0n, 100n), t('a', 0n, 100n), t('b', 0n, 100n)]
    const out = layoutTimeline({ tasks, width: 60, totalNs: 100n })
    expect(out.rows.map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('skips a task that has not started (startNs undefined-equivalent)', () => {
    // We model "not started" as startNs == endNs == 0n.
    const tasks = [t('a', 0n, 0n), t('b', 0n, 1_000_000_000n)]
    const out = layoutTimeline({ tasks, width: 100, totalNs: 1_000_000_000n })
    expect(out.rows.map((r) => r.id)).toEqual(['b'])
  })
})
