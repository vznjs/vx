// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts come from the
// shared `tallyOutcomes` helper, which excludes group tasks — they
// aren't real work and would inflate "N total" misleadingly.

import type { TaskOutcome } from '../graph/index.js'
import { tallyOutcomes } from './tally.js'
import { outcomeLabel, projectOutcome, ranNoCache } from './events.js'
import { isGroupTask } from '../graph/index.js'
import {
  barWidth,
  ERROR,
  formatBytes,
  formatElapsed,
  gradientRule,
  identityColor,
  paint,
  SUCCESS,
  ui,
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
const RUNNING = '#06b6d4' // cyan-500: ui's info
const ACCENT = '#06b6d4' // cyan-500: the live region's running word

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
  const width = barWidth(colors)
  const exact = segments.map((seg) => (seg.n / total) * width)
  const cells = exact.map(Math.floor)
  let leftover = width - cells.reduce((sum, c) => sum + c, 0)
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
      // An empty segment paints nothing: no escape pair around no cell.
      cells[i] === 0
        ? ''
        : paint(seg.color, (seg.glyph ?? '\u25b0').repeat(cells[i]!), colors, {
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
  /** Killed by a shutdown signal, shown as `aborted`. Not in `total`. */
  aborted?: number
  /** Reached by the stop before they ran. Not in `total`. */
  notRun?: number
  /** Live: running now, and handed to an executor whose machine has not begun them. */
  running?: number
  scheduled?: number
  /** Live: not started because a dependency has not finished. */
  blocked?: number
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
  /** Live section only: how long the run has gone past that forecast. */
  overMs?: number
  /** A run of groups only: their names, so `0 tasks` says why. */
  emptyGroups?: readonly string[]
  /** Each finished task's cache bucket by its key and its id (its run bytes), so its remote traffic can move it. */
  buckets?: ReadonlyMap<string, CacheBucket>
}

/** The cache bar segment a finished task fills before its remote traffic is weighed. */
export type CacheBucket =
  | 'miss'
  | 'noCache'
  | 'upToDate'
  | 'restoredLocal'
  | 'restoredRemote'
  | 'saved'
  | 'notSaved'

/** A finished task's own cache bucket; none for a group, a skip or an abort. */
export function cacheBucketOf(o: TaskOutcome): CacheBucket | undefined {
  if (isGroupTask(o.node)) return undefined
  switch (o.status) {
    case 'success':
      return ranNoCache(o)
        ? 'noCache'
        : o.saved === true
          ? 'saved'
          : ranUnsaved(o)
            ? 'notSaved'
            : 'miss'
    case 'failed':
      return ranNoCache(o) ? 'noCache' : 'miss'
    case 'cache-hit':
      return o.restored === false ? 'upToDate' : 'restoredLocal'
    case 'cache-hit-remote':
      return o.restored === false ? 'upToDate' : 'restoredRemote'
    default:
      return undefined
  }
}

type Buckets = Record<CacheBucket | 'uploaded' | 'uploading' | 'remoteFailed', number>

/**
 * The cache bar's segments, each task in one (2026-10-15). With layers
 * named, a saved task leaves the misses, and a task with remote traffic
 * leaves its own bucket for its strongest remote state: a failed read or
 * write, then an upload still running, then one that landed. Without, the
 * plain legend's buckets.
 */
function cacheBuckets(stats: SummaryStats, layers: RunContext['cache']): Buckets {
  const saved = layers === undefined ? 0 : (stats.saved ?? 0)
  // Its own yellow segment, as its legend count is: in the misses' red it
  // was a cell with no count under it (2026-10-21).
  const notSaved = layers === undefined ? 0 : (stats.notSaved ?? 0)
  const b: Buckets = {
    miss: stats.miss - saved - notSaved,
    notSaved,
    noCache: stats.noCache ?? 0,
    upToDate: stats.upToDate,
    restoredLocal: stats.restoredLocal,
    restoredRemote: stats.restoredRemote,
    saved,
    uploaded: 0,
    uploading: 0,
    remoteFailed: 0,
  }
  if (layers?.remote !== true || stats.buckets === undefined) return b
  for (const [hash, k] of layers.traffic.keys) {
    const from = stats.buckets.get(hash)
    // Still running: it counts once it ends.
    if (from === undefined) continue
    b[from]--
    b[k.failures.length > 0 ? 'remoteFailed' : k.uploading > 0 ? 'uploading' : 'uploaded']++
  }
  return b
}

/**
 * Run context the footer carries (final summary only — the live region
 * passes none). This is the data the top-of-run header used to show:
 * what the run covered + version + cache mode. Folded into the footer
 * so the run has one banner, at the end, where the eye lands.
 */
export interface RunContext {
  version: string
  /** Projects with a real task in the graph — the "affected" half of the bar. */
  packageCount: number
  /** The run's whole id, as `vx last` takes it; shown on the `info` row. */
  runId?: string | undefined
  /** The executors' own footer rows (`TaskExecutor.footer`), above the `info` row. */
  executorRows?: () => readonly (readonly [string, ui.Inline])[]
  /** Where a running task runs, `null` while it waits for a machine (`TaskExecutor.running`): its live row. */
  whereRunning?: (taskId: string) => string | null | undefined
  /** Worker-pool size for this run; shown on the `info` row. */
  concurrency?: number
  remoteCacheEnabled: boolean
  /** The run's cache scope, named after the cache mode: `scope vznjs/vx:feat-x`. */
  cacheScope?: string | undefined
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
    /** The run's remote traffic per key, filled as it happens (a live ref). */
    traffic: {
      /** Uploads queued or running. */
      readonly inFlight: number
      readonly keys: ReadonlyMap<string, { uploading: number; failures: readonly string[] }>
    }
    /** Bytes the run's remote hits pulled, and its landed uploads pushed (live refs). */
    downloads?: { readonly bytes: number }
    uploads?: { readonly bytes: number }
    /** Tasks whose outputs are still in the remote store. */
    notDownloaded: () => number
  }
  /** Total projects discovery found — the bar's denominator. */
  workspaceProjectCount?: number
  /** The run's warnings no task owns, as they were said: the footer's `warn` row. */
  warnings?: () => readonly string[]
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
  const running = stats.running ?? 0
  const scheduled = stats.scheduled ?? 0
  const blocked = stats.blocked ?? 0
  const remainder = {
    n: Math.max(0, left - running - scheduled - blocked),
    color: '',
    glyph: '\u25b1',
    dim: true,
  }

  const dim = (txt: string) => paint('', txt, colors, { dim: true })
  const row = (label: string, value: string): string => `  ${dim(label.padEnd(8))}  ${value}`
  const join = (parts: string[]): string => parts.join(` ${dim('\u00b7')} `)

  // Tasks meter + numbers, fixed order: failed · success · skipped ·
  // aborted · not run, then a dim total, last on its line. Every task in
  // the run counts, each state its own segment (2026-10-14).
  const runTotal = stats.total + aborted + notRun
  const taskParts: string[] = []
  if (stats.failed > 0)
    taskParts.push(paint(ERROR, `${stats.failed} failed`, colors, { bold: true }))
  if (stats.successful > 0) taskParts.push(paint(SUCCESS, `${stats.successful} success`, colors))
  if (stats.skipped > 0) taskParts.push(paint(WARN, `${stats.skipped} skipped`, colors))
  if (aborted > 0) taskParts.push(paint(ABORTED, `${aborted} aborted`, colors))
  if (notRun > 0) taskParts.push(paint(NOT_RUN, `${notRun} not run`, colors))
  if (running > 0) taskParts.push(paint(RUNNING, `${running} running`, colors))
  if (scheduled > 0) taskParts.push(dim(`${scheduled} scheduled`))
  if (blocked > 0) taskParts.push(dim(`${blocked} blocked`))
  // What is not done yet, running included: the count the bar's unfilled part shows.
  if (left > 0) taskParts.push(dim(`${left} left`))
  if (runTotal > 0) taskParts.push(dim(`${runTotal} total`))
  const taskBar = segmentBar(
    [
      { n: stats.failed, color: ERROR },
      { n: stats.successful, color: SUCCESS },
      { n: stats.skipped, color: WARN },
      { n: aborted, color: ABORTED },
      { n: notRun, color: NOT_RUN },
      { n: running, color: RUNNING },
      { n: scheduled, color: '', dim: true },
      { n: blocked, color: '', dim: true },
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
      const width = barWidth(colors)
      const cells =
        context.packageCount === 0
          ? 0
          : Math.min(width, Math.max(1, Math.round((context.packageCount / wsTotal) * width)))
      const bar =
        paint(WARN, '▰'.repeat(cells), colors) +
        paint('', '▱'.repeat(width - cells), colors, { dim: true })
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
    const layers = context?.cache
    const b = cacheBuckets(stats, layers)
    const cacheBar = segmentBar(
      [
        { n: b.miss, color: ERROR },
        { n: b.notSaved, color: WARN },
        { n: b.noCache, color: '', dim: true },
        { n: b.upToDate, color: SUCCESS },
        { n: b.restoredLocal, color: LOCAL },
        { n: b.saved, color: LOCAL },
        { n: b.restoredRemote, color: REMOTE },
        { n: b.uploaded, color: REMOTE },
        { n: b.uploading, color: ACCENT },
        { n: b.remoteFailed, color: ERROR },
        { n: stats.skipped, color: WARN },
        remainder,
      ],
      colors,
    )
    const cacheParts: string[] = []
    if (layers !== undefined) {
      // Per layer (2026-10-15): `✓` fresh (outputs already on disk, from
      // either layer) and `∅` no cache, both local; `↓` restored from a
      // layer, `↑` saved to it; `✗` a remote read or write failed, `⇡` still
      // uploading. Each count is its bar segment's, glyph and number in its colour.
      const n = (count: number, glyph: string, color: string, dim = false): string[] =>
        count > 0 ? [paint(color, `${count}${glyph}`, colors, dim ? { dim: true } : {})] : []
      const local = [
        ...(layers.local ? n(b.upToDate, '\u2713', SUCCESS) : []),
        ...n(b.noCache, '\u2205', '', true),
        ...(layers.local ? n(b.restoredLocal, '\u2193', LOCAL) : []),
        ...(layers.localWrite ? n(b.saved, '\u2191', LOCAL) : []),
      ]
      // The layer words are dim; only the counts carry colour (2026-10-15).
      if (local.length > 0) cacheParts.push(`${dim('local')} ${local.join(' ')}`)
      // Each transfer count is followed by its bytes, dim: what the
      // remote moved is the cost a hit or an upload paid.
      const sized = (count: number, glyph: string, bytes: number | undefined): string[] =>
        count === 0
          ? []
          : bytes === undefined || bytes === 0
            ? n(count, glyph, REMOTE)
            : [...n(count, glyph, REMOTE), dim(formatBytes(bytes))]
      const remote = [
        ...sized(b.restoredRemote, '\u2193', layers.downloads?.bytes),
        ...sized(b.uploaded, '\u2191', layers.uploads?.bytes),
        ...n(b.remoteFailed, '\u2717', ERROR),
        ...n(b.uploading, '\u21e1', ACCENT),
      ]
      if (layers.remote && remote.length > 0)
        cacheParts.push(`${dim('remote')} ${remote.join(' ')}`)
      if (b.miss > 0) cacheParts.push(paint(ERROR, `${b.miss} miss`, colors))
      if (b.notSaved > 0) cacheParts.push(paint(WARN, `${b.notSaved} not saved`, colors))
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
    // never says a fact twice, 2026-10-14).
    lines.push(row('cache', cacheBar))
    if (cacheParts.length > 0) lines.push(legend(cacheParts))
  }

  // Cache-miss duration spread (owner: hits' restore times polluted
  // it — only tasks that actually executed count). Dim: context.
  // A value already on the row is not said again: one executed task read
  // as its own max, avg and min (2026-10-14). Tasks that all took the
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
  // The live run's forecast leads the spread: the one number on the row
  // that is about the future.
  if (stats.etaMs !== undefined)
    timeParts.push(paint(ACCENT, `${formatEta(stats.etaMs)} left`, colors))
  else if (stats.overMs !== undefined)
    timeParts.push(paint(ACCENT, `${formatOver(stats.overMs)} over`, colors))
  for (const p of spreadParts) timeParts.push(dim(p))
  const timeRow = row('time', join(timeParts))
  // Run-shape footer (final summary only): worker pool + cache mode,
  // grouped with time under a blank line below the meters.
  if (context !== undefined) {
    const own = context.executorRows?.() ?? []
    if (own.length > 0)
      lines.push('', ...own.map(([label, text]) => row(label, ui.inline(text, colors))))
    const info: string[] = []
    // An executor that says where tasks ran says it better than the pool.
    if (context.concurrency !== undefined && own.length === 0)
      info.push(`${context.concurrency} worker${context.concurrency === 1 ? '' : 's'}`)
    const layers = context.cache
    info.push(
      layers === undefined
        ? context.remoteCacheEnabled
          ? 'local + remote cache'
          : 'local cache'
        : layers.local && layers.remote
          ? 'local + remote cache'
          : layers.local
            ? 'local cache'
            : layers.remote
              ? 'remote cache'
              : 'no cache',
    )
    if (context.cacheScope !== undefined) info.push(`scope ${context.cacheScope}`)
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
    if (context.runId !== undefined) info.push(`run ${context.runId}`)
    lines.push('', ...warnRows(context.warnings?.() ?? [], row, colors))
    lines.push(row('info', join(info)), timeRow)
  } else {
    lines.push('', timeRow)
  }
  return lines
}

/**
 * A long run scrolls its warnings (a remote cache's 403, a plugin's
 * failed flush) out of sight, and the footer read as a clean run
 * (2026-10-27). The footer counts the distinct ones; it does not repeat
 * them, so a warning stays one line in a log (a refused token costs
 * ONE line, tests/remote-cache-degrade.test.ts in @vzn/vx-migrate).
 */
function warnRows(
  warnings: readonly string[],
  row: (label: string, value: string) => string,
  colors: ColorSupport,
): string[] {
  const n = new Set(
    warnings.map((w) => Bun.stripANSI(w).split('\n')[0]!.trim()).filter((w) => w !== ''),
  ).size
  if (n === 0) return []
  return [row('warn', paint(WARN, `${n} ${n === 1 ? 'warning' : 'warnings'} above`, colors))]
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

function formatOver(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  return s < 60 ? `+${s}s` : `+${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * The `--verbosity 1` per-task table (`RunOptions.summaryTable`). Groups are
 * left out as the footer leaves them: a group ran no command. Painted in the
 * list's vocabulary: header bold violet, ids in their hues, status in its
 * state colour, rule and durations dim.
 */
export function formatOutcomeTable(
  outcomes: readonly TaskOutcome[],
  colors: ColorSupport = NO_COLOR,
): string[] {
  const rows = outcomes
    .filter((o) => !isGroupTask(o.node))
    .map((o) => {
      const v = projectOutcome(o)
      const status = neverStarted(o) ? 'not run' : outcomeLabel(v)
      return { o, task: v.taskId, status, duration: `${v.durationMs}ms` }
    })
  if (rows.length === 0) return []
  const widths = {
    task: Math.max(4, ...rows.map((r) => r.task.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    duration: Math.max(8, ...rows.map((r) => r.duration.length)),
  }
  const pad = (text: string, width: number) => ' '.repeat(Math.max(0, width - text.length))
  const header = `${'TASK'.padEnd(widths.task)}  ${'STATUS'.padEnd(widths.status)}  ${'DURATION'.padStart(widths.duration)}`
  const dim = (t: string) => paint('', t, colors, { dim: true })
  return [
    '',
    paint(TABLE_HEADER, header, colors, { bold: true }),
    dim('-'.repeat(header.length)),
    ...rows.map((r) => {
      const { node } = r.o
      const id =
        node.projectName !== undefined && node.taskName !== undefined
          ? paint(identityColor(node.projectName), node.projectName, colors) +
            dim('#') +
            paint(identityColor(node.taskName), node.taskName, colors)
          : r.task
      const status = paint(tableStatusColor(r.o), r.status, colors)
      return `${id}${pad(r.task, widths.task)}  ${status}${pad(r.status, widths.status)}  ${pad(r.duration, widths.duration)}${dim(r.duration)}`
    }),
  ]
}

/** violet-400, as the task list's header. */
const TABLE_HEADER = '#a78bfa'

function tableStatusColor(o: TaskOutcome): string {
  switch (o.status) {
    case 'failed':
      return ERROR
    case 'skipped':
      return WARN
    case 'aborted':
      return neverStarted(o) ? NOT_RUN : ABORTED
    default:
      return SUCCESS
  }
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
      buckets: bucketsOf(outcomes),
    },
    totalMs,
    colors,
    context,
  )
}

/** Each finished task's cache bucket by its key and by its id. */
function bucketsOf(outcomes: readonly TaskOutcome[]): Map<string, CacheBucket> {
  const out = new Map<string, CacheBucket>()
  for (const o of outcomes) {
    const bucket = cacheBucketOf(o)
    if (bucket === undefined) continue
    if (o.hash !== undefined) out.set(o.hash, bucket)
    out.set(o.node.id, bucket)
  }
  return out
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
