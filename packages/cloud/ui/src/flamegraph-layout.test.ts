// Flamegraph lane packing — the invariant that matters: no two bars ever
// overlap on screen (same lane + overlapping [left, left+width]). The earlier
// time-based packing collapsed zero-duration cache hits at the same instant
// onto one lane → "lines on each other"; this pins that it can't recur.

import { describe, expect, it } from 'bun:test'
import { layout, type LayoutInput } from './flamegraph-layout.ts'

function mk(id: string, startNs: number, endNs: number, durationMs?: number): LayoutInput {
  return {
    taskId: id,
    project: id.split('#')[0]!,
    startNs,
    endNs,
    durationMs: durationMs ?? Math.max(0, endNs - startNs),
    status: 'success',
    cacheHit: false,
  }
}

/** Assert no two bars share a lane AND overlap horizontally. */
function expectNoOverlap(input: LayoutInput[]): void {
  const { bars } = layout(input)
  const byLane = new Map<number, { leftPct: number; rightPct: number }[]>()
  for (const b of bars) {
    const arr = byLane.get(b.lane) ?? []
    for (const o of arr) {
      const disjoint = b.leftPct >= o.rightPct - 1e-9 || b.leftPct + b.widthPct <= o.leftPct + 1e-9
      expect(disjoint).toBe(true)
    }
    arr.push({ leftPct: b.leftPct, rightPct: b.leftPct + b.widthPct })
    byLane.set(b.lane, arr)
  }
}

describe('flamegraph layout — no overlap', () => {
  it('puts many zero-duration cache hits at the SAME instant on distinct lanes', () => {
    const at = 1_000_000
    const input = Array.from({ length: 6 }, (_, i) => mk(`p${i}#build`, at, at))
    const { bars, lanes } = layout(input)
    // Each instant-at-same-time bar must get its own lane (no pile-up).
    expect(lanes.length).toBe(6)
    expect(new Set(bars.map((b) => b.lane)).size).toBe(6)
    expectNoOverlap(input)
  })

  it('keeps overlapping (parallel) tasks on separate lanes', () => {
    const input = [mk('a#t', 0, 100), mk('b#t', 10, 90), mk('c#t', 50, 120)]
    expect(new Set(layout(input).bars.map((b) => b.lane)).size).toBe(3)
    expectNoOverlap(input)
  })

  it('lets genuinely sequential (touching) tasks share one lane', () => {
    // Big window so each 100-wide bar is well over the 0.6% min width.
    const input = [mk('a#t', 0, 100), mk('b#t', 100, 200), mk('c#t', 200, 300)]
    expect(layout(input).lanes.length).toBe(1)
    expectNoOverlap(input)
  })

  it('handles a realistic mix (some parallel work, then a burst of hits)', () => {
    const input = [
      mk('a#build', 0, 500),
      mk('b#build', 0, 480),
      mk('c#test', 500, 900),
      mk('d#test', 900, 900), // instant cache hit
      mk('e#test', 900, 900), // instant cache hit at the same instant
      mk('f#test', 900, 900),
    ]
    expectNoOverlap(input)
    // bars stay 1:1 with input order (the component indexes props.tasks by i).
    expect(layout(input).bars.map((b) => b.taskId)).toEqual([
      'a#build',
      'b#build',
      'c#test',
      'd#test',
      'e#test',
      'f#test',
    ])
  })

  it('empty input is empty', () => {
    expect(layout([])).toEqual({ bars: [], lanes: [], totalNs: 0, mode: 'timeline' })
  })
})

describe('flamegraph layout — honest durations fallback', () => {
  it('switches to duration bars when every span is the (fabricated) run window', () => {
    // Ingest without per-task timing anchors every task on the run's span:
    // three tasks all "spanning" 0..1000 while their recorded durations say
    // 120 / 480 / 60. A timeline would draw three identical full-width bars.
    const input = [
      mk('a#build', 0, 1000, 120),
      mk('b#test', 0, 1000, 480),
      mk('c#lint', 0, 1000, 60),
    ]
    const l = layout(input)
    expect(l.mode).toBe('durations')
    expect(l.totalNs).toBe(480) // axis = the longest duration
    // One lane per task, longest first: b (480) → a (120) → c (60).
    const byId = new Map(l.bars.map((b) => [b.taskId, b]))
    expect(byId.get('b#test')!.lane).toBe(0)
    expect(byId.get('a#build')!.lane).toBe(1)
    expect(byId.get('c#lint')!.lane).toBe(2)
    // Left-aligned, width proportional to the RECORDED duration.
    for (const b of l.bars) expect(b.leftPct).toBe(0)
    expect(byId.get('b#test')!.widthPct).toBe(100)
    expect(byId.get('a#build')!.widthPct).toBeCloseTo(25, 5)
    expect(byId.get('c#lint')!.widthPct).toBeCloseTo(12.5, 5)
    // bars stay 1:1 with input order (the component indexes props.tasks by i).
    expect(l.bars.map((b) => b.taskId)).toEqual(['a#build', 'b#test', 'c#lint'])
  })

  it('keeps the timeline when full-window spans are REAL (durations match)', () => {
    // Two tasks that genuinely ran in parallel for the whole window — the
    // timeline (two full bars on two lanes) is the truth, not a fabrication.
    const input = [mk('a#t', 0, 1000, 1000), mk('b#t', 0, 1000, 990)]
    expect(layout(input).mode).toBe('timeline')
  })

  it('keeps the timeline for a real staggered run', () => {
    const input = [mk('a#t', 0, 400, 400), mk('b#t', 400, 1000, 600)]
    expect(layout(input).mode).toBe('timeline')
  })
})
