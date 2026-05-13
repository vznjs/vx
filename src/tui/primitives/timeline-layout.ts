// Pure layout for the Timeline view's Gantt bars. Each task's hrtime
// span is mapped to a `[startCol, widthCols)` pair inside a fixed
// pixel width. The view renders one bar per row; this module knows
// nothing about cell glyphs, colors, or scrolling — those live in
// `src/tui/views/timeline.tsx`.

export interface TimelineTask {
  id: string
  /** hrtime ns relative to run t=0. `0n` for not-yet-started. */
  startNs: bigint
  /** hrtime ns relative to run t=0. Equal to startNs while running. */
  endNs: bigint
  status: string
}

export interface TimelineLayoutInput {
  tasks: readonly TimelineTask[]
  /** Number of cell columns available for the timeline. */
  width: number
  /** Total wallclock of the run, in ns. */
  totalNs: bigint
}

export interface TimelineRow {
  id: string
  startCol: number
  widthCols: number
  status: string
}

export interface TimelineLayout {
  rows: TimelineRow[]
  totalNs: bigint
}

export function layoutTimeline(input: TimelineLayoutInput): TimelineLayout {
  const { tasks, width, totalNs } = input
  if (tasks.length === 0 || width <= 0) {
    return { rows: [], totalNs }
  }
  // Cast to Number once; bigint division clamps small spans to 0
  // unconditionally and we want sub-cell resolution for the float
  // scale step.
  const totalNum = Number(totalNs)
  if (totalNum <= 0) return { rows: [], totalNs }

  const rows: TimelineRow[] = []
  for (const task of tasks) {
    // Skip tasks that haven't started (0n/0n sentinel).
    if (task.startNs === 0n && task.endNs === 0n) continue
    const startNum = Number(task.startNs)
    const endNum = Number(task.endNs)
    const durationNum = Math.max(0, endNum - startNum)
    const startCol = Math.min(width - 1, Math.floor((startNum / totalNum) * width))
    let widthCols = Math.floor((durationNum / totalNum) * width)
    // Visibility floor — a 1-ns span still needs to render or the
    // user thinks the task didn't run.
    if (widthCols < 1) widthCols = 1
    // Clamp the right edge so the bar never paints past column `width - 1`.
    if (startCol + widthCols > width) widthCols = width - startCol
    rows.push({ id: task.id, startCol, widthCols, status: task.status })
  }
  return { rows, totalNs }
}
