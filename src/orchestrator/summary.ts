// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts include only
// real (exec-having) tasks — group nodes are filtered upstream.

import type { TaskOutcome } from '../graph/scheduler.js'

export function formatRunSummary(outcomes: readonly TaskOutcome[], totalMs: number): string[] {
  const total = outcomes.length
  const success = outcomes.filter(
    (o) => o.status === 'success' || o.status === 'cache-hit' || o.status === 'cache-hit-remote',
  ).length
  const failed = outcomes.filter((o) => o.status === 'failed').length
  const skipped = outcomes.filter((o) => o.status === 'skipped').length
  const local = outcomes.filter((o) => o.status === 'cache-hit').length
  const remote = outcomes.filter((o) => o.status === 'cache-hit-remote').length
  const cached = local + remote

  const taskParts = [`${success} successful`]
  if (failed > 0) taskParts.push(`${failed} failed`)
  if (skipped > 0) taskParts.push(`${skipped} skipped`)
  taskParts.push(`${total} total`)

  const cachedParts: string[] = []
  if (local > 0) cachedParts.push(`${local} local`)
  if (remote > 0) cachedParts.push(`${remote} remote`)
  if (cachedParts.length === 0) cachedParts.push('0 cached')
  cachedParts.push(`${total} total`)

  // Motif printed when every real task came from the cache (local or
  // remote). Mirrors Turbo's `>>> FULL TURBO`.
  const fullCache = total > 0 && cached === total
  const timeLine = fullCache
    ? `  Time:    ${formatDuration(totalMs)} >>> FULL CACHE`
    : `  Time:    ${formatDuration(totalMs)}`

  return [
    '',
    ` Tasks:    ${taskParts.join(', ')}`,
    `Cached:    ${cachedParts.join(', ')}`,
    timeLine,
  ]
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
