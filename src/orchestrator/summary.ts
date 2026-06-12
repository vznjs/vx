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

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
): string[] {
  const t = tallyOutcomes(outcomes)
  const hits = t.cachedLocal + t.cachedRemote
  const miss = t.total - t.skipped - hits

  // Same language as the live stats line: labeled colored pairs,
  // every bucket always present. Zero-valued buckets render dim so
  // the non-zero numbers are the only things that pull the eye.
  // `Tasks:` partitions by how things ended; `Cache:` by where the
  // results came from (miss + up-to-date + local + remote = total
  // - skipped).
  const pair = (n: number, label: string, color: string, opts: { bold?: boolean } = {}): string =>
    n === 0
      ? paint('', `${n} ${label}`, colors, { dim: true })
      : paint(color, `${n} ${label}`, colors, opts)
  const taskParts = [
    pair(t.failed, 'failed', ERROR, { bold: true }),
    pair(t.successful, 'success', SUCCESS),
    pair(t.skipped, 'skipped', WARN),
    paint(ACCENT, `${t.total} total`, colors),
  ]
  const cacheParts = [
    pair(miss, 'miss', ERROR),
    pair(t.upToDate, 'up-to-date', SUCCESS),
    pair(t.restoredLocal, 'local', WARN),
    pair(t.restoredRemote, 'remote', ACCENT),
  ]

  // vx's own full-cache stamp (owner-picked over the Turbo-shaped
  // `>>> FULL ...` shout): printed when every real task came from
  // the cache — vx executed nothing.
  const fullCache = t.total > 0 && hits === t.total
  const dur = formatDuration(totalMs)
  const timeLine = fullCache
    ? `  Time:    ${dur} ${paint(WARN, '⚡', colors)} ${paint(SUCCESS, 'instant', colors, { bold: true })}`
    : `  Time:    ${dur}`

  const lines: string[] = [
    '',
    ` Tasks:    ${taskParts.join(' · ')}`,
    ` Cache:    ${cacheParts.join(' · ')}`,
  ]

  // Failed-task listing — single `Failed: id1, id2, id3` line, ids
  // bold-red, comma-joined. Mirrors Turbo's run-summary format
  // (turborepo-run-summary/src/execution.rs). Surfaces what failed
  // without needing to scroll back through framed blocks. Skipped
  // tasks are NOT listed separately: they're inferred from the
  // dependency chain on a failed task; listing them would just
  // duplicate the same id under both labels.
  const failedIds = outcomes
    .filter((o) => o.status === 'failed')
    .map((o) => paint(ERROR, o.node.id, colors, { bold: true }))
    .sort()
  if (failedIds.length > 0) {
    lines.push(`Failed:    ${failedIds.join(', ')}`)
  }

  lines.push(timeLine)
  return lines
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
