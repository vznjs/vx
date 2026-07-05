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

function statusCell(t: TaskTelemetry): string {
  // A task that only passed after a retry is flaky by definition — flag it
  // right where it happened, the most actionable place.
  const flaky =
    t.attempts !== undefined && t.attempts > 1 && t.status === 'success'
      ? ` ⚠️ flaky (${t.attempts} attempts)`
      : ''
  switch (t.status) {
    case 'success':
      return `✅ success${flaky}`
    case 'cache-hit':
    case 'cache-hit-remote':
      return '🟦 cache hit'
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

/** Render the run's result as a GitHub-flavored-markdown job summary. */
export function formatGithubSummary(summary: RunSummaryRecord): string {
  const verdict = summary.exitOk ? '✅ passed' : '❌ failed'
  const hits = summary.hitCount
  const executed = summary.taskCount - hits
  const head =
    `### vx run — \`${summary.run.command}\`\n\n` +
    `${verdict} · **${summary.taskCount}** tasks · **${summary.failedCount}** failed · ` +
    `**${hits}** cache hits · **${executed}** executed · ` +
    `${fmtDuration(summary.totalDurationMs)}\n`

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
): Promise<void> {
  try {
    await appendFile(filePath, `\n${formatGithubSummary(summary)}`)
  } catch (err) {
    warn(`[vx] github summary: ${err instanceof Error ? err.message : String(err)}`)
  }
}
