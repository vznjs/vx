// Pure markdown rendering: RunSummaryRecord -> a GitHub Actions job summary.
// Purpose-built for the job-summary surface (verdict headline, stats line,
// failures called out above the table) rather than reusing core's
// `--report=markdown` table — a job summary is a landing page, not a cell
// grid. `escapeMarkdownCell` comes from core's façade: task names are the
// same unvalidated strings core renders, and the old cloud job summary
// shipped without the escape once already.
import {
  escapeMarkdownCell,
  isCacheHit,
  isPassStatus,
  type RunSummaryRecord,
  type TaskTelemetry,
} from '@vzn/vx'

const STATUS_LABEL: Record<string, string> = {
  success: '✅ ran',
  'cache-hit': '⚡ cache',
  'cache-hit-remote': '☁️ remote cache',
  failed: '❌ failed',
  skipped: '⏭️ skipped',
  aborted: '🛑 aborted',
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms - m * 60_000) / 1000)}s`
}

function statusLabel(t: TaskTelemetry): string {
  return STATUS_LABEL[t.status] ?? t.status
}

/** Render the whole job summary. Deterministic for a given record. */
export function renderJobSummary(summary: RunSummaryRecord, title = 'vx run'): string {
  const failed = summary.tasks.filter((t) => t.status === 'failed')
  const verdict = summary.exitOk ? '✅' : '❌'
  const lines: string[] = []
  lines.push(`## ${verdict} ${title}`)
  lines.push('')
  const executed = summary.tasks.filter(
    (t) => t.status === 'success' || t.status === 'failed',
  ).length
  const stats = [
    `**${summary.taskCount}** task${summary.taskCount === 1 ? '' : 's'}`,
    `**${executed}** executed`,
    `**${summary.hitCount}** cache hit${summary.hitCount === 1 ? '' : 's'}` +
      (summary.hitRemoteCount > 0 ? ` (${summary.hitRemoteCount} remote)` : ''),
    ...(summary.failedCount > 0 ? [`**${summary.failedCount}** failed`] : []),
    fmtMs(summary.totalDurationMs),
  ]
  lines.push(stats.join(' · '))
  lines.push('')

  if (failed.length > 0) {
    lines.push('### Failures')
    lines.push('')
    for (const t of failed) {
      lines.push(`- **${escapeMarkdownCell(t.taskId)}** — exit ${t.exitCode}`)
    }
    lines.push('')
  }

  const anyVerify = summary.tasks.some((t) => t.verify !== undefined)
  const header = ['Task', 'Status', 'Duration', ...(anyVerify ? ['Verify'] : [])]
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`|${header.map(() => ' --- ').join('|')}|`)
  // Failures first (the eye lands on the table's top rows), then execution
  // order as delivered.
  const ordered = [...failed, ...summary.tasks.filter((t) => t.status !== 'failed')]
  for (const t of ordered) {
    const cells = [
      escapeMarkdownCell(t.taskId),
      statusLabel(t),
      fmtMs(t.durationMs),
      ...(anyVerify ? [t.verify === undefined ? '' : escapeMarkdownCell(verifyLabel(t))] : []),
    ]
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('')

  // A one-line footer so a page with several vx runs stays attributable.
  const hits = summary.tasks.filter((t) => isCacheHit(t.status)).length
  const passed = summary.tasks.filter((t) => isPassStatus(t.status)).length
  lines.push(
    `<sub>vx ${summary.run.vxVersion} · \`${escapeMarkdownCell(summary.run.command)}\` · ${passed}/${summary.taskCount} passed · ${hits} restored</sub>`,
  )
  lines.push('')
  return lines.join('\n')
}

function verifyLabel(t: TaskTelemetry): string {
  return t.verify?.kind ?? ''
}
