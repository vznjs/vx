import type { TaskRow } from './api.ts'

export interface FlameBar {
  task: TaskRow
  laneIndex: number
  startMs: number
  endMs: number
}

export interface FlameLayout {
  bars: FlameBar[]
  lanes: string[]
  totalDurationMs: number
}

/**
 * Build flamegraph layout from task rows. Each project becomes one
 * lane; tasks position themselves on the lane by wall-clock start
 * (ns relative to run t=0), with fallback to (startedAt - runStartMs)
 * when the ns spans are missing (legacy rows).
 */
export function computeLayout(tasks: TaskRow[]): FlameLayout {
  if (tasks.length === 0) return { bars: [], lanes: [], totalDurationMs: 0 }

  const projects: string[] = []
  const laneByProject = new Map<string, number>()
  for (const t of tasks) {
    if (!laneByProject.has(t.project)) {
      laneByProject.set(t.project, projects.length)
      projects.push(t.project)
    }
  }

  // Prefer the ns-precise spans when present, otherwise fall back to
  // ms timestamps anchored on the earliest startedAt.
  const hasNs = tasks.some((t) => t.wallclockStartNs !== null && t.wallclockEndNs !== null)
  const runStartMs = Math.min(...tasks.map((t) => t.startedAt))

  const bars: FlameBar[] = tasks.map((t) => {
    let startMs: number
    let endMs: number
    if (hasNs && t.wallclockStartNs !== null && t.wallclockEndNs !== null) {
      startMs = Number(BigInt(t.wallclockStartNs) / 1_000_000n)
      endMs = Number(BigInt(t.wallclockEndNs) / 1_000_000n)
    } else {
      startMs = t.startedAt - runStartMs
      endMs = t.endedAt - runStartMs
    }
    return { task: t, laneIndex: laneByProject.get(t.project)!, startMs, endMs }
  })

  const totalDurationMs = Math.max(...bars.map((b) => b.endMs))
  return { bars, lanes: projects, totalDurationMs }
}

export type BarColor = 'ok' | 'cache' | 'err' | 'neutral'

export function colorForTask(t: TaskRow): BarColor {
  if (t.status === 'failed') return 'err'
  if (t.cacheHit === true || t.status === 'cache-hit') return 'cache'
  if (t.status === 'success') return 'ok'
  return 'neutral'
}
