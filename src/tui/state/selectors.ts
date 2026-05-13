// Pure selectors over `State`. Each view reads what it needs as a
// fresh value; the renderer never inspects the Map directly.

import type { State, TaskRow } from './store.js'

const FINISHED = new Set<TaskRow['status']>([
  'success',
  'cache-hit',
  'cache-hit-remote',
  'failed',
  'skipped',
])

export function selectParallelPct(state: State): number {
  if (state.concurrency === 0) return 0
  const busy = state.workerSlots.filter((s) => s.taskId !== null).length
  return Math.floor((busy / state.concurrency) * 100)
}

export function selectReadyQueue(state: State): TaskRow[] {
  const out: TaskRow[] = []
  for (const row of state.tasks.values()) {
    if (row.status !== 'waiting') continue
    if (allDepsFinishedOk(state, row)) out.push(row)
  }
  return out
}

export function selectBlockedQueue(state: State): TaskRow[] {
  const out: TaskRow[] = []
  for (const row of state.tasks.values()) {
    if (row.status !== 'waiting') continue
    if (!allDepsFinishedOk(state, row)) out.push(row)
  }
  return out
}

/** Top N tasks by dependentsCount among the not-yet-finished set. */
export function selectTopBlockers(state: State, n = 5): TaskRow[] {
  const live: TaskRow[] = []
  for (const row of state.tasks.values()) {
    if (FINISHED.has(row.status)) continue
    live.push(row)
  }
  live.sort((a, b) => b.dependentsCount - a.dependentsCount)
  return live.slice(0, n)
}

/**
 * Live during the run: each running task whose elapsed exceeds
 * 1.5× its history avg. `nowMs` is the caller's wallclock-now
 * relative to the run start, in ms.
 */
export function selectSlowVsHistory(state: State, nowMs: number): TaskRow[] {
  const out: TaskRow[] = []
  for (const row of state.tasks.values()) {
    if (row.status !== 'running') continue
    const hist = state.history.get(row.id)
    if (!hist || hist.avgMs <= 0) continue
    if (nowMs > hist.avgMs * 1.5) out.push(row)
  }
  // Slowest first by ratio.
  out.sort((a, b) => {
    const ra = nowMs / (state.history.get(a.id)?.avgMs ?? 1)
    const rb = nowMs / (state.history.get(b.id)?.avgMs ?? 1)
    return rb - ra
  })
  return out
}

/**
 * Tasks that probed a cache miss and have history (so we know what the
 * miss is going to cost). Ranked by predicted duration desc.
 */
export function selectCacheMissImpact(state: State): TaskRow[] {
  const out: TaskRow[] = []
  for (const row of state.tasks.values()) {
    if (row.cacheStatus !== 'miss') continue
    const hist = state.history.get(row.id)
    if (!hist) continue
    out.push(row)
  }
  out.sort((a, b) => {
    const da = state.history.get(a.id)?.avgMs ?? 0
    const db = state.history.get(b.id)?.avgMs ?? 0
    return db - da
  })
  return out
}

function allDepsFinishedOk(state: State, row: TaskRow): boolean {
  for (const d of row.deps) {
    const dep = state.tasks.get(d)
    if (!dep) return false
    if (
      dep.status !== 'success' &&
      dep.status !== 'cache-hit' &&
      dep.status !== 'cache-hit-remote'
    ) {
      return false
    }
  }
  return true
}
