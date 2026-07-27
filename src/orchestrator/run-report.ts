// Markdown run report (`vx run --report=markdown`). A moon-style table —
// one row per task plus a header line of totals — written verbatim to
// stdout after a run so CI can append it to a step summary
// (`vx run ci --report=markdown >> $GITHUB_STEP_SUMMARY`). Pure: the
// run's finished outcomes in, a markdown string out. No ANSI, no live
// region — keep it machine-clean and diffable.

import type { RunResult } from './protocol.js'
import type { OutcomeView } from './events.js'
import { tallyViews, type Tally } from './tally.js'

/**
 * The report header's numbers. The outcome BUCKETS come from the shared
 * `tallyViews` — the same rules the terminal summary and `--summarize` use,
 * so three surfaces describing one run cannot disagree. Only the two
 * durations are report-specific.
 *
 * This used to be a private copy of the partition, and it drifted: it had no
 * group filter (it could not have one — `OutcomeView` had no `isGroup`), so
 * every organizational node was counted as a successful task and rendered as
 * a row claiming `success | miss | 0ms`.
 */
interface ReportTally extends Tally {
  /** Wall-clock ms summed over tasks that actually executed (misses). */
  executedMs: number
  /**
   * Ms of work the cache SKIPPED — the sum of the hits' STORED exec times.
   * Deliberately not `durationMs`, which for a hit is the restore this run
   * paid: summing that reported a 2.01 s task as "6ms saved".
   */
  savedMs: number
}

function tally(outcomes: readonly OutcomeView[]): ReportTally {
  const t: ReportTally = { ...tallyViews(outcomes), executedMs: 0, savedMs: 0 }
  for (const o of outcomes) {
    if (o.isGroup === true) continue
    switch (o.status) {
      case 'success':
      case 'failed':
        t.executedMs += o.durationMs
        break
      case 'cache-hit':
      case 'cache-hit-remote':
        // An outcome that doesn't know what it skipped contributes nothing:
        // better to omit the claim than to substantiate it with the restore
        // cost. (Only reachable across a version skew — every hit this
        // binary produces carries the stored duration.)
        t.savedMs += o.storedDurationMs ?? 0
        break
    }
  }
  return t
}

function statusWord(o: OutcomeView): string {
  switch (o.status) {
    case 'success':
      return 'success'
    case 'cache-hit':
    case 'cache-hit-remote':
      return 'success'
    case 'failed':
      return `failed (exit ${o.exitCode})`
    default:
      return o.status
  }
}

function cacheWord(o: OutcomeView): string {
  switch (o.status) {
    case 'cache-hit':
      return o.restored === false ? 'up-to-date' : 'local'
    case 'cache-hit-remote':
      return o.restored === false ? 'up-to-date' : 'remote'
    case 'success':
    case 'failed':
      return 'miss'
    default:
      return '—'
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * Make a value safe inside a GFM table cell. Task names are arbitrary TS
 * object keys and the loader accepts `|` and newlines, either of which
 * silently breaks the table on the consumer (`>> $GITHUB_STEP_SUMMARY`):
 * a bare pipe adds a column, a newline splits the row.
 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * Render the finished run as a markdown report. A header line of totals
 * followed by a per-task table. Self-contained — everything is derived
 * from the result's outcomes.
 */
export function formatRunReportMarkdown(result: RunResult): string {
  const t = tally(result.outcomes)
  const cached = t.cachedLocal + t.cachedRemote
  const parts = [
    `**${t.total} task${t.total === 1 ? '' : 's'}**`,
    `${t.successful} success`,
    `${t.failed} failed`,
    `${cached} cached`,
  ]
  if (t.skipped > 0) parts.push(`${t.skipped} skipped`)
  if (t.aborted > 0) parts.push(`${t.aborted} aborted`)
  parts.push(`${fmtDuration(t.executedMs)} total`)
  if (t.savedMs > 0) parts.push(`${fmtDuration(t.savedMs)} saved`)

  const lines: string[] = []
  lines.push(`## vx run — ${result.ok ? 'passed' : 'failed'}`)
  lines.push('')
  lines.push(parts.join(' · '))
  lines.push('')
  lines.push('| Task | Status | Cache | Duration |')
  lines.push('| --- | --- | --- | --- |')
  for (const o of result.outcomes) {
    // A group node did no work: no command, no cache decision, 0ms. Rendering
    // one as `success | miss | 0ms` invents a task the user never wrote a
    // command for. Same exclusion the header's tally makes.
    if (o.isGroup === true) continue
    lines.push(
      `| ${cell(o.taskId)} | ${cell(statusWord(o))} | ${cell(cacheWord(o))} | ${cell(
        fmtDuration(o.durationMs),
      )} |`,
    )
  }
  return lines.join('\n') + '\n'
}
