// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts come from the
// shared `tallyOutcomes` helper, which excludes group tasks — they
// aren't real work and would inflate "N total" misleadingly.

import type { TaskOutcome } from '../graph/index.js'
import { paint, type ColorSupport } from './colors.js'
import { tallyOutcomes } from './tally.js'
import { isGroupTask } from '../graph/index.js'

const NO_COLOR: ColorSupport = { enabled: false }

const SUCCESS = '#22c55e'
const WARN = '#eab308'
// Cache provenance hues (owner): local light blue, remote dark blue —
// yellow is skipped's color on both meters.
const LOCAL = '#38bdf8' // sky-400
const REMOTE = '#2563eb' // blue-600
const ERROR = '#ef4444'

const BAR_WIDTH = 50
// Brand gradient for the rule: identity violet → pink (the project /
// task hues), faded across the dash run. Plain dashes when colors
// are off.
const GRADIENT_FROM = [0xa7, 0x8b, 0xfa] as const
const GRADIENT_TO = [0xf4, 0x72, 0xb6] as const
// Rule ends flush with the bars: 2 indent + 8 label + 2 gap + 50 cells.
const RULE_DASHES = 57

/** Total visible rule width: `\u2500 <mark> ` + dashes. Shared by summary + header. */
export function gradientRule(colors: ColorSupport, mark = 'vx'): string {
  const head = `\u2500 `
  const dashes = '\u2500'.repeat(Math.max(8, RULE_DASHES + 2 - mark.length))
  if (!colors.enabled) return `${head}${mark} ${dashes}`
  const chunks = 8
  const per = Math.ceil(RULE_DASHES / chunks)
  let out = ''
  for (let i = 0; i < chunks; i++) {
    const seg = dashes.slice(i * per, (i + 1) * per)
    if (seg.length === 0) break
    const f = i / (chunks - 1)
    const hex = `#${GRADIENT_FROM.map((c, j) =>
      Math.round(c + (GRADIENT_TO[j]! - c) * f)
        .toString(16)
        .padStart(2, '0'),
    ).join('')}`
    out += paint(hex, seg, colors)
  }
  return `${paint(`#${GRADIENT_FROM.map((c) => c.toString(16).padStart(2, '0')).join('')}`, head, colors)}${paint('', mark, colors, { bold: true })} ${out}`
}

/**
 * Stacked state meter: one ▰ run per bucket, proportional cells via
 * largest-remainder, every non-zero bucket guaranteed at least one
 * cell. Color carries the state; the color-coded numbers ride beside
 * the bar.
 */
function segmentBar(
  segments: readonly { n: number; color: string; glyph?: string; dim?: boolean }[],
  colors: ColorSupport,
): string {
  const total = segments.reduce((sum, seg) => sum + seg.n, 0)
  if (total === 0) return ''
  const exact = segments.map((seg) => (seg.n / total) * BAR_WIDTH)
  const cells = exact.map(Math.floor)
  let leftover = BAR_WIDTH - cells.reduce((sum, c) => sum + c, 0)
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((x, y) => y.frac - x.frac)
  for (const { i } of order) {
    if (leftover === 0) break
    cells[i]!++
    leftover--
  }
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.n > 0 && cells[i] === 0) {
      const biggest = cells.indexOf(Math.max(...cells))
      cells[biggest]!--
      cells[i] = 1
    }
  }
  return segments
    .map((seg, i) =>
      paint(seg.color, (seg.glyph ?? '\u25b0').repeat(cells[i]!), colors, {
        ...(seg.dim === true ? { dim: true } : {}),
      }),
    )
    .join('')
}

/** Aggregate counts feeding the summary section — buildable from a
 *  finished outcome list (formatRunSummary) or incrementally by the
 *  live logger, so the in-flight region and the final summary are the
 *  SAME section, one filling in as the other will print. */
export interface SummaryStats {
  failed: number
  /** Ended OK — executed successes AND cache hits. */
  successful: number
  skipped: number
  total: number
  upToDate: number
  restoredLocal: number
  restoredRemote: number
  /** Tasks that executed (success + failed) — the cache misses. */
  miss: number
  /** Still to run (live section only; 0 in the final summary) — renders
   *  as a gray ▱ remainder so the live meters FILL toward the final. */
  left?: number
  /** Cache-miss duration spread (only tasks that actually executed). */
  spread: { maxMs: number; minMs: number; sumMs: number; count: number } | null
}

/**
 * Run context the footer carries (final summary only — the live region
 * passes none). This is the data the top-of-run header used to show:
 * what the run covered + version + cache mode. Folded into the footer
 * so the run has one banner, at the end, where the eye lands.
 */
export interface RunContext {
  version: string
  /** Projects covered by the graph — the "affected" half of the bar. */
  packageCount: number
  /** Worker-pool size for this run; shown on the `info` row. */
  concurrency?: number
  remoteCacheEnabled: boolean
  /** Total projects discovery found — the bar's denominator. */
  workspaceProjectCount?: number
  /**
   * Resource-admission budgets (`exec.resources`), set ONLY when at
   * least one task declared a reservation — a plain run's footer is
   * byte-identical. Shown on the `info` row so a packed run says what
   * it packed against. memBudget in bytes.
   */
  cpuBudget?: number
  memBudget?: number
}

export function formatSummarySection(
  stats: SummaryStats,
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
  context?: RunContext,
): string[] {
  const hits = stats.upToDate + stats.restoredLocal + stats.restoredRemote
  const miss = stats.miss
  const left = stats.left ?? 0
  const remainder = { n: left, color: '', glyph: '\u25b1', dim: true }

  const dim = (txt: string) => paint('', txt, colors, { dim: true })
  const row = (label: string, value: string): string => `  ${dim(label.padEnd(8))}  ${value}`
  const join = (parts: string[]): string => parts.join(` ${dim('\u00b7')} `)

  // Tasks meter + numbers, fixed order: failed · success · skipped,
  // then a dim total so the legend reads against the whole graph.
  const taskParts: string[] = []
  if (stats.failed > 0)
    taskParts.push(paint(ERROR, `${stats.failed} failed`, colors, { bold: true }))
  if (stats.successful > 0) taskParts.push(paint(SUCCESS, `${stats.successful} success`, colors))
  if (stats.skipped > 0) taskParts.push(paint(WARN, `${stats.skipped} skipped`, colors))
  if (stats.total > 0) taskParts.push(dim(`${stats.total} total`))
  const taskBar = segmentBar(
    [
      { n: stats.failed, color: ERROR },
      { n: stats.successful, color: SUCCESS },
      { n: stats.skipped, color: WARN },
      remainder,
    ],
    colors,
  )
  // Bars on the label row, color-coded legend on its own line below,
  // indented to the bar column (2 indent + 8 label + 2 gap = 12).
  const legend = (parts: string[]): string => `${' '.repeat(12)}${join(parts)}`
  // Version rides the wordmark rule when run context is present (final
  // footer); the live region passes none and keeps a bare `vx`.
  const lines: string[] = [
    '',
    gradientRule(colors, context !== undefined ? `vx ${context.version}` : 'vx'),
  ]

  // Run context (final footer only): the projects bar leads the meter
  // stack — affected (yellow) vs the rest of the workspace (dim).
  if (context !== undefined) {
    const wsTotal = context.workspaceProjectCount
    if (wsTotal !== undefined && wsTotal > 0) {
      const cells = Math.min(
        BAR_WIDTH,
        Math.max(1, Math.round((context.packageCount / wsTotal) * BAR_WIDTH)),
      )
      const bar =
        paint(WARN, '▰'.repeat(cells), colors) +
        paint('', '▱'.repeat(BAR_WIDTH - cells), colors, { dim: true })
      lines.push(
        row('projects', bar),
        legend([paint(WARN, `${context.packageCount} affected`, colors), dim(`${wsTotal} total`)]),
      )
    }
  }

  if (taskBar.length > 0) {
    lines.push(row('tasks', taskBar))
    // No legend line until the first bucket lands (live: all-gray bar).
    if (taskParts.length > 0) lines.push(legend(taskParts))
  } else {
    lines.push(row('tasks', dim('0 tasks')))
  }

  // Cache meter + numbers, fixed order: miss · up-to-date · local ·
  // remote.
  if (miss + hits + left + stats.skipped > 0) {
    const cacheBar = segmentBar(
      [
        { n: miss, color: ERROR },
        { n: stats.upToDate, color: SUCCESS },
        { n: stats.restoredLocal, color: LOCAL },
        { n: stats.restoredRemote, color: REMOTE },
        { n: stats.skipped, color: WARN },
        remainder,
      ],
      colors,
    )
    const cacheParts: string[] = []
    if (miss > 0) cacheParts.push(paint(ERROR, `${miss} miss`, colors))
    if (stats.upToDate > 0) cacheParts.push(paint(SUCCESS, `${stats.upToDate} up-to-date`, colors))
    if (stats.restoredLocal > 0)
      cacheParts.push(paint(LOCAL, `${stats.restoredLocal} local`, colors))
    if (stats.restoredRemote > 0)
      cacheParts.push(paint(REMOTE, `${stats.restoredRemote} remote`, colors))
    // Skipped tasks have no cache provenance, but omitting them made
    // the cache legend sum below the tasks legend (owner-reported
    // confusion) — on the bar and in the legend, yellow like the
    // tasks meter.
    if (stats.skipped > 0) cacheParts.push(paint(WARN, `${stats.skipped} skipped`, colors))
    lines.push(row('cache', cacheBar))
    if (cacheParts.length > 0) lines.push(legend(cacheParts))
  }

  // Cache-miss duration spread (owner: hits' restore times polluted
  // it — only tasks that actually executed count). Dim: context.
  let spread = ''
  if (stats.spread !== null && stats.spread.count > 0) {
    const { maxMs, minMs, sumMs, count } = stats.spread
    spread = ` ${dim(`\u00b7 max ${formatDuration(maxMs)} \u00b7 avg ${formatDuration(sumMs / count)} \u00b7 min ${formatDuration(minMs)}`)}`
  }
  // Run-shape footer (final summary only): worker pool + cache mode,
  // grouped with time under a blank line below the meters.
  if (context !== undefined) {
    const info: string[] = []
    if (context.concurrency !== undefined)
      info.push(`${context.concurrency} worker${context.concurrency === 1 ? '' : 's'}`)
    info.push(context.remoteCacheEnabled ? 'local + remote cache' : 'local cache')
    if (context.cpuBudget !== undefined) info.push(`cpu budget ${context.cpuBudget}`)
    if (context.memBudget !== undefined && Number.isFinite(context.memBudget))
      info.push(`mem budget ${formatBudgetBytes(context.memBudget)}`)
    lines.push('', row('info', join(info)), row('time', `${formatDuration(totalMs)}${spread}`))
  } else {
    lines.push('', row('time', `${formatDuration(totalMs)}${spread}`))
  }
  return lines
}

// Local byte formatter — the orchestrator can't import cli/format.ts
// (module boundary), and the footer only needs one compact form.
function formatBudgetBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`
}

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
  context?: RunContext,
): string[] {
  const t = tallyOutcomes(outcomes)
  // Spread over executed tasks only — `success`/`failed` statuses ran
  // a command; cache-hit statuses replayed one.
  const durations = outcomes
    .filter((o) => (o.status === 'success' || o.status === 'failed') && !isGroupTask(o.node))
    .map((o) => o.durationMs)
  return formatSummarySection(
    {
      failed: t.failed,
      successful: t.successful,
      skipped: t.skipped,
      total: t.total,
      upToDate: t.upToDate,
      restoredLocal: t.restoredLocal,
      restoredRemote: t.restoredRemote,
      miss: t.total - t.skipped - (t.cachedLocal + t.cachedRemote),
      spread:
        durations.length > 0
          ? {
              maxMs: Math.max(...durations),
              minMs: Math.min(...durations),
              sumMs: durations.reduce((sum, d) => sum + d, 0),
              count: durations.length,
            }
          : null,
    },
    totalMs,
    colors,
    context,
  )
}

/**
 * Post-summary section naming the tasks a shutdown signal killed. An aborted
 * task did no work, so it is in no tally bucket and no history row — but the
 * run still exits non-zero, and without this the user reads a red exit over a
 * fully green summary that names nothing. The interactive Ctrl-C path never
 * gets here (the signal handler exits before any outcome lands), so this only
 * ever prints for a run that reached its summary WITH a task killed by some
 * other signal — an external `kill`, a supervisor, a self-terminating child.
 * Empty when nothing aborted.
 */
export function formatAbortedSection(outcomes: readonly TaskOutcome[]): string[] {
  const aborted = outcomes.filter((o) => o.status === 'aborted')
  if (aborted.length === 0) return []
  const lines = [
    '',
    `  Aborted:  ${aborted.length} task${aborted.length === 1 ? '' : 's'} killed by a shutdown signal — not counted above`,
  ]
  for (const o of aborted) lines.push(`    ✗ ${o.node.id} — exit ${o.exitCode}, nothing cached`)
  return lines
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
