// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts come from the
// shared `tallyOutcomes` helper, which excludes group tasks — they
// aren't real work and would inflate "N total" misleadingly.

import type { TaskOutcome } from '../graph/index.js'
import { paint, type ColorSupport } from './colors.js'
import { tallyOutcomes } from './tally.js'

const NO_COLOR: ColorSupport = { enabled: false }

const SUCCESS = '#22c55e'
const WARN = '#eab308'
const ACCENT = '#06b6d4'
const ERROR = '#ef4444'

/** Label column: name + dim dot leaders, value starts at one column. */
const LEADER_WIDTH = 15
const RULE = `\u2500 vx ${'\u2500'.repeat(38)}`

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
): string[] {
  const t = tallyOutcomes(outcomes)
  const hits = t.cachedLocal + t.cachedRemote
  const miss = t.total - t.skipped - hits

  // Mission-readout summary (owner-picked design): dim dotted
  // leaders, colored values, only non-zero buckets — the final
  // report is static, so zero-suppression reads cleaner than the
  // live line's fixed layout.
  const dim = (txt: string) => paint('', txt, colors, { dim: true })
  const row = (label: string, value: string): string =>
    `  ${dim(label + ' ' + '\u00b7'.repeat(Math.max(1, LEADER_WIDTH - label.length - 1)))} ${value}`
  const join = (parts: string[]): string => parts.join(` ${dim('\u00b7')} `)

  const taskParts: string[] = []
  if (t.failed > 0) taskParts.push(paint(ERROR, `${t.failed} failed`, colors, { bold: true }))
  if (t.successful > 0) taskParts.push(paint(SUCCESS, `${t.successful} success`, colors))
  if (t.skipped > 0) taskParts.push(paint(WARN, `${t.skipped} skipped`, colors))
  if (taskParts.length === 0) taskParts.push(dim('0 tasks'))

  const cacheParts: string[] = []
  if (miss > 0) cacheParts.push(paint(ERROR, `${miss} miss`, colors))
  if (t.upToDate > 0) cacheParts.push(paint(SUCCESS, `${t.upToDate} up-to-date`, colors))
  if (t.restoredLocal > 0) cacheParts.push(paint(WARN, `${t.restoredLocal} local`, colors))
  if (t.restoredRemote > 0) cacheParts.push(paint(ACCENT, `${t.restoredRemote} remote`, colors))

  // vx's own full-cache stamp (owner-picked over the Turbo-shaped
  // `>>> FULL ...` shout): every real task came from the cache —
  // vx executed nothing.
  const fullCache = t.total > 0 && hits === t.total
  const dur = formatDuration(totalMs)
  const time = fullCache
    ? `${dur} ${paint(WARN, '\u26a1', colors)} ${paint(SUCCESS, 'instant', colors, { bold: true })}`
    : dur

  const lines: string[] = ['', dim(RULE), row('tasks', join(taskParts))]
  const failedIds = outcomes
    .filter((o) => o.status === 'failed')
    .map((o) => paint(ERROR, o.node.id, colors, { bold: true }))
    .sort()
  if (failedIds.length > 0) lines.push(row('failed', failedIds.join(', ')))
  if (cacheParts.length > 0) lines.push(row('cache', join(cacheParts)))
  lines.push(row('time', time))
  return lines
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
