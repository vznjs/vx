// Pure markdown rendering: RunSummaryRecord -> a GitHub Actions job summary.
// A job summary is a landing page (verdict headline, stats line, failures
// called out above the table), not a cell grid.
import {
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
/** Bytes as gigabytes, one decimal. */
function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1)
}

function fmtMs(ms: number): string {
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`
  if (Math.round(ms / 100) < 600) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function statusLabel(t: TaskTelemetry): string {
  // A carried server ran inside each dependant, on its worker: its time is
  // theirs, and a `ran 0ms` row read as a run that did nothing (2026-10-23).
  if (t.carried === true) return '🔗 served'
  // A hit that found its outputs in place restored nothing: up to date,
  // as vx's own summary says it (a remote hit always restored).
  if (isCacheHit(t.status) && t.restored !== true) return '✔️ up-to-date'
  return STATUS_LABEL[t.status] ?? t.status
}

/** Rows by status label, in this order; any other after them. */
const ORDER = [
  '❌ failed',
  '🛑 aborted',
  '✅ ran',
  '🔗 served',
  '⚡ restored',
  '☁️ restored remote',
  '✔️ up-to-date',
  '⏭️ skipped',
]
const rank = (t: TaskTelemetry): number => {
  const i = ORDER.indexOf(statusLabel(t))
  return i === -1 ? ORDER.length : i
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
function truncateUtf8(text: string, maxBytes: number, suffix: string): string {
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
 * `value` as one table cell: task names are unvalidated, and the old cloud
 * job summary shipped without the escape once. A pipe splits the row unless
 * an ODD run of backslashes precedes it (GFM reads `\\` as one escaped
 * backslash), so a pipe after an odd run is already escaped. A lone `\r`
 * ends a line too.
 */
function escapeMarkdownCell(value: string): string {
  return value
    .replace(/(\\*)\|/g, (pipe, run: string) => (run.length % 2 === 0 ? `${run}\\|` : pipe))
    .replace(/\r\n|\r|\n/g, ' ')
}

/**
 * A task id as inline markdown: `a#*x*` rendered as `a#` and an italic
 * `x` (item 1058), `a#~x~` struck through and `&lt;` as `<`. Table cells
 * escape their pipes on top of this.
 */
function escapeInline(s: string): string {
  return s.replace(/[\\`*_[\]<>~&]/g, '\\$&')
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
  // A carried server ran inside its dependants, on their worker.
  const executed = summary.tasks.filter(
    (t) => (t.status === 'success' || t.status === 'failed') && t.carried !== true,
  ).length
  const stats = [
    `**${summary.taskCount}** task${summary.taskCount === 1 ? '' : 's'}`,
    `**${executed}** executed`,
    `**${summary.hitCount}** cache hit${summary.hitCount === 1 ? '' : 's'}` +
      (summary.hitCount > 0 ? ` ${hitSplit(summary)}` : ''),
    ...(summary.failedCount > 0 ? [`**${summary.failedCount}** failed`] : []),
    ...(summary.abortedCount > 0 ? [`**${summary.abortedCount}** aborted`] : []),
    // The run played perfectly on what each task took, beside the real time (2026-10-23).
    summary.idealMs === undefined
      ? fmtMs(summary.totalDurationMs)
      : `${fmtMs(summary.totalDurationMs)} (ideal ${fmtMs(summary.idealMs)})`,
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

  if (summary.machines !== undefined && summary.machines.length > 0) {
    lines.push(...renderWorkers(summary.machines, summary.tasks), '')
  }

  const header = ['Task', 'Status', 'Duration']
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`|${header.map(() => ' --- ').join('|')}|`)
  // By status, failures first (the eye lands on the table's top rows),
  // then the longest first (2026-10-23).
  const ordered = [...summary.tasks].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.carried === true ? 0 : b.durationMs) - (a.carried === true ? 0 : a.durationMs),
  )
  for (const t of ordered) {
    const cells = [
      escapeMarkdownCell(escapeInline(t.taskId)),
      statusLabel(t),
      t.carried === true ? '' : fmtMs(t.durationMs),
    ]
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

// "13 (1 failed)" read as 13 run in all, of 14 (2026-10-23).
const tasksCell = (ok: number, failed: number): string =>
  failed > 0 ? `${ok} ok, ${failed} failed` : `${ok}`

const pct = (x: number): string => `${Math.round(x * 100)}%`

/**
 * The workers an executor ran the run on (vx-dte's): the cores its tasks
 * booked beside the cores they used, each averaged over the time the
 * worker was online, so an idle or overfilled one shows on the page
 * (2026-10-23). "4.0 of 4" read as a peak; it is that average (M:
 * "is this an avg booking?").
 */
function renderWorkers(
  machines: NonNullable<RunSummaryRecord['machines']>,
  tasks: RunSummaryRecord['tasks'],
): string[] {
  const lines = [
    '### Workers',
    '',
    '| Worker | Status | Started at | Total | Warm-up | Online after warm-up | Idle while online | Tasks | Booked cores, avg | Used cores, avg | Peak RAM | Used of all cores |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  let coreMs = 0
  let cpuMs = 0
  // Over the workers that report a booking only: an executor may report
  // none, and counting that as 0 read as tasks booking nothing.
  let bookedCoreMs = 0
  let bookedMs = 0
  for (const m of machines) {
    coreMs += m.cores * m.onlineMs
    cpuMs += m.cpuAvg * m.onlineMs
    if (m.bookedAvg !== undefined) {
      bookedCoreMs += m.cores * m.onlineMs
      bookedMs += m.bookedAvg * m.onlineMs
    }
    lines.push(
      `| ${[
        escapeMarkdownCell(escapeInline(m.name)),
        escapeMarkdownCell(m.status),
        m.startMs === undefined ? '' : fmtMs(m.startMs),
        fmtMs((m.warmUpMs ?? 0) + m.onlineMs),
        m.warmUpMs === undefined ? '' : fmtMs(m.warmUpMs),
        fmtMs(m.onlineMs),
        fmtMs(Math.max(0, m.onlineMs - m.busyMs)),
        tasksCell(m.done, m.failed),
        m.bookedAvg === undefined ? '' : `${m.bookedAvg.toFixed(1)} of ${m.cores}`,
        `${m.cpuAvg.toFixed(1)} of ${m.cores}`,
        `${gb(m.memoryPeakBytes)} of ${gb(m.memoryBytes)} GB`,
        pct(m.utilization),
      ].join(' | ')} |`,
    )
  }
  // Nothing runs on a distributed run's own machine (2026-10-23):
  // a task that did is named, a bug to see. A carried server ran inside its
  // dependants, on their worker.
  const ran = tasks.filter(
    (t) => (t.status === 'success' || t.status === 'failed') && t.carried !== true,
  )
  const here = ran.filter((t) => t.where === undefined)
  if (here.length > 0) {
    const failed = here.filter((t) => t.status === 'failed').length
    lines.push(
      `| this machine | ok |  |  |  |  |  | ${tasksCell(here.length - failed, failed)} |  |  |  |  |`,
      '',
      `${ran.length} executed: ${ran.length - here.length} on workers, ${here.length} on this machine: ${here.map((t) => escapeMarkdownCell(escapeInline(t.taskId))).join(', ')}.`,
    )
  }
  if (coreMs > 0)
    lines.push(
      '',
      bookedCoreMs > 0
        ? `Over their online time, tasks booked ${pct(bookedMs / bookedCoreMs)} of the workers' cores and used ${pct(cpuMs / coreMs)}.`
        : `Over their online time, tasks used ${pct(cpuMs / coreMs)} of the workers' cores.`,
    )
  return lines
}
