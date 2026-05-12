// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts include group
// tasks (no `exec`) — they're nodes the user wrote.

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

  const taskParts = [`${success} successful`]
  if (failed > 0) taskParts.push(`${failed} failed`)
  if (skipped > 0) taskParts.push(`${skipped} skipped`)
  taskParts.push(`${total} total`)

  const cachedParts: string[] = []
  if (local > 0) cachedParts.push(`${local} local`)
  if (remote > 0) cachedParts.push(`${remote} remote`)
  if (cachedParts.length === 0) cachedParts.push('0 cached')
  cachedParts.push(`${total} total`)

  return [
    '',
    ` Tasks:    ${taskParts.join(', ')}`,
    `Cached:    ${cachedParts.join(', ')}`,
    `  Time:    ${formatDuration(totalMs)}`,
  ]
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
