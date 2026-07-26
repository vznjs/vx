// Markdown run report (`vx run --report=markdown`). A moon-style table —
// one row per task plus a header line of totals — written verbatim to
// stdout after a run so CI can append it to a step summary
// (`vx run ci --report=markdown >> $GITHUB_STEP_SUMMARY`). Pure: the
// run's finished outcomes in, a markdown string out. No ANSI, no live
// region — keep it machine-clean and diffable.

import type { RunResult } from './protocol.js'
import type { OutcomeView } from './events.js'

/**
 * Outcome buckets for the report header. Mirrors the terminal summary's
 * `tallyOutcomes` partition (success counts hits; `aborted` is no work
 * and excluded), but derives from the serializable `OutcomeView` the CLI
 * holds after a run rather than the in-process `TaskOutcome` — so it
 * needs no graph back-ref and stays self-contained here.
 */
interface ReportTally {
  total: number
  successful: number
  failed: number
  skipped: number
  cached: number
  /** Wall-clock ms summed over tasks that actually executed (misses). */
  executedMs: number
  /** Wall-clock ms summed over cache hits — the work the cache skipped. */
  savedMs: number
}

function tally(outcomes: readonly OutcomeView[]): ReportTally {
  const t: ReportTally = {
    total: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    cached: 0,
    executedMs: 0,
    savedMs: 0,
  }
  for (const o of outcomes) {
    // A child killed by a shutdown signal (Ctrl-C teardown) is no work —
    // excluded from totals and every bucket, like the terminal tally.
    if (o.status === 'aborted') continue
    t.total++
    switch (o.status) {
      case 'success':
        t.successful++
        t.executedMs += o.durationMs
        break
      case 'cache-hit':
      case 'cache-hit-remote':
        t.successful++
        t.cached++
        t.savedMs += o.durationMs
        break
      case 'failed':
        t.failed++
        t.executedMs += o.durationMs
        break
      case 'skipped':
        t.skipped++
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
  const parts = [
    `**${t.total} task${t.total === 1 ? '' : 's'}**`,
    `${t.successful} success`,
    `${t.failed} failed`,
    `${t.cached} cached`,
  ]
  if (t.skipped > 0) parts.push(`${t.skipped} skipped`)
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
    if (o.status === 'aborted') continue
    lines.push(
      `| ${cell(o.taskId)} | ${cell(statusWord(o))} | ${cell(cacheWord(o))} | ${cell(
        fmtDuration(o.durationMs),
      )} |`,
    )
  }
  return lines.join('\n') + '\n'
}
