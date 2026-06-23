// Pure layout math for the flamegraph. Lane = project; bar position is
// proportional to (span_start_ns, span_end_ns) within the run's wallclock
// window. The Solid component just maps these to absolute-positioned divs.

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
  const lanes: string[] = []
  for (const t of input) if (!lanes.includes(t.project)) lanes.push(t.project)
  lanes.sort()
  const bars = input.map<LayoutBar>((t) => {
    const lane = lanes.indexOf(t.project)
    const leftPct = ((t.startNs - minStart) / totalNs) * 100
    const widthPct = Math.max(0.2, ((t.endNs - t.startNs) / totalNs) * 100)
    return {
      taskId: t.taskId,
      project: t.project,
      lane,
      leftPct,
      widthPct,
      status: t.status,
      cacheHit: t.cacheHit,
    }
  })
  return { bars, lanes, totalNs }
}
