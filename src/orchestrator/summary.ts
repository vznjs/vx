// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts come from the
// shared `tallyOutcomes` helper, which excludes group tasks — they
// aren't real work and would inflate "N total" misleadingly.

import type { TaskOutcome } from '../graph/scheduler.js'
import { paint, type ColorSupport } from './colors.js'
import { tallyOutcomes } from './tally.js'

const NO_COLOR: ColorSupport = { enabled: false }

const SUCCESS = '#22c55e'
const WARN = '#eab308'
const ERROR = '#ef4444'

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
): string[] {
  const t = tallyOutcomes(outcomes)
  const cached = t.cachedLocal + t.cachedRemote

  const taskParts = [paint(SUCCESS, `${t.successful} successful`, colors)]
  if (t.failed > 0) taskParts.push(paint(ERROR, `${t.failed} failed`, colors, { bold: true }))
  if (t.skipped > 0) taskParts.push(paint(WARN, `${t.skipped} skipped`, colors))
  taskParts.push(`${t.total} total`)

  const cachedParts: string[] = []
  if (t.cachedLocal > 0) cachedParts.push(`${t.cachedLocal} local`)
  if (t.cachedRemote > 0) cachedParts.push(`${t.cachedRemote} remote`)
  if (cachedParts.length === 0) cachedParts.push('0 cached')
  cachedParts.push(`${t.total} total`)

  // Motif printed when every real task came from the cache (local or
  // remote). Mirrors Turbo's `>>> FULL TURBO`.
  const fullCache = t.total > 0 && cached === t.total
  const dur = formatDuration(totalMs)
  const timeLine = fullCache
    ? `  Time:    ${dur} ${paint(SUCCESS, '>>> FULL CACHE', colors, { bold: true })}`
    : `  Time:    ${dur}`

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
