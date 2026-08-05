// GitHub Actions job-summary emitter (road-to-best-CI #3). Pure cloud glue:
// when a `vx run` executes inside GitHub Actions (`GITHUB_STEP_SUMMARY` names a
// markdown file the runner renders on the job page), append a per-task result
// table so a red build tells you WHICH task failed without opening the raw log.
//
// Formatted from the canonical RunSummaryRecord (the shape the cloud telemetry
// sink already has), so it needs NO connection — it works for any CI run that
// declares `cloud()`, whether or not a serve is attached. Never-fail: a write
// error is swallowed + warned, exactly like the ingest push.

import { appendFile } from 'node:fs/promises'
import { escapeMarkdownCell, isCacheHit, type RunSummaryRecord, type TaskTelemetry } from '@vzn/vx'

/** Cap the table so a pathological monorepo run can't blow GHA's ~1 MiB limit. */
const MAX_ROWS = 100

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  // Round to whole seconds FIRST, then split. Rounding the remainder
  // independently of the minutes carries wrong: at 119_500ms the old form
  // rendered `1m 60s`, and at 3_599_600ms `59m 60s` — a nonsense duration on
  // the job page for any run whose remainder rounds up to a full minute.
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`
}

interface HeadCounts {
  total: number
  executed: number
  hits: number
  skipped: number
  aborted: number
  failed: number
}

/**
 * Bucket the run ONCE from the task statuses.
 *
 * The headline used to derive `executed` as `taskCount - hitCount`, and
 * `taskCount` is `tasks.length` — which INCLUDES skipped tasks. So every
 * skipped task was counted as executed, and the default `--continue=deps-ok`
 * skips every dependent of a failed task: the overstatement was largest on
 * exactly the red runs someone opens this summary to read. Measured on one
 * broken leaf with three dependents, the head claimed `5 executed` for the 2
 * that ran, while the terminal for the same run reported `skipped=3`.
 *
 * Buckets match core's `tally.ts` — a hit is not an execution, and an aborted
 * task joins no bucket and no total (it was killed by a teardown signal, so
 * counting it as work is a claim about work that never happened). That also
 * makes the head agree with the table below, which already drops aborted.
 */
function headCounts(tasks: readonly TaskTelemetry[]): HeadCounts {
  const c: HeadCounts = { total: 0, executed: 0, hits: 0, skipped: 0, aborted: 0, failed: 0 }
  for (const t of tasks) {
    if (t.status === 'aborted') {
      c.aborted++
      continue
    }
    c.total++
    if (t.status === 'failed') c.failed++
    // `isCacheHit` rather than a local Set of status literals: a Set has no
    // compile-time tripwire when the union gains a member.
    if (isCacheHit(t.status)) c.hits++
    else if (t.status === 'skipped') c.skipped++
    else c.executed++
  }
  return c
}

/** The `--verify` verdict marker appended to a task's status cell. A
 *  non-deterministic task is unsafe to cache — flag it right on the job page,
 *  naming the diverging outputs. Silent for hits / no-outputs / non-verify runs. */
function verifyMarker(t: TaskTelemetry): string {
  const v = t.verify
  if (v === undefined) return ''
  switch (v.kind) {
    case 'proven-deterministic':
    case 'proven-complete':
      return ' 🔒 verified'
    case 'nondeterministic':
      return ` ⚠️ non-deterministic (${changedPreview(v.changed)})`
    case 'undeclared-inputs':
      return ` ⚠️ undeclared inputs (${changedPreview(v.paths)})`
    case 'allowed-nondeterministic':
      return ' ⚠️ non-deterministic (allowed)'
    case 'rerun-failed':
      return ` ⚠️ verify re-run failed (exit ${v.exitCode})`
    default:
      return '' // no-outputs / not-verified — nothing actionable per-row
  }
}

/** First few diverging output paths, truncated so the cell stays compact. */
function changedPreview(changed: readonly string[]): string {
  const head = changed.slice(0, 3).join(', ')
  return changed.length > 3 ? `${head}, +${changed.length - 3} more` : head
}

function statusCell(t: TaskTelemetry, opts: GithubSummaryOptions = {}): string {
  // A task that only passed after a retry is flaky by definition — flag it
  // right where it happened, the most actionable place.
  const flaky =
    t.attempts !== undefined && t.attempts > 1 && t.status === 'success'
      ? ` ⚠️ flaky (${t.attempts} attempts)`
      : ''
  const verify = verifyMarker(t)
  // The old catch-all rendered any status this switch did not name as
  // `❌ failed (exit undefined)` — so a seventh `TaskStatus` would have read
  // as a FAILURE on the PR page. The `never` binding makes adding one a
  // compile error here (the tripwire a bare `default` swallowed), while the
  // arm still returns a value: this is an observability surface, so an
  // impossible status must degrade to naming itself, not crash the summary.
  switch (t.status) {
    case 'success':
      return `✅ success${flaky}${verify}`
    case 'cache-hit':
    case 'cache-hit-remote':
      return `🟦 cache hit${verify}`
    case 'skipped':
      return '⚪ skipped'
    case 'aborted':
      return '⏹ aborted'
    case 'failed':
      return `❌ failed (exit ${t.exitCode})${triageMarker(t, opts)}`
    default: {
      const unknown: never = t.status
      return `⚪ ${String(unknown)}`
    }
  }
}

/** Exhaustive over `CacheSource` for the same reason as `statusCell`. */
function cacheCell(t: TaskTelemetry): string {
  switch (t.cacheSource) {
    case 'local':
      return 'local'
    case 'remote':
      return 'remote'
    case 'miss':
      return 'miss'
    case 'none':
      return '—'
    default: {
      const unknown: never = t.cacheSource
      return String(unknown)
    }
  }
}

/** A one-line hermeticity headline for a `--verify` run (empty otherwise):
 *  how many tasks proved deterministic vs how many are unsafe to cache. */
function hermeticityLine(tasks: readonly TaskTelemetry[]): string {
  let proven = 0
  let bad = 0
  let allowed = 0
  for (const t of tasks) {
    switch (t.verify?.kind) {
      case 'proven-deterministic':
      case 'proven-complete':
        proven++
        break
      case 'nondeterministic':
      case 'rerun-failed':
      case 'undeclared-inputs':
        bad++
        break
      case 'allowed-nondeterministic':
        allowed++
        break
    }
  }
  if (proven + bad + allowed === 0) return '' // not a --verify run
  const icon = bad > 0 ? '⚠️' : '🔒'
  const allowedPart = allowed > 0 ? ` · **${allowed}** allowed` : ''
  return `\n${icon} Hermeticity: **${proven}** proven · **${bad}** unsafe${allowedPart}\n`
}

/** One failed task's triage verdict, as fetched from `/v1/triage/:runId` —
 *  the "is this failure mine?" classification the run-detail card shows,
 *  carried onto the PR page (dev-scenarios S3 follow-up). */
export interface GithubTriageVerdict {
  verdict: 'flaky' | 'pre-existing' | 'new-failure'
  /** Green runs of this exact cache key elsewhere (the flaky evidence). */
  sameKeySuccesses: number
  /** This run changed the task's inputs vs its previous run (null = no prior). */
  keyChanged: boolean | null
}

export interface GithubSummaryOptions {
  /** Deep link to this run in the connected dashboard (DX-2): rendered as a
   *  prominent link right under the verdict, so a red check is ONE click from
   *  the run's logs + artifacts. Absent (no connection) → no link line. */
  dashboardUrl?: string
  /** Per-taskId triage verdicts for FAILED tasks (only failed rows consult
   *  this). Absent — no connection, fetch failed, or a green run — renders
   *  byte-identically to before. */
  triage?: ReadonlyMap<string, GithubTriageVerdict>
}

/** The triage marker appended to a failed task's status cell — the PR page's
 *  one-glance answer to "is this failure mine?". Only the failed branch of
 *  `statusCell` consults it. */
function triageMarker(t: TaskTelemetry, opts: GithubSummaryOptions): string {
  const v = opts.triage?.get(t.taskId)
  if (v === undefined) return ''
  switch (v.verdict) {
    case 'flaky':
      return ` 🎲 flaky — not this change (same key passed ${v.sameKeySuccesses}×)`
    case 'pre-existing':
      return ' 📌 already broken on the default branch'
    case 'new-failure':
      return v.keyChanged === true
        ? ' 🆕 new failure — this run changed its inputs'
        : ' 🆕 new failure'
    default:
      // The verdict comes off the wire unvalidated — a newer serve's unknown
      // verdict must render as a plain failed cell, not a literal "undefined".
      return ''
  }
}

/** Render the run's result as a GitHub-flavored-markdown job summary. */
export function formatGithubSummary(
  summary: RunSummaryRecord,
  opts: GithubSummaryOptions = {},
): string {
  const verdict = summary.exitOk ? '✅ passed' : '❌ failed'
  const c = headCounts(summary.tasks)
  const dashboardLine =
    opts.dashboardUrl !== undefined
      ? `\n▸ [Open this run in the vx dashboard](${opts.dashboardUrl})\n`
      : ''
  // Skipped and aborted are named only when non-zero — a green run's headline
  // stays as short as it was — but they are never folded into another bucket:
  // the whole defect was a count that absorbed tasks which did not run.
  const stats = [
    `**${c.total}** tasks`,
    `**${c.failed}** failed`,
    `**${c.hits}** cache hits`,
    `**${c.executed}** executed`,
  ]
  if (c.skipped > 0) stats.push(`**${c.skipped}** skipped`)
  if (c.aborted > 0) stats.push(`**${c.aborted}** aborted`)
  const head =
    `### vx run — \`${escapeMarkdownCell(summary.run.command)}\`\n\n` +
    `${verdict} · ${stats.join(' · ')} · ` +
    `${fmtDuration(summary.totalDurationMs)}\n` +
    dashboardLine +
    hermeticityLine(summary.tasks)

  // Failures first (the thing you opened the summary to find), then the rest in
  // their given order; aborted tasks are teardown noise — drop them.
  const rows = summary.tasks
    .filter((t) => t.status !== 'aborted')
    .slice()
    .sort((a, b) => (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1))
  const shown = rows.slice(0, MAX_ROWS)

  const table = [
    '',
    '| Task | Status | Duration | Cache |',
    '| --- | --- | ---: | --- |',
    // Every cell is escaped. Task names are arbitrary TS object keys and the
    // loader charset-validates neither half of a taskId, and a `--verify`
    // marker carries real output PATHS — a `|` in any of them adds a column
    // (shifting Status/Duration/Cache one right) and a newline splits the row
    // in two, so a name could inject an entire fabricated row.
    ...shown.map(
      (t) =>
        `| \`${escapeMarkdownCell(t.taskId)}\` | ${escapeMarkdownCell(statusCell(t, opts))} | ` +
        `${fmtDuration(t.durationMs)} | ${cacheCell(t)} |`,
    ),
  ].join('\n')

  const more =
    rows.length > shown.length ? `\n\n_… ${rows.length - shown.length} more tasks not shown._` : ''
  return `${head}${table}${more}\n`
}

/** Append the run summary to the GitHub Actions job-summary file. Never throws. */
export async function appendGithubSummary(
  filePath: string,
  summary: RunSummaryRecord,
  warn: (message: string) => void,
  opts: GithubSummaryOptions = {},
): Promise<void> {
  try {
    await appendFile(filePath, `\n${formatGithubSummary(summary, opts)}`)
  } catch (err) {
    warn(`[vx] github summary: ${err instanceof Error ? err.message : String(err)}`)
  }
}
