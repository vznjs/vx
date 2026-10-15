// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts come from the
// shared `tallyOutcomes` helper, which excludes group tasks — they
// aren't real work and would inflate "N total" misleadingly.

import type { TaskOutcome } from '../graph/index.js'
import { tallyOutcomes } from './tally.js'
import { isCacheHit } from './telemetry.js'
import { outcomeLabel, projectOutcome, ranNoCache } from './events.js'
import { isGroupTask } from '../graph/index.js'
import {
  ERROR,
  formatElapsed,
  gradientRule,
  paint,
  SUCCESS,
  WARN,
  type ColorSupport,
} from '../util/index.js'

const NO_COLOR: ColorSupport = { enabled: false }

// Cache provenance hues (owner): local light blue, remote dark blue —
// yellow is skipped's color on both meters.
const LOCAL = '#38bdf8' // sky-400
const REMOTE = '#2563eb' // blue-600
const ABORTED = '#f97316' // orange-500: red's neighbour, not a failure
const NOT_RUN = '#a855f7' // purple-500: stopped before it began, apart from every other state
const ACCENT = '#06b6d4' // cyan-500: the live region's running word

const BAR_WIDTH = 50
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
  /** Killed by a shutdown signal (final summary only). Not in `total`. */
  aborted?: number
  /** Reached by the stop before they ran (final summary only). Not in `total`. */
  notRun?: number
  total: number
  upToDate: number
  restoredLocal: number
  restoredRemote: number
  /** Ran here and saved to the cache: the legend's `↑`. */
  saved?: number
  /** Ran here with a `cache` block, succeeded, and saved nothing. */
  notSaved?: number
  /** Tasks that executed (success + failed) with a `cache` block — the misses. */
  miss: number
  /** Executed with no `cache` block: never consulted the cache, not a miss. */
  noCache?: number
  /** Still to run (live section only; 0 in the final summary) — renders
   *  as a gray ▱ remainder so the live meters FILL toward the final. */
  left?: number
  /** Cache-miss duration spread (only tasks that actually executed). */
  spread: { maxMs: number; minMs: number; sumMs: number; count: number } | null
  /** Tasks an `admit` policy held with a worker free, and the waits summed. Absent with no hold. */
  held?: { count: number; sumMs: number }
  /** Live section only: the forecast of what is left, from history. */
  etaMs?: number
  /** The hits' stored exec times summed: the work the cache skipped. */
  savedMs?: number
  /** A run of groups only: their names, so `0 tasks` says why. */
  emptyGroups?: readonly string[]
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
  /**
   * The cache layers the run used, so the legend reads `local 1= 2↓ 4↑ ·
   * remote 3↓ 4↑`. Absent: the plain `N miss` legend.
   */
  cache?: {
    /** The run's policy reads or writes the local layer. */
    local: boolean
    localWrite: boolean
    /** A remote layer exists and the policy reads or writes it. */
    remote: boolean
    /** The run's uploads, filled as each lands (a live ref). */
    uploads: { count: number; failed: number }
    /** Tasks whose outputs are still in the remote store. */
    notDownloaded: () => number
  }
  /** Total projects discovery found — the bar's denominator. */
  workspaceProjectCount?: number
}

export function formatSummarySection(
  stats: SummaryStats,
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
  context?: RunContext,
): string[] {
  const hits = stats.upToDate + stats.restoredLocal + stats.restoredRemote
  const miss = stats.miss
  const noCache = stats.noCache ?? 0
  const left = stats.left ?? 0
  const aborted = stats.aborted ?? 0
  const notRun = stats.notRun ?? 0
  const remainder = { n: left, color: '', glyph: '\u25b1', dim: true }

  const dim = (txt: string) => paint('', txt, colors, { dim: true })
  const row = (label: string, value: string): string => `  ${dim(label.padEnd(8))}  ${value}`
  const join = (parts: string[]): string => parts.join(` ${dim('\u00b7')} `)

  // Tasks meter + numbers, fixed order: failed · success · skipped ·
  // aborted · not run, then a dim total, last on its line. Every task in
  // the run counts, each state its own segment (M, 2026-10-14).
  const runTotal = stats.total + aborted + notRun
  const taskParts: string[] = []
  if (stats.failed > 0)
    taskParts.push(paint(ERROR, `${stats.failed} failed`, colors, { bold: true }))
  if (stats.successful > 0) taskParts.push(paint(SUCCESS, `${stats.successful} success`, colors))
  if (stats.skipped > 0) taskParts.push(paint(WARN, `${stats.skipped} skipped`, colors))
  if (aborted > 0) taskParts.push(paint(ABORTED, `${aborted} aborted`, colors))
  if (notRun > 0) taskParts.push(paint(NOT_RUN, `${notRun} not run`, colors))
  if (runTotal > 0) taskParts.push(dim(`${runTotal} total`))
  const taskBar = segmentBar(
    [
      { n: stats.failed, color: ERROR },
      { n: stats.successful, color: SUCCESS },
      { n: stats.skipped, color: WARN },
      { n: aborted, color: ABORTED },
      { n: notRun, color: NOT_RUN },
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
  // stack — the projects in the run (yellow) vs the rest of the workspace (dim).
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
    const groups = stats.emptyGroups ?? []
    // `vx run build` where no project gives build a command runs the default
    // group alone: say so, or it reads like a selection that matched nothing.
    const why =
      groups.length > 0
        ? ` ${dim('\u00b7')} ${dim(`${groups.join(', ')} ${groups.length === 1 ? 'has' : 'have'} no command in these projects`)}`
        : ''
    lines.push(row('tasks', dim('0 tasks') + why))
    // A stop before any task finished still names what it took down.
    if (taskParts.length > 0) lines.push(legend(taskParts))
  }

  // Cache meter + numbers: per layer when the run context names its
  // layers, else miss · no-cache · up-to-date · local · remote.
  if (miss + noCache + hits + left + stats.skipped > 0) {
    const cacheBar = segmentBar(
      [
        { n: miss, color: ERROR },
        { n: noCache, color: '', dim: true },
        { n: stats.upToDate, color: SUCCESS },
        { n: stats.restoredLocal, color: LOCAL },
        { n: stats.restoredRemote, color: REMOTE },
        { n: stats.skipped, color: WARN },
        remainder,
      ],
      colors,
    )
    const cacheParts: string[] = []
    const layers = context?.cache
    if (layers !== undefined) {
      // Per layer (M, 2026-10-15): `●` fresh (outputs already on disk, from
      // either layer) and `○` no cache, both local; `↓` restored from a
      // layer, `↑` saved to it.
      const n = (count: number, glyph: string): string[] => (count > 0 ? [`${count}${glyph}`] : [])
      const local = [
        ...(layers.local ? n(stats.upToDate, '\u25cf') : []),
        ...n(noCache, '\u25cb'),
        ...(layers.local ? n(stats.restoredLocal, '\u2193') : []),
        ...(layers.localWrite ? n(stats.saved ?? 0, '\u2191') : []),
      ]
      if (local.length > 0) cacheParts.push(paint(LOCAL, `local ${local.join(' ')}`, colors))
      const remote = [...n(stats.restoredRemote, '\u2193'), ...n(layers.uploads.count, '\u2191')]
      if (layers.remote && remote.length > 0)
        cacheParts.push(paint(REMOTE, `remote ${remote.join(' ')}`, colors))
      if (layers.uploads.failed > 0)
        cacheParts.push(paint(ERROR, `${layers.uploads.failed} \u2191 failed`, colors))
      if ((stats.notSaved ?? 0) > 0)
        cacheParts.push(paint(WARN, `${stats.notSaved} not saved`, colors))
      const notDownloaded = layers.notDownloaded()
      if (notDownloaded > 0) cacheParts.push(paint(WARN, `${notDownloaded} not downloaded`, colors))
    } else {
      if (miss > 0) cacheParts.push(paint(ERROR, `${miss} miss`, colors))
      if (noCache > 0) cacheParts.push(paint('', `${noCache} no-cache`, colors, { dim: true }))
      if (stats.upToDate > 0)
        cacheParts.push(paint(SUCCESS, `${stats.upToDate} up-to-date`, colors))
      if (stats.restoredLocal > 0)
        cacheParts.push(paint(LOCAL, `${stats.restoredLocal} local`, colors))
      if (stats.restoredRemote > 0)
        cacheParts.push(paint(REMOTE, `${stats.restoredRemote} remote`, colors))
    }
    // Skipped tasks ride the bar, yellow like the tasks meter, so the two
    // bars fill alike; their count is the tasks legend's alone (the footer
    // never says a fact twice, M, 2026-10-14).
    lines.push(row('cache', cacheBar))
    if (cacheParts.length > 0) lines.push(legend(cacheParts))
  }

  // Cache-miss duration spread (owner: hits' restore times polluted
  // it — only tasks that actually executed count). Dim: context.
  // A value already on the row is not said again: one executed task read
  // as its own max, avg and min (M, 2026-10-14). Tasks that all took the
  // same time have no spread to show.
  const total = formatElapsed(totalMs)
  const said = new Set([total])
  const spreadParts: string[] = []
  if (
    stats.spread !== null &&
    formatElapsed(stats.spread.maxMs) !== formatElapsed(stats.spread.minMs)
  ) {
    const { maxMs, minMs, sumMs, count } = stats.spread
    for (const [label, ms] of [
      ['max', maxMs],
      ['avg', sumMs / count],
      ['min', minMs],
    ] as const) {
      const v = formatElapsed(ms)
      if (said.has(v)) continue
      said.add(v)
      spreadParts.push(`${label} ${v}`)
    }
  }
  const timeParts = [total]
  // What the cache paid back, beside what the run cost: the stored exec
  // time of every hit, never the restore this run spent on it.
  if ((stats.savedMs ?? 0) >= 1)
    timeParts.push(paint(SUCCESS, `${formatElapsed(stats.savedMs!)} saved`, colors))
  // The live run's forecast leads the spread: the one number on the row
  // that is about the future.
  if (stats.etaMs !== undefined)
    timeParts.push(paint(ACCENT, `${formatEta(stats.etaMs)} left`, colors))
  for (const p of spreadParts) timeParts.push(dim(p))
  const timeRow = row('time', join(timeParts))
  // Run-shape footer (final summary only): worker pool + cache mode,
  // grouped with time under a blank line below the meters.
  if (context !== undefined) {
    const info: string[] = []
    if (context.concurrency !== undefined)
      info.push(`${context.concurrency} worker${context.concurrency === 1 ? '' : 's'}`)
    info.push(context.remoteCacheEnabled ? 'local + remote cache' : 'local cache')
    // The plugin's hand on the run: a task a policy held with a worker
    // free would otherwise have started; without the line nothing says
    // the policy acted. The duration is the waits summed, task-seconds
    // — 85 held tasks read `4783s` beside a 160 s run on TanStack/router
    // (2026-09-15), so the line says it is a sum.
    if (stats.held !== undefined && stats.held.count > 0) {
      info.push(
        `admit held ${stats.held.count} task${stats.held.count === 1 ? '' : 's'}, ${formatElapsed(stats.held.sumMs)} in all`,
      )
    }
    lines.push('', row('info', join(info)), timeRow)
  } else {
    lines.push('', timeRow)
  }
  return lines
}

/**
 * A forecast, said as coarsely as it is known: `~4s`, `~2m 05s`, `<1s`
 * once the history says the end is due.
 */
function formatEta(ms: number): string {
  if (ms < 1000) return '<1s'
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `~${s}s`
  return `~${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * The `--verbosity 1` per-task table (`RunOptions.summaryTable`). Groups are
 * left out as the footer and `--report` leave them: a group ran no command.
 */
export function formatOutcomeTable(outcomes: readonly TaskOutcome[]): string[] {
  const rows = outcomes
    .filter((o) => !isGroupTask(o.node))
    .map((o) => {
      const v = projectOutcome(o)
      return { task: v.taskId, status: outcomeLabel(v), duration: `${v.durationMs}ms` }
    })
  if (rows.length === 0) return []
  const widths = {
    task: Math.max(4, ...rows.map((r) => r.task.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    duration: Math.max(8, ...rows.map((r) => r.duration.length)),
  }
  const line = (task: string, status: string, duration: string) =>
    `${task.padEnd(widths.task)}  ${status.padEnd(widths.status)}  ${duration.padStart(widths.duration)}`
  const header = line('TASK', 'STATUS', 'DURATION')
  return [
    '',
    header,
    '-'.repeat(header.length),
    ...rows.map((r) => line(r.task, r.status, r.duration)),
  ]
}

// Local byte formatter — the orchestrator can't import cli/format.ts
// (module boundary), and the footer only needs one compact form.
/** Ran here with a `cache` block, succeeded, and its result was not saved. */
export function ranUnsaved(o: TaskOutcome): boolean {
  return o.status === 'success' && !ranNoCache(o) && o.saved !== true && o.where === undefined
}

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
  context?: RunContext,
): string[] {
  // Counted here, not in the Tally: a task with no `cache` block never
  // consulted the cache, so it is not a miss.
  const noCache = outcomes.filter(
    (o) =>
      !isGroupTask(o.node) && (o.status === 'success' || o.status === 'failed') && ranNoCache(o),
  ).length
  const t = tallyOutcomes(outcomes)
  // Spread over executed tasks only — `success`/`failed` statuses ran
  // a command; cache-hit statuses replayed one.
  const durations = outcomes
    .filter((o) => (o.status === 'success' || o.status === 'failed') && !isGroupTask(o.node))
    .map((o) => o.durationMs)
  let savedMs = 0
  for (const o of outcomes)
    if (isCacheHit(o.status) && !isGroupTask(o.node)) savedMs += o.storedDurationMs ?? 0
  const heldOutcomes = outcomes.filter((o) => o.admissionHeldMs !== undefined)
  const notRun = outcomes.filter((o) => neverStarted(o) && !isGroupTask(o.node)).length
  const emptyGroups = outcomes.every((o) => isGroupTask(o.node))
    ? [...new Set(outcomes.map((o) => o.node.taskName))]
    : []
  return formatSummarySection(
    {
      failed: t.failed,
      successful: t.successful,
      skipped: t.skipped,
      aborted: t.aborted - notRun,
      notRun,
      total: t.total,
      upToDate: t.upToDate,
      restoredLocal: t.restoredLocal,
      restoredRemote: t.restoredRemote,
      saved: outcomes.filter((o) => o.saved === true && !isGroupTask(o.node)).length,
      notSaved: outcomes.filter((o) => !isGroupTask(o.node) && ranUnsaved(o)).length,
      miss: t.total - t.skipped - (t.cachedLocal + t.cachedRemote) - noCache,
      noCache,
      savedMs,
      spread:
        durations.length > 0
          ? {
              maxMs: Math.max(...durations),
              minMs: Math.min(...durations),
              sumMs: durations.reduce((sum, d) => sum + d, 0),
              count: durations.length,
            }
          : null,
      ...(heldOutcomes.length > 0
        ? {
            held: {
              count: heldOutcomes.length,
              sumMs: heldOutcomes.reduce((sum, o) => sum + o.admissionHeldMs!, 0),
            },
          }
        : {}),
      ...(emptyGroups.length > 0 ? { emptyGroups } : {}),
    },
    totalMs,
    colors,
    context,
  )
}

/**
 * An `aborted` outcome the stop reached before dispatch. The scheduler gives
 * it an invented exit 1; only a started task carries a wall-clock start, so
 * that is what tells "never ran" from "killed" (item 1062).
 */
export function neverStarted(
  o: Pick<TaskOutcome, 'status'> & { wallclockStartNs?: unknown },
): boolean {
  return o.status === 'aborted' && o.wallclockStartNs === undefined
}
