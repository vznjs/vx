// Pure markdown rendering: RunSummaryRecord -> a GitHub Actions job summary.
// Purpose-built for the job-summary surface (verdict headline, stats line,
// failures called out above the table) rather than reusing core's
// `--report=markdown` table — a job summary is a landing page, not a cell
// grid. `escapeMarkdownCell` comes from core's façade: task names are the
// same unvalidated strings core renders, and the old cloud job summary
// shipped without the escape once already.
import {
  escapeMarkdownCell,
  exitSignal,
  isCacheHit,
  isPassStatus,
  type RunSummaryRecord,
  type TaskTelemetry,
} from '@vzn/vx'

const STATUS_LABEL: Record<string, string> = {
  success: '✅ ran',
  'cache-hit': '⚡ restored',
  'cache-hit-remote': '☁️ restored remote',
  failed: '❌ failed',
  skipped: '⏭️ skipped',
  aborted: '🛑 aborted',
}

// Rounded once, then split: rounding the remainder after flooring the
// minutes printed 119.7 s as `1m 60s`. The tier is chosen by the rounded
// value: 59.96 s printed `60.0s` and 999.6 ms `1000ms` (F-51).
function fmtMs(ms: number): string {
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`
  if (Math.round(ms / 100) < 600) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function statusLabel(t: TaskTelemetry): string {
  // A hit that found its outputs in place restored nothing: up to date,
  // whichever layer answered, as vx's own summary says it.
  if (isCacheHit(t.status) && t.restored !== true) return '✔️ up-to-date'
  return STATUS_LABEL[t.status] ?? t.status
}

/** `(3 up-to-date, 2 restored)`, with the remote share when any came from there. */
function hitSplit(s: RunSummaryRecord): string {
  const restored = s.restoredLocalCount + s.restoredRemoteCount
  const remote = s.restoredRemoteCount > 0 ? `, ${s.restoredRemoteCount} from remote` : ''
  return `(${s.upToDateCount} up-to-date, ${restored} restored${remote})`
}

/**
 * GitHub caps a step's job summary at 1 MiB and REJECTS the upload past it,
 * so an unbounded summary costs the whole page rather than its tail. At the
 * measured ~55 bytes a row that is about 19 000 tasks — a scale this repo's
 * own bench generates (5 000 projects × four tasks), so it is reachable
 * rather than theoretical. Cut from the END: the verdict, the stats line and
 * the Failures section are rendered first, and they are what a reader needs.
 * The cap is the step's whole file, so the room is what other writers in
 * the step have left (F-42).
 */
export const MAX_JOB_SUMMARY_BYTES = 1024 * 1024

export function clampJobSummary(markdown: string, room = MAX_JOB_SUMMARY_BYTES): string {
  return truncateUtf8(
    markdown,
    room,
    '\n\n…truncated by @vzn/vx-ci (GitHub caps a job summary at 1 MiB)\n',
  )
}

/** Cuts `text` to `maxBytes` of UTF-8, `suffix` included, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number, suffix: string): string {
  // The cap is BYTES, and the page is not ASCII: every status label is an
  // emoji (4 bytes, 2 UTF-16 units) and every separator a `·` or a `—`
  // (2 and 3 bytes, 1 unit). Measured in `.length`, a clamped page of those
  // rows came out past 1 MiB and GitHub refused it whole (item 806). A unit
  // is at most 3 bytes, so a short page skips the encode.
  if (text.length * 3 <= maxBytes) return text
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return text
  let end = maxBytes - new TextEncoder().encode(suffix).byteLength
  if (end <= 0) return ''
  // Back up off a continuation byte, so the cut never splits a character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end)) + suffix
}

/**
 * A task id as inline markdown: `a#*x*` rendered as `a#` and an italic
 * `x` (item 1058). Table cells escape their pipes on top of this.
 */
function escapeInline(s: string): string {
  return s.replace(/[\\`*_[\]<>]/g, '\\$&')
}

/**
 * A code span that holds any text: its fence is one backtick longer than
 * the longest run inside, padded when the text starts or ends with one.
 * The footer cell-escaped the command instead, which is for tables: a `|`
 * showed as `\|`, and a backtick ended the span early (item 1058).
 */
function codeSpan(raw: string): string {
  // A lone CR is a line ending too (CommonMark), and broke the span (F-51).
  const s = raw.replace(/\r\n?|\n/g, ' ')
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(longest + 1)
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${s}${pad}${fence}`
}

/** Render the whole job summary. Deterministic for a given record. */
export function renderJobSummary(summary: RunSummaryRecord, title = 'vx run'): string {
  const failed = summary.tasks.filter((t) => t.status === 'failed')
  const cancelled = !summary.exitOk && summary.failedCount === 0 && summary.abortedCount > 0
  const verdict = summary.exitOk ? '✅' : cancelled ? '⏹️' : '❌'
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
      (summary.hitCount > 0 ? ` ${hitSplit(summary)}` : ''),
    ...(summary.failedCount > 0 ? [`**${summary.failedCount}** failed`] : []),
    ...(summary.abortedCount > 0 ? [`**${summary.abortedCount}** aborted`] : []),
    fmtMs(summary.totalDurationMs),
  ]
  lines.push(stats.join(' · '))
  lines.push('')

  if (failed.length > 0) {
    // What each failure cost: the tasks that never started because of it
    // (the record's `blockedBy` names the root of each block). Grouped once:
    // a scan of every task per failure took 1.3 s for 10 000 failures of
    // 20 000 tasks (F-38).
    const blockedBy = new Map<string, string[]>()
    for (const s of summary.tasks) {
      if (s.status !== 'skipped' || s.blockedBy === undefined) continue
      const list = blockedBy.get(s.blockedBy)
      const id = escapeMarkdownCell(escapeInline(s.taskId))
      if (list === undefined) blockedBy.set(s.blockedBy, [id])
      else list.push(id)
    }
    lines.push('### Failures')
    lines.push('')
    for (const t of failed) {
      // The signal an exit above 128 stands for, as the frame and `vx last`
      // say it (the shell's convention, so a command exiting 137 on its
      // own reads the same).
      const signal = exitSignal(t.exitCode)
      const blocked = blockedBy.get(t.taskId) ?? []
      lines.push(
        `- **${escapeMarkdownCell(escapeInline(t.taskId))}** — ${t.notReady !== undefined ? `never ready (${t.notReady === 'timeout' ? 'timed out' : t.notReady === 'exited' ? 'exited' : 'spawn failed'}), exit ${t.exitCode}` : t.timedOut === true ? `timed out, exit ${t.exitCode}` : `exit ${t.exitCode}${signal === undefined ? '' : ` (128 + ${signal})`}`}${t.sandboxViolations !== undefined && t.sandboxViolations > 0 ? ` · ${t.sandboxViolations} sandbox violation${t.sandboxViolations === 1 ? '' : 's'}` : ''}${blocked.length > 0 ? ` · blocked ${blocked.join(', ')}` : ''}`,
      )
    }
    lines.push('')
  }

  const header = ['Task', 'Status', 'Duration']
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`|${header.map(() => ' --- ').join('|')}|`)
  // Failures first (the eye lands on the table's top rows), then execution
  // order as delivered.
  const ordered = [...failed, ...summary.tasks.filter((t) => t.status !== 'failed')]
  for (const t of ordered) {
    const cells = [escapeMarkdownCell(escapeInline(t.taskId)), statusLabel(t), fmtMs(t.durationMs)]
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('')

  // A one-line footer so a page with several vx runs stays attributable.
  // `restored` counts only the hits that wrote outputs; it once counted
  // every hit, up-to-date ones included.
  const restored = summary.restoredLocalCount + summary.restoredRemoteCount
  const passed = summary.tasks.filter((t) => isPassStatus(t.status)).length
  lines.push(
    `<sub>vx ${summary.run.vxVersion} · ${codeSpan(summary.run.command)} · ${passed}/${summary.taskCount} passed · ${summary.upToDateCount} up-to-date · ${restored} restored</sub>`,
  )
  lines.push('')
  return lines.join('\n')
}
