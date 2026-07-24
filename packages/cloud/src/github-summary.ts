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
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'

/** Cap the table so a pathological monorepo run can't blow GHA's ~1 MiB limit. */
const MAX_ROWS = 100

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
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

function statusCell(t: TaskTelemetry): string {
  // A task that only passed after a retry is flaky by definition — flag it
  // right where it happened, the most actionable place.
  const flaky =
    t.attempts !== undefined && t.attempts > 1 && t.status === 'success'
      ? ` ⚠️ flaky (${t.attempts} attempts)`
      : ''
  const verify = verifyMarker(t)
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
    default:
      return `❌ failed (exit ${t.exitCode})`
  }
}

function cacheCell(t: TaskTelemetry): string {
  switch (t.cacheSource) {
    case 'local':
      return 'local'
    case 'remote':
      return 'remote'
    case 'miss':
      return 'miss'
    default:
      return '—'
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

export interface GithubSummaryOptions {
  /** Deep link to this run in the connected dashboard (DX-2): rendered as a
   *  prominent link right under the verdict, so a red check is ONE click from
   *  the run's logs + artifacts. Absent (no connection) → no link line. */
  dashboardUrl?: string
}

/** Render the run's result as a GitHub-flavored-markdown job summary. */
export function formatGithubSummary(
  summary: RunSummaryRecord,
  opts: GithubSummaryOptions = {},
): string {
  const verdict = summary.exitOk ? '✅ passed' : '❌ failed'
  const hits = summary.hitCount
  const executed = summary.taskCount - hits
  const dashboardLine =
    opts.dashboardUrl !== undefined
      ? `\n▸ [Open this run in the vx dashboard](${opts.dashboardUrl})\n`
      : ''
  const head =
    `### vx run — \`${summary.run.command}\`\n\n` +
    `${verdict} · **${summary.taskCount}** tasks · **${summary.failedCount}** failed · ` +
    `**${hits}** cache hits · **${executed}** executed · ` +
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
    ...shown.map(
      (t) =>
        `| \`${t.taskId}\` | ${statusCell(t)} | ${fmtDuration(t.durationMs)} | ${cacheCell(t)} |`,
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
