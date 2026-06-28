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

export function layout(input: readonly LayoutInput[]): Layout {
  if (input.length === 0) return { bars: [], lanes: [], totalNs: 0 }
  const minStart = Math.min(...input.map((t) => t.startNs))
  const maxEnd = Math.max(...input.map((t) => t.endNs))
  const totalNs = Math.max(1, maxEnd - minStart)
  // Greedy time-packing: each task takes the first lane whose previous bar
  // already finished; otherwise a new lane. This shows every task (cache hits
  // included) and reveals parallelism, instead of piling a project into one row.
  const order = input.map((t, i) => ({ t, i })).sort((a, b) => a.t.startNs - b.t.startNs)
  const laneEnds: number[] = []
  const laneByIndex = new Array<number>(input.length)
  for (const { t, i } of order) {
    let lane = laneEnds.findIndex((end) => end <= t.startNs)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(t.endNs)
    } else {
      laneEnds[lane] = t.endNs
    }
    laneByIndex[i] = lane
  }
  const bars = input.map<LayoutBar>((t, i) => ({
    taskId: t.taskId,
    project: t.project,
    lane: laneByIndex[i]!,
    leftPct: ((t.startNs - minStart) / totalNs) * 100,
    widthPct: Math.max(0.6, ((t.endNs - t.startNs) / totalNs) * 100),
    status: t.status,
    cacheHit: t.cacheHit,
  }))
  const lanes = laneEnds.map((_, i) => String(i)) // count only — drives height
  return { bars, lanes, totalNs }
}
