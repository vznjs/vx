// Turbo-style end-of-run summary. Always printed after a `vx run`
// invocation completes (success or failure). Counts come from the
// shared `tallyOutcomes` helper, which excludes group tasks — they
// aren't real work and would inflate "N total" misleadingly.

import type { TaskOutcome } from '../graph/index.js'
import { tallyOutcomes } from './tally.js'
import { outcomeLabel, projectOutcome, ranNoCache } from './events.js'
import { isGroupTask, isKeyFailed, markKeyFailed } from '../graph/index.js'
import { formatBytes, formatElapsed } from '../util/index.js'
import * as ui from '../ui/index.js'
import {
  bar,
  barWidth,
  gauge,
  idParts,
  paint,
  panelTop,
  type ColorSupport,
  type Segment,
  type Style,
} from '../ui/index.js'

const NO_COLOR: ColorSupport = { enabled: false }

/** A meter of the run's states; a segment with no style is dim, `▱` the work left. */
function segmentBar(
  segments: readonly { n: number; color: Style | ''; glyph?: string; dim?: boolean }[],
  colors: ColorSupport,
): string {
  return bar(
    segments.map((seg): Segment => ({
      n: seg.n,
      style: seg.color === '' || seg.dim === true ? 'muted' : seg.color,
      ...(seg.glyph !== undefined ? { cell: seg.glyph } : {}),
    })),
    colors,
  )
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
  /** Ran here with `cache: true`, succeeded, and saved nothing. */
  notSaved?: number
  /** Tasks that executed (success + failed) with `cache: true` — the misses. */
  miss: number
  /** Executed without `cache: true`: never consulted the cache, not a miss. */
  noCache?: number
  /**
   * Failed hits whose restore threw: in no cache count, neither a miss nor
   * a hit. They fill the cache bar as `failed` colours the tasks bar.
   */
  restoreFailed?: number
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
  /** Each finished task's id and cache bucket by its key and its id (its run bytes), so its remote traffic can move it. */
  buckets?: ReadonlyMap<string, TaskBucket>
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

/** A finished task's id and cache bucket, as `SummaryStats.buckets` holds them. */
export interface TaskBucket {
  task: string
  bucket: CacheBucket
}

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
      // A hit whose restore failed is in no bucket: not a miss, not a hit.
      if (o.restoreFailed === true) return undefined
      return ranNoCache(o) ? 'noCache' : 'miss'
    case 'cache-hit':
      return o.restored === false ? 'upToDate' : 'restoredLocal'
    case 'cache-hit-remote':
      return o.restored === false ? 'upToDate' : 'restoredRemote'
    default:
      return undefined
  }
}

type RemoteState = 'uploaded' | 'uploading' | 'remoteFailed'
const REMOTE_RANK: Record<RemoteState, number> = { uploaded: 0, uploading: 1, remoteFailed: 2 }
type Buckets = Record<CacheBucket | RemoteState, number>

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
  // A task's traffic may sit under its key (its entry) and its id (its run
  // bytes): it moves once, to the strongest state of the two.
  const moved = new Map<string, RemoteState>()
  for (const [key, k] of layers.traffic.keys) {
    const from = stats.buckets.get(key)
    // Still running: it counts once it ends.
    if (from === undefined) continue
    const state: RemoteState =
      k.failures.length > 0 ? 'remoteFailed' : k.uploading > 0 ? 'uploading' : 'uploaded'
    const prior = moved.get(from.task)
    if (prior === undefined) b[from.bucket]--
    if (prior === undefined || REMOTE_RANK[state] > REMOTE_RANK[prior]) moved.set(from.task, state)
  }
  for (const state of moved.values()) b[state]++
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
  /** A running task's live CPU and memory: its live row's `cpu` and `mem`. */
  usage?: (taskId: string) => { cores: number; rssBytes: number } | undefined
  /** Each task's count of the tasks downstream of it in the run, built on first ask: the rows' `blocks`. */
  blocks?: () => ReadonlyMap<string, number>
  /**
   * A task's usual duration from history, read once on the first ask;
   * undefined for a task it never timed: every row's `usual`.
   */
  usual?: (taskId: string) => number | undefined
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
  const restoreFailed = stats.restoreFailed ?? 0
  const left = stats.left ?? 0
  const aborted = stats.aborted ?? 0
  const notRun = stats.notRun ?? 0
  const running = stats.running ?? 0
  const scheduled = stats.scheduled ?? 0
  const blocked = stats.blocked ?? 0
  const remainder = {
    n: Math.max(0, left - running - scheduled - blocked),
    color: 'muted' as const,
    glyph: '\u25b1',
    dim: true,
  }

  const dim = (txt: string) => paint('muted', txt, colors)
  const row = (label: string, value: string): string => `  ${dim(label.padEnd(8))}  ${value}`
  const join = (parts: string[]): string => parts.join(` ${dim('\u00b7')} `)

  // Tasks meter + numbers, fixed order: failed · success · skipped ·
  // aborted · not run, then a dim total, last on its line. Every task in
  // the run counts, each state its own segment (2026-10-14).
  const runTotal = stats.total + aborted + notRun
  const taskParts: string[] = []
  if (stats.failed > 0) taskParts.push(paint('error', `${stats.failed} failed`, colors, true))
  if (stats.successful > 0) taskParts.push(paint('ok', `${stats.successful} success`, colors))
  if (stats.skipped > 0) taskParts.push(paint('warn', `${stats.skipped} skipped`, colors))
  if (aborted > 0) taskParts.push(paint('aborted', `${aborted} aborted`, colors))
  if (notRun > 0) taskParts.push(paint('notRun', `${notRun} not run`, colors))
  if (running > 0) taskParts.push(paint('warn', `${running} running`, colors))
  if (scheduled > 0) taskParts.push(dim(`${scheduled} scheduled`))
  if (blocked > 0) taskParts.push(dim(`${blocked} blocked`))
  // What is not done yet, running included: the count the bar's unfilled part shows.
  if (left > 0) taskParts.push(dim(`${left} left`))
  if (runTotal > 0) taskParts.push(dim(`${runTotal} total`))
  const taskBar = segmentBar(
    [
      { n: stats.failed, color: 'error' },
      { n: stats.successful, color: 'ok' },
      { n: stats.skipped, color: 'warn' },
      { n: aborted, color: 'aborted' },
      { n: notRun, color: 'notRun' },
      { n: running, color: 'warn' },
      { n: scheduled, color: 'muted', dim: true },
      { n: blocked, color: 'muted', dim: true },
      remainder,
    ],
    colors,
  )
  // Bars on the label row, color-coded legend on its own line below,
  // indented to the bar column (2 indent + 8 label + 2 gap = 12).
  const legend = (parts: string[]): string => `${' '.repeat(12)}${join(parts)}`
  // The panel's body; its box goes round it at the end.
  const lines: string[] = []

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
      lines.push(
        row('projects', gauge(cells, 'warn', colors)),
        legend([
          paint('warn', `${context.packageCount} affected`, colors),
          dim(`${wsTotal} total`),
        ]),
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
  if (miss + noCache + hits + left + stats.skipped + restoreFailed > 0) {
    const layers = context?.cache
    const b = cacheBuckets(stats, layers)
    const cacheBar = segmentBar(
      [
        { n: b.miss, color: 'error' },
        { n: b.notSaved, color: 'warn' },
        { n: b.noCache, color: 'muted', dim: true },
        { n: b.upToDate, color: 'ok' },
        { n: b.restoredLocal, color: 'local' },
        { n: b.saved, color: 'local' },
        { n: b.restoredRemote, color: 'remote' },
        { n: b.uploaded, color: 'remote' },
        { n: b.uploading, color: 'info' },
        { n: b.remoteFailed, color: 'error' },
        { n: restoreFailed, color: 'error' },
        { n: stats.skipped, color: 'warn' },
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
      const n = (count: number, glyph: string, color: Style): string[] =>
        count > 0 ? [paint(color, `${count}${glyph}`, colors)] : []
      const local = [
        ...(layers.local ? n(b.upToDate, '\u2713', 'ok') : []),
        ...n(b.noCache, '\u2205', 'muted'),
        ...(layers.local ? n(b.restoredLocal, '\u2193', 'local') : []),
        ...(layers.localWrite ? n(b.saved, '\u2191', 'local') : []),
      ]
      // The layer words are dim; only the counts carry colour (2026-10-15).
      if (local.length > 0) cacheParts.push(`${dim('local')} ${local.join(' ')}`)
      // Each transfer count is followed by its bytes, dim: what the
      // remote moved is the cost a hit or an upload paid.
      const sized = (count: number, glyph: string, bytes: number | undefined): string[] =>
        count === 0
          ? []
          : bytes === undefined || bytes === 0
            ? n(count, glyph, 'remote')
            : [...n(count, glyph, 'remote'), dim(formatBytes(bytes))]
      const remote = [
        ...sized(b.restoredRemote, '\u2193', layers.downloads?.bytes),
        ...sized(b.uploaded, '\u2191', layers.uploads?.bytes),
        ...n(b.remoteFailed, '\u2717', 'error'),
        ...n(b.uploading, '\u21e1', 'info'),
      ]
      if (layers.remote && remote.length > 0)
        cacheParts.push(`${dim('remote')} ${remote.join(' ')}`)
      if (b.miss > 0) cacheParts.push(paint('error', `${b.miss} miss`, colors))
      if (b.notSaved > 0) cacheParts.push(paint('warn', `${b.notSaved} not saved`, colors))
      const notDownloaded = layers.notDownloaded()
      if (notDownloaded > 0)
        cacheParts.push(paint('warn', `${notDownloaded} not downloaded`, colors))
    } else {
      if (miss > 0) cacheParts.push(paint('error', `${miss} miss`, colors))
      if (noCache > 0) cacheParts.push(paint('muted', `${noCache} no-cache`, colors))
      if (stats.upToDate > 0) cacheParts.push(paint('ok', `${stats.upToDate} up-to-date`, colors))
      if (stats.restoredLocal > 0)
        cacheParts.push(paint('local', `${stats.restoredLocal} local`, colors))
      if (stats.restoredRemote > 0)
        cacheParts.push(paint('remote', `${stats.restoredRemote} remote`, colors))
    }
    // Skipped tasks ride the bar, yellow like the tasks meter, and failed
    // restores red, so the two bars fill alike; their counts are the tasks
    // legend's alone (the footer never says a fact twice, 2026-10-14).
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
    timeParts.push(paint('info', `${formatEta(stats.etaMs)} left`, colors))
  else if (stats.overMs !== undefined)
    timeParts.push(paint('info', `${formatOver(stats.overMs)} over`, colors))
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
  // The Summary panel; the final one names the vx that ran it (the live
  // one has no context yet).
  // Two blank lines: the Summary stands apart from the task list above it.
  return [
    '',
    '',
    panelTop(
      'Summary',
      colors,
      undefined,
      context !== undefined ? `vx ${context.version}` : undefined,
    ),
    ...lines,
  ]
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
  return [row('warn', paint('warn', `${n} ${n === 1 ? 'warning' : 'warnings'} above`, colors))]
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
      const status = neverStarted(o)
        ? 'not run'
        : outcomeLabel(isKeyFailed(o) ? markKeyFailed(v) : v)
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
  const dim = (t: string) => paint('muted', t, colors)
  return [
    '',
    paint('heading', header, colors, true),
    dim('-'.repeat(header.length)),
    ...rows.map((r) => {
      const { node } = r.o
      const id =
        node.projectName !== undefined && node.taskName !== undefined
          ? idParts(node.projectName, node.projectName, node.taskName, colors)
          : r.task
      const status = paint(tableStatusColor(r.o), r.status, colors)
      return `${id}${pad(r.task, widths.task)}  ${status}${pad(r.status, widths.status)}  ${pad(r.duration, widths.duration)}${dim(r.duration)}`
    }),
  ]
}

function tableStatusColor(o: TaskOutcome): Style {
  switch (o.status) {
    case 'failed':
      return 'error'
    case 'skipped':
      return 'warn'
    case 'aborted':
      return neverStarted(o) ? 'notRun' : 'aborted'
    default:
      return 'ok'
  }
}

// Local byte formatter — the orchestrator can't import cli/format.ts
// (module boundary), and the footer only needs one compact form.
/**
 * Ran here with `cache: true`, succeeded, and its result was not saved.
 * Outputs left in the executor's store (`outputs: 'deferred'`) ran
 * elsewhere, whether or not the executor names a `where`.
 */
export function ranUnsaved(o: TaskOutcome): boolean {
  return (
    o.status === 'success' &&
    !ranNoCache(o) &&
    o.saved !== true &&
    o.where === undefined &&
    o.outputs !== 'deferred'
  )
}

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors: ColorSupport = NO_COLOR,
  context?: RunContext,
): string[] {
  // Counted here, not in the Tally: a task without `cache: true` never
  // consulted the cache, so it is not a miss.
  const noCache = outcomes.filter(
    (o) =>
      !isGroupTask(o.node) && (o.status === 'success' || o.status === 'failed') && ranNoCache(o),
  ).length
  const restoreFailed = outcomes.filter(
    (o) => !isGroupTask(o.node) && o.status === 'failed' && o.restoreFailed === true,
  ).length
  // A task with no key asked no cache and ran nothing: not a miss.
  const keyFailed = outcomes.filter(
    (o) => !isGroupTask(o.node) && o.status === 'failed' && isKeyFailed(o),
  ).length
  const t = tallyOutcomes(outcomes)
  // Spread over executed tasks only — `success`/`failed` statuses ran
  // a command; cache-hit statuses replayed one, and a failed restore ran none.
  const durations = outcomes
    .filter(
      (o) =>
        (o.status === 'success' ||
          (o.status === 'failed' && o.restoreFailed !== true && !isKeyFailed(o))) &&
        !isGroupTask(o.node),
    )
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
      miss:
        t.total -
        t.skipped -
        (t.cachedLocal + t.cachedRemote) -
        noCache -
        restoreFailed -
        keyFailed,
      noCache,
      ...(restoreFailed > 0 ? { restoreFailed } : {}),
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
      // Read only to move a task by its remote traffic.
      ...(context?.cache?.remote === true ? { buckets: bucketsOf(outcomes) } : {}),
    },
    totalMs,
    colors,
    context,
  )
}

/** Each finished task's cache bucket by its key and by its id. */
function bucketsOf(outcomes: readonly TaskOutcome[]): Map<string, TaskBucket> {
  const out = new Map<string, TaskBucket>()
  for (const o of outcomes) {
    const bucket = cacheBucketOf(o)
    if (bucket === undefined) continue
    const entry = { task: o.node.id, bucket }
    if (o.hash !== undefined) out.set(o.hash, entry)
    out.set(o.node.id, entry)
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
