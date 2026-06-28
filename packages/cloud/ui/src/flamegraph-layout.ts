// Pure layout math for the flamegraph. Bars are greedily packed into lanes
// (first lane whose previous bar finished), so lanes reveal parallelism rather
// than grouping by project; position is proportional to (start, end) within the
// run window. The Solid component maps these to absolute-positioned divs.

export interface LayoutInput {
  taskId: string
  project: string
  startNs: number
  endNs: number
  status: string
  cacheHit: boolean
}

export interface LayoutBar {
  taskId: string
  project: string
  lane: number
  leftPct: number
  widthPct: number
  status: string
  cacheHit: boolean
}

export interface Layout {
  bars: LayoutBar[]
  lanes: string[]
  totalNs: number
}

// Every bar renders at least this wide (% of the run window) so a cache hit
// (≈0 duration) is still visible + clickable. Lane packing MUST account for it.
const MIN_WIDTH_PCT = 0.6
// Tolerance so a bar that ends exactly where the next starts (touching,
// sequential) can still share a lane.
const EPS = 1e-6

export function layout(input: readonly LayoutInput[]): Layout {
  if (input.length === 0) return { bars: [], lanes: [], totalNs: 0 }
  const minStart = Math.min(...input.map((t) => t.startNs))
  const maxEnd = Math.max(...input.map((t) => t.endNs))
  const totalNs = Math.max(1, maxEnd - minStart)

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
    status: t.status,
    cacheHit: t.cacheHit,
  }))
  const lanes = laneRight.map((_, i) => String(i)) // count only — drives height
  return { bars, lanes, totalNs }
}
