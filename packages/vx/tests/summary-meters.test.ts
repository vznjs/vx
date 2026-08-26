// Property tests for the summary's meter bars.
//
// `tests/summary.test.ts` covers the section's content — which rows appear,
// what the legends say, the time formatting. This file covers the BAR
// ALLOCATION underneath, which is a different kind of risk: the legend can be
// correct while the bar beside it is a lie.
//
// Two invariants carry the whole surface, and both are stated in the source as
// intent rather than enforced by a type:
//
//   WIDTH — a bar is always exactly BAR_WIDTH cells. It sits under a fixed
//   62-column footer, so a bar one cell short or long visibly ragged-edges the
//   summary, and at a terminal narrower than the region it changes how many
//   physical rows the live region occupies — the class of defect that left
//   junk on screen until the width-aware erase landed.
//
//   VISIBILITY — a non-zero bucket always gets at least one cell. Without it,
//   `1 failed` out of 400 tasks allocates 0.125 cells, floors to zero, and the
//   run renders an ALL-GREEN bar over a red legend. A user scanning the meter
//   rather than reading the numbers sees a clean run.
//
// The allocation is largest-remainder with a minimum-one correction, and the
// two rules fight each other — giving a starved bucket its cell has to take
// one from somewhere. So these are driven over many generated tallies rather
// than a handful of hand-picked ones, because the interesting inputs are the
// ones where rounding and the correction interact.

import { describe, expect, it } from 'bun:test'
import { formatSummarySection, type SummaryStats } from '../src/orchestrator/summary.js'

const BAR_WIDTH = 50
/** ▰ filled, ▱ the dim remainder for not-yet-run tasks. */
const CELL = /[▰▱]/g
// Built from a string so the literal control character never appears in a
// regex literal — oxlint rejects those, and the escape is the readable form.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`)

function stats(over: Partial<SummaryStats> = {}): SummaryStats {
  return {
    failed: 0,
    successful: 0,
    skipped: 0,
    total: 0,
    miss: 0,
    upToDate: 0,
    restoredLocal: 0,
    restoredRemote: 0,
    // Required and explicitly nullable: the section checks `!== null`, so
    // omitting it is a TypeError rather than a default.
    spread: null,
    ...over,
  } as SummaryStats
}

/** The rendered bar on a labelled row, as its raw cell glyphs. */
function bar(lines: string[], label: string): string {
  const i = lines.findIndex((l) => l.trimStart().startsWith(label))
  if (i < 0) return ''
  return (lines[i]!.match(CELL) ?? []).join('')
}

/**
 * The legend, which is its OWN line directly below the bar — indented to the
 * bar column rather than labelled. Reading it off the bar's line finds
 * nothing, which is how the first cut of this file mis-asserted.
 */
function legend(lines: string[], label: string): string {
  const i = lines.findIndex((l) => l.trimStart().startsWith(label))
  return i < 0 ? '' : (lines[i + 1] ?? '')
}

/**
 * Per-segment cell counts, recovered by rendering WITH colors: every segment
 * is painted in its own color, so the escape sequences are the only thing
 * that distinguishes one bucket's cells from another's. With colors off the
 * glyphs are identical and a segment's SIZE is unobservable — which means the
 * min-one-cell rule cannot be tested without them.
 */
function segments(s: SummaryStats, label: string): number[] {
  const lines = formatSummarySection(s, 1000, { enabled: true })
  const i = lines.findIndex((l) => stripAnsi(l).trimStart().startsWith(label))
  if (i < 0) return []
  // Split on escape sequences and keep the runs that are made of cells.
  return lines[i]!.split(ANSI)
    .map((chunk) => (chunk.match(CELL) ?? []).length)
    .filter((n) => n > 0)
}

function stripAnsi(s: string): string {
  return s.replace(new RegExp(ANSI.source, 'g'), '')
}

function render(s: SummaryStats): string[] {
  // No colors: `paint` is a passthrough, so the cell glyphs are the only
  // content and counting them is exact rather than an ANSI-stripping guess.
  return formatSummarySection(s, 1000)
}

describe('the tasks meter always fills exactly the bar width', () => {
  it.each([
    ['one task', { failed: 0, successful: 1, total: 1 }],
    ['an even split', { failed: 1, successful: 1, total: 2 }],
    ['a three-way split', { failed: 1, successful: 1, skipped: 1, total: 3 }],
    ['a thirds split that cannot divide evenly', { successful: 2, failed: 1, total: 3 }],
    ['a sevenths split', { successful: 4, failed: 2, skipped: 1, total: 7 }],
    ['one failure in four hundred', { successful: 399, failed: 1, total: 400 }],
    ['one success in a thousand failures', { successful: 1, failed: 999, total: 1000 }],
    ['exactly BAR_WIDTH tasks', { successful: 25, failed: 25, total: 50 }],
    ['one more than BAR_WIDTH', { successful: 26, failed: 25, total: 51 }],
  ])('%s', (_label, over) => {
    expect(bar(render(stats(over)), 'tasks')).toHaveLength(BAR_WIDTH)
  })

  it('holds across a large generated sweep', () => {
    // The hand-picked cases above are the ones a person thinks of. The
    // interesting inputs for a largest-remainder allocator are the ones where
    // several buckets round the same way and the min-one correction then has
    // to claw a cell back — so this sweeps the space instead of guessing at
    // it. Deterministic (a fixed LCG), so a failure is reproducible.
    let seed = 0x2f6e2b1
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let i = 0; i < 2000; i++) {
      const failed = next(300)
      const successful = next(300)
      const skipped = next(300)
      const left = next(50)
      if (failed + successful + skipped + left === 0) continue
      const s = stats({
        failed,
        successful,
        skipped,
        total: failed + successful + skipped,
        left,
      } as Partial<SummaryStats>)
      const width = bar(render(s), 'tasks').length
      if (width !== BAR_WIDTH) {
        throw new Error(
          `bar width ${width} != ${BAR_WIDTH} for ` +
            `failed=${failed} successful=${successful} skipped=${skipped} left=${left}`,
        )
      }
    }
  })
})

describe('a non-zero bucket is never rendered as nothing', () => {
  it('a single failure among hundreds still takes a cell', () => {
    // The defect this rule exists to prevent: 1/400 floors to zero cells, so
    // the meter renders all-green while the legend says "1 failed". Someone
    // scanning the bar rather than reading the numbers sees a clean run.
    const s = stats({ successful: 399, failed: 1, total: 400 })
    expect(bar(render(s), 'tasks')).toHaveLength(BAR_WIDTH)
    expect(legend(render(s), 'tasks')).toContain('1 failed')
    // 1/400 of 50 cells is 0.125 — it floors to zero, so without the
    // min-one correction this is ONE run of 50 green cells and the meter
    // contradicts its own legend.
    expect(segments(s, 'tasks')).toEqual([1, 49])
  })

  it('every bucket appears when all four are non-zero but tiny', () => {
    // Four buckets over 53 tasks: each is under 1/50 of the run except
    // success, so three of the four would floor to zero.
    const rendered = render(
      stats({
        failed: 1,
        successful: 50,
        skipped: 1,
        total: 52,
        left: 1,
      } as Partial<SummaryStats>),
    )
    expect(bar(rendered, 'tasks')).toHaveLength(BAR_WIDTH)
    // Four painted runs, every one non-empty — three of the four would floor
    // to zero cells without the correction.
    const parts = segments(
      stats({ failed: 1, successful: 50, skipped: 1, total: 52, left: 1 } as Partial<SummaryStats>),
      'tasks',
    )
    expect(parts).toHaveLength(4)
    expect(Math.min(...parts)).toBeGreaterThanOrEqual(1)
    expect(parts.reduce((a, b) => a + b, 0)).toBe(BAR_WIDTH)
  })

  it('a bucket that IS zero contributes nothing', () => {
    // The other direction — the min-one rule must not manufacture a cell for
    // an empty bucket, which would render "0 failed" as a red mark.
    const s = stats({ successful: 10, total: 10 })
    expect(bar(render(s), 'tasks')).toHaveLength(BAR_WIDTH)
    // Exactly ONE painted run — an empty bucket must not be handed a cell,
    // which would render "0 failed" as a red mark.
    expect(segments(s, 'tasks')).toEqual([BAR_WIDTH])
    expect(legend(render(s), 'tasks')).not.toContain('0 failed')
    expect(legend(render(s), 'tasks')).not.toContain('0 skipped')
  })
})

describe('the cache meter obeys the same rules', () => {
  it.each([
    ['all misses', { miss: 10 }],
    ['all local hits', { restoredLocal: 10 }],
    ['one remote hit among many misses', { miss: 999, restoredRemote: 1 }],
    ['a four-way split', { miss: 3, upToDate: 3, restoredLocal: 2, restoredRemote: 1 }],
    ['one of each', { miss: 1, upToDate: 1, restoredLocal: 1, restoredRemote: 1 }],
  ])('%s fills the width exactly', (_label, over) => {
    const total = Object.values(over).reduce((a, b) => a + b, 0)
    const rendered = render(stats({ ...over, successful: total, total } as Partial<SummaryStats>))
    expect(bar(rendered, 'cache')).toHaveLength(BAR_WIDTH)
  })

  it('accounts for skipped tasks too — the meter partitions the WHOLE run', () => {
    // Not what it looks like at first: the cache row is not "tasks that
    // reached a cache decision", it is every task classified by where its
    // result came from, and a skip is its own bucket. So a skipped-only run
    // still draws a full bar, legended `3 skipped`. If it drew only the
    // cache-decided tasks, the two meters would disagree about the size of
    // the same run.
    const s = stats({ skipped: 3, total: 3 })
    expect(bar(render(s), 'cache')).toHaveLength(BAR_WIDTH)
    expect(legend(render(s), 'cache')).toContain('3 skipped')
  })

  it('is omitted entirely for a run with no tasks at all', () => {
    // The genuinely empty case — nothing to partition, so the row is dropped
    // rather than drawn as a bar of nothing.
    expect(bar(render(stats()), 'cache')).toBe('')
    expect(bar(render(stats()), 'tasks')).toBe('')
  })
})

describe('the projects bar', () => {
  const ctx = {
    version: '0.0.0',
    packageCount: 1,
    workspaceProjectCount: 100,
    concurrency: 4,
    remoteCacheEnabled: false,
  }

  function withCtx(over: Partial<typeof ctx>): string[] {
    return formatSummarySection(
      stats({ successful: 1, total: 1, miss: 1 }),
      1000,
      { enabled: false },
      { ...ctx, ...over } as never,
    )
  }

  it('fills the width for any affected/total ratio', () => {
    // Unlike the meters above this is a simple proportion plus a clamp, but it
    // shares the row and a mismatched width ragged-edges the same footer.
    const ratios: Array<[affected: number, total: number]> = [
      [0, 100],
      [1, 100],
      [50, 100],
      [99, 100],
      [100, 100],
      [1, 1],
      [1, 3],
      [2, 3],
      [7, 1000],
    ]
    for (const [affected, total] of ratios) {
      const b = bar(withCtx({ packageCount: affected, workspaceProjectCount: total }), 'projects')
      expect(b).toHaveLength(BAR_WIDTH)
    }
  })

  it('shows at least one cell even when a single project of a thousand is affected', () => {
    // 1/1000 rounds to zero, and a bar showing nothing next to a legend saying
    // "1 affected" is the same lie the tasks meter guards against.
    const lines = withCtx({ packageCount: 1, workspaceProjectCount: 1000 })
    const line = lines.find((l) => l.includes('projects')) ?? ''
    expect(bar(lines, 'projects')).toHaveLength(BAR_WIDTH)
    // The filled glyph must be present, not only the dim remainder.
    expect(line).toContain('▰')
  })

  it('never overflows when every project is affected', () => {
    const lines = withCtx({ packageCount: 100, workspaceProjectCount: 100 })
    expect(bar(lines, 'projects')).toHaveLength(BAR_WIDTH)
    // Fully affected means no dim remainder at all.
    const line = lines.find((l) => l.includes('projects')) ?? ''
    expect(line).not.toContain('▱')
  })

  it('is omitted when the workspace has no projects to divide by', () => {
    // A zero denominator has no ratio to draw, so the row is dropped rather
    // than rendered as a bar against nothing. (`workspaceProjectCount` is also
    // genuinely optional — the live region passes no context at all — and the
    // no-context case is already pinned in tests/summary.test.ts.)
    expect(bar(withCtx({ workspaceProjectCount: 0 }), 'projects')).toBe('')
  })

  // NOT TESTED, deliberately: the `Math.min(BAR_WIDTH, …)` clamp. It can only
  // bite when `packageCount > workspaceProjectCount`, i.e. when the graph
  // covers more projects than discovery found — which cannot happen, since the
  // graph is built from the discovered set. Verified: removing the clamp kills
  // no test. It is unreachable defence, and a test that constructed the
  // impossible input would be pinning a shape the product cannot produce.
})

describe('formatDuration', () => {
  // Small, but it is the number a user reads on every single run, and the
  // unit switch is the kind of boundary that silently regresses.
  it.each([
    [0, '0ms'],
    [1, '1ms'],
    [999, '999ms'],
    [1000, '1.00s'],
    [1500, '1.50s'],
    [59_999, '60.00s'],
    [3_600_000, '3600.00s'],
  ])('%dms renders as %s', async (ms, expected) => {
    const { formatDuration } = await import('../src/orchestrator/summary.js')
    expect(formatDuration(ms)).toBe(expected)
  })
})
