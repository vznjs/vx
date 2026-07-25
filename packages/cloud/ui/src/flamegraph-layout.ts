// Pure layout math for the flamegraph. Bars are greedily packed into lanes
// (first lane whose previous bar finished), so lanes reveal parallelism rather
// than grouping by project; position is proportional to (start, end) within the
// run window. The Solid component maps these to absolute-positioned divs.
//
// HONESTY MODE: some ingested runs carry no per-task timeline — the server
// anchors every task on the RUN's span, so every "span" is the whole window
// and a timeline rendering would show N identical full-width bars (a lie that
// reads as "everything ran the whole time"). When the spans provably carry no
// information, `layout` switches to `mode: 'durations'`: one lane per task,
// left-aligned bars proportional to the task's RECORDED duration, sorted
// longest-first — a ranked duration chart in the same visual language.

export interface LayoutInput {
  taskId: string
  project: string
  startNs: number
  endNs: number
  /** The task's recorded duration (ms) — the truth the durations mode renders;
   *  independent of the (possibly fabricated) start/end span. */
  durationMs: number
  status: string
  cacheHit: boolean
}

export interface LayoutBar {
  taskId: string
  project: string
  lane: number
  leftPct: number
  widthPct: number
  /** What the bar's width MEANS, for labels: elapsed span (timeline) or the
   *  recorded duration (durations mode). Milliseconds. */
  durationMs: number
  status: string
  cacheHit: boolean
}

export interface Layout {
  bars: LayoutBar[]
  lanes: string[]
  /** The axis span (ms): the run window in timeline mode, the longest task's
   *  duration in durations mode. */
  totalNs: number
  mode: 'timeline' | 'durations'
}

// Every bar renders at least this wide (% of the run window) so a cache hit
// (≈0 duration) is still visible + clickable. Lane packing MUST account for it.
const MIN_WIDTH_PCT = 0.6
// Tolerance so a bar that ends exactly where the next starts (touching,
// sequential) can still share a lane.
const EPS = 1e-6
// Degenerate-timeline detection: every span covers at least this much of the
// window, while at least the longest recorded duration is well short of it.
const FULL_SPAN = 0.97
const REAL_DURATION = 0.9

export function layout(input: readonly LayoutInput[]): Layout {
  if (input.length === 0) return { bars: [], lanes: [], totalNs: 0, mode: 'timeline' }
  const minStart = Math.min(...input.map((t) => t.startNs))
  const maxEnd = Math.max(...input.map((t) => t.endNs))
  const totalNs = Math.max(1, maxEnd - minStart)

  // Degenerate: every task "spans" (approximately) the whole window, yet the
  // recorded durations say the work was much shorter — the spans are derived,
  // not measured. A genuinely all-parallel run (durations ≈ window) keeps the
  // timeline, which then tells the truth.
  const spans = input.map((t) => Math.max(0, t.endNs - t.startNs))
  const maxDuration = Math.max(...input.map((t) => t.durationMs))
  const degenerate =
    input.length > 1 &&
    spans.every((s) => s >= totalNs * FULL_SPAN) &&
    maxDuration < totalNs * REAL_DURATION
  if (degenerate) {
    const axis = Math.max(1, maxDuration)
    const order = input
      .map((_, i) => i)
      .sort((a, b) => input[b]!.durationMs - input[a]!.durationMs || a - b)
    const laneByIndex = new Array<number>(input.length)
    order.forEach((idx, rank) => {
      laneByIndex[idx] = rank
    })
    const bars = input.map<LayoutBar>((t, i) => ({
      taskId: t.taskId,
      project: t.project,
      lane: laneByIndex[i]!,
      leftPct: 0,
      widthPct: Math.max(MIN_WIDTH_PCT, (t.durationMs / axis) * 100),
      durationMs: t.durationMs,
      status: t.status,
      cacheHit: t.cacheHit,
    }))
    return { bars, lanes: order.map((_, i) => String(i)), totalNs: axis, mode: 'durations' }
  }

  // Each bar's RENDERED geometry (left + width, with the min width applied).
  const geom = input.map((t) => {
    const leftPct = ((t.startNs - minStart) / totalNs) * 100
    const widthPct = Math.max(MIN_WIDTH_PCT, ((t.endNs - t.startNs) / totalNs) * 100)
    return { leftPct, rightPct: leftPct + widthPct, widthPct }
  })

  // Greedy packing by RENDERED extent, NOT raw time. This is the fix for
  // "lines on each other": keying off raw time let many zero-duration cache
  // hits at the same instant (their `end <= start`) collapse onto ONE lane and
  // overlap pixel-for-pixel. Comparing each lane's last rendered RIGHT edge
  // against this bar's LEFT edge forces every visually-overlapping bar onto its
  // own lane, while genuinely disjoint (sequential) bars still share one.
  // Order by left edge so earlier bars claim the low lanes first.
  const order = input.map((_, i) => i).sort((a, b) => geom[a]!.leftPct - geom[b]!.leftPct || a - b)
  const laneRight: number[] = []
  const laneByIndex = new Array<number>(input.length)
  for (const i of order) {
    const g = geom[i]!
    let lane = laneRight.findIndex((right) => right <= g.leftPct + EPS)
    if (lane === -1) {
      lane = laneRight.length
      laneRight.push(g.rightPct)
    } else {
      laneRight[lane] = g.rightPct
    }
    laneByIndex[i] = lane
  }

  const bars = input.map<LayoutBar>((t, i) => ({
    taskId: t.taskId,
    project: t.project,
    lane: laneByIndex[i]!,
    leftPct: geom[i]!.leftPct,
    widthPct: geom[i]!.widthPct,
    durationMs: Math.max(0, t.endNs - t.startNs),
    status: t.status,
    cacheHit: t.cacheHit,
  }))
  const lanes = laneRight.map((_, i) => String(i)) // count only — drives height
  return { bars, lanes, totalNs, mode: 'timeline' }
}
