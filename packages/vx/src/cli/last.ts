// `vx last [RUNID]` — replay a recorded run's summary from the terminal,
// without re-executing anything. Comparison gap #12: with the dashboard's
// run-detail page gone (the 2026-08-23 cloud removal), the local run
// history in cache.db is the only replay surface, and this verb reads it.
// Read-only — no config evaluation, no re-hash, no cache probe.

import type { Database } from 'bun:sqlite'
import { Cache } from '../cache/index.js'
import { formatBytes } from './format.js'
import { flagHint, formatValue, seeHelp } from './help.js'
import {
  type FailureMode,
  getInvocation,
  getRun,
  type InvocationDetail,
  listInvocations,
  LocalHistoryProvider,
  type RunSummaryRow,
} from '../history/index.js'
import {
  currentBranch,
  type LiveSnapshot,
  liveSocketPath,
  exitSignal,
  resolveRunId,
  runFailures,
  type RunStep,
  runSteps,
  runWarnings,
  shellQuote,
  shortRunId,
  taskLog,
} from '../orchestrator/index.js'
import { outcomeWord, type WireEvent } from '../report/index.js'
import {
  detectColors,
  ERROR,
  formatElapsed,
  parseDecimalInt,
  paint,
  refusal,
  splitTaskId,
  SUCCESS,
  UserError,
  sayNotice,
  ui,
  type ColorSupport,
} from '../util/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { findCwdProject, rootSpelled } from './select.js'
import { cliCacheDir, parseCacheDirFlag } from './workspace-config.js'

interface LastArgs {
  runId?: string
  list?: number
  /** Only runs that failed: the latest one replayed, or the list narrowed. */
  failed?: boolean
  format: 'pretty' | 'json'
  /** `--log <task>`: that task's output in the run, not the run's summary. */
  log?: string
  /** `--stats`: per-task numbers over the history window, not a run. */
  stats?: boolean
  /** `--stats`' positional: a task id, or a task name in every project. */
  task?: string
  /** `--branch`: the branch `--stats` forecasts from, as a run's `--branch`. */
  branch?: string
  /** `--cache-dir`: read the history a run with the same flag wrote. */
  cacheDir?: string
  /** `--sql <query>`: the history's rows a read-only query selects. */
  sql?: string
  /** `--live`: the run in progress, from the run itself. */
  live?: boolean
  /** `--follow`: with `--live`, the run's events from now to its end. */
  follow?: boolean
  error?: string
}

/**
 * A run id as typed beside `--list`: a UUIDv7's first group (8 hex digits)
 * at least, whole or cut as `--list` prints it.
 */
const RUN_ID_SHAPE = /^[0-9a-f]{8}(?:-|$)/i

export function parseLastArgs(args: readonly string[]): LastArgs {
  const out: LastArgs = { format: 'pretty' }
  // `vx last app#build --log`: a bare --log takes the positional as its task.
  let bareLog = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--list' || a.startsWith('--list=')) {
      // `--list 5` is the count, like every other value flag's space form:
      // it read as a run id, which `--list` then ignored, and ten runs came
      // back (item 899). The next argument is the count unless it is a flag
      // or has a run id's shape: `1.5`, `-3` and `abc` read as run ids and
      // were told a run id does not combine with --list (X-29).
      const next = args[i + 1]
      const spaced =
        a === '--list' &&
        next !== undefined &&
        (/^\d+$/.test(next) ||
          (!RUN_ID_SHAPE.test(next) && (!next.startsWith('-') || /^-\d/.test(next))))
      const lv = a === '--list' ? (spaced ? next : '10') : a.slice(7)
      if (spaced) i++
      if (lv === '')
        return {
          ...out,
          error: `--list= requires a count from 1 to 500; bare --list shows 10${seeHelp('last')}`,
        }
      const n = parseDecimalInt(lv)
      if (n === null || n < 1 || n > 500) {
        return {
          ...out,
          error: `--list must be a whole number from 1 to 500 (got ${lv})${seeHelp('last')}`,
        }
      }
      out.list = n
      continue
    }
    if (a === '--failed') {
      out.failed = true
      continue
    }
    if (a === '--stats') {
      out.stats = true
      continue
    }
    if (a === '--live') {
      out.live = true
      continue
    }
    if (a === '--follow') {
      out.follow = true
      continue
    }
    if (a === '--sql' || a.startsWith('--sql=')) {
      const v = a === '--sql' ? args[++i] : a.slice('--sql='.length)
      if (v === undefined || v.trim() === '') {
        return {
          ...out,
          error: `--sql requires a query, like 'SELECT * FROM runs'${seeHelp('last')}`,
        }
      }
      out.sql = v
      continue
    }
    if (a === '--branch' || a.startsWith('--branch=')) {
      const v = a === '--branch' ? args[++i] : a.slice('--branch='.length)
      if (v === undefined || v === '' || (a === '--branch' && v.startsWith('-'))) {
        return { ...out, error: `--branch requires a branch name${seeHelp('last')}` }
      }
      out.branch = v
      continue
    }
    if (a === '--log') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('-')) bareLog = true
      else {
        out.log = v
        i++
      }
      continue
    }
    if (a.startsWith('--log=')) {
      const v = a.slice('--log='.length)
      if (v === '') {
        return { ...out, error: `--log requires a task id, like app#build${seeHelp('last')}` }
      }
      out.log = v
      continue
    }
    if (a === '--format' || a.startsWith('--format=')) {
      const fv = formatValue(a === '--format' ? args[++i] : a.slice(9), 'last')
      if (typeof fv === 'object') return { ...out, ...fv }
      out.format = fv
      continue
    }
    const cd = parseCacheDirFlag(args, i)
    if (cd !== null) {
      if ('error' in cd) return { ...out, error: `${cd.error}${seeHelp('last')}` }
      out.cacheDir = cd.cacheDir
      i = cd.next
      continue
    }
    if (a.startsWith('-'))
      return { ...out, error: `unknown flag: ${a}${flagHint('last', a)}${seeHelp('last')}` }
    if (out.runId !== undefined)
      return { ...out, error: `unexpected argument: ${a}${seeHelp('last')}` }
    out.runId = a
  }
  if (out.follow === true && out.live !== true) {
    return { ...out, error: `--follow needs --live${seeHelp('last')}` }
  }
  if (out.live === true) {
    const other = [out.runId, out.list, out.failed, out.log, out.stats, out.branch, out.sql]
    if (bareLog || other.some((v) => v !== undefined)) {
      return {
        ...out,
        error: `--live combines only with --follow, --format and --cache-dir${seeHelp('last')}`,
      }
    }
    return out
  }
  if (out.sql !== undefined) {
    const other = [out.runId, out.list, out.failed, out.log, out.stats, out.branch]
    if (bareLog || other.some((v) => v !== undefined)) {
      return {
        ...out,
        error: `--sql combines only with --format and --cache-dir${seeHelp('last')}`,
      }
    }
    return out
  }
  if (bareLog) {
    if (out.runId === undefined) {
      return { ...out, error: `--log requires a task id, like app#build${seeHelp('last')}` }
    }
    out.log = out.runId
    delete out.runId
  }
  if (out.stats === true) {
    if (out.list !== undefined || out.failed === true || out.log !== undefined) {
      return {
        ...out,
        error: `--stats does not combine with --list, --failed or --log${seeHelp('last')}`,
      }
    }
    if (out.runId !== undefined) out.task = out.runId
    delete out.runId
    return out
  }
  if (out.branch !== undefined) {
    return { ...out, error: `--branch combines only with --stats${seeHelp('last')}` }
  }
  // One run's replay or a list of runs, not both: the id was dropped.
  // Beside --list, a word no run id could be is just an extra one.
  if (out.runId !== undefined && out.list !== undefined && !RUN_ID_SHAPE.test(out.runId)) {
    return { ...out, error: `unexpected argument: ${out.runId}${seeHelp('last')}` }
  }
  if (out.runId !== undefined && out.list !== undefined) {
    return {
      ...out,
      error: `a run id and --list do not combine: replay ${out.runId}, or list runs${seeHelp('last')}`,
    }
  }
  if (out.log !== undefined && (out.list !== undefined || out.failed === true)) {
    return {
      ...out,
      error: `--log reads one task's output and combines only with a run id${seeHelp('last')}`,
    }
  }
  if (out.runId !== undefined && out.failed === true) {
    return {
      ...out,
      error: `a run id and --failed do not combine: replay ${out.runId}${seeHelp('last')}`,
    }
  }
  return out
}

/** The `limit` most recent runs that failed, newest first. */
function failedInvocations(db: Database, limit: number): InvocationDetail[] {
  const ids = db
    .query('SELECT run_id FROM invocations WHERE exit_ok = 0 ORDER BY rowid DESC LIMIT ?')
    .all(limit) as Array<{ run_id: string }>
  return ids.map((r) => getInvocation(db, r.run_id)).filter((i) => i !== null)
}

/** One task's numbers over the window, every key present (`null` where unknown). */
export interface TaskStats {
  taskId: string
  runs: number
  p50DurationMs: number | null
  p99DurationMs: number | null
  successRate: number
  hitRate: number
  failureMode: FailureMode
  maxPeakRssBytes: number | null
  maxCpuParallelism: number | null
}

/**
 * `--stats`: what the scheduler and `--dry` learn from history, per task,
 * over the same window (`LocalHistoryProvider`), with the p50 a run on
 * `branch` forecasts.
 */
async function printStats(
  db: Database,
  target: string | undefined,
  format: 'pretty' | 'json',
  branch: string | null,
): Promise<number> {
  const provider = new LocalHistoryProvider(db, undefined, branch)
  const matches = (id: string): boolean =>
    target === undefined || (target.includes('#') ? id === target : splitTaskId(id)[1] === target)
  const stats: TaskStats[] = [...(await provider.loadAll())]
    .filter(([id]) => matches(id))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([taskId, h]) => ({
      taskId,
      runs: h.runs,
      p50DurationMs: h.p50DurationMs ?? null,
      p99DurationMs: h.p99DurationMs ?? null,
      successRate: h.successRate,
      hitRate: h.hitRate,
      failureMode: h.failureMode,
      maxPeakRssBytes: h.maxPeakRssBytes ?? null,
      maxCpuParallelism: h.maxCpuParallelism ?? null,
    }))
  if (stats.length === 0 && target !== undefined) {
    throw new UserError(
      `vx last: no recorded run of ${target} in the last ${provider.recent} runs`,
      'VX_E_NO_HISTORY',
    )
  }
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ window: provider.recent, branch, stats })}\n`)
    return 0
  }
  if (stats.length === 0) {
    ui.print('out', ui.status('info', 'vx last', 'no runs yet'))
    return 0
  }
  const pct = (r: number): string => `${Math.round(r * 100)}%`
  const ms = (v: number | null): string => (v === null ? '-' : fmtMs(v))
  const rows = [
    ['task', 'runs', 'p50', 'p99', 'pass', 'hit', 'failure mode', 'peak rss', 'cpu'],
    ...stats.map((s) => [
      s.taskId,
      String(s.runs),
      ms(s.p50DurationMs),
      ms(s.p99DurationMs),
      pct(s.successRate),
      pct(s.hitRate),
      s.failureMode,
      s.maxPeakRssBytes === null ? '-' : formatBytes(s.maxPeakRssBytes),
      s.maxCpuParallelism === null ? '-' : `${s.maxCpuParallelism.toFixed(1)}×`,
    ]),
  ]
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)))
  const c = detectColors(process.stdout)
  const lines = rows.map((r, i) =>
    r
      .map((cell, col) => {
        const padded = col === r.length - 1 ? cell : cell.padEnd(widths[col]!)
        if (i === 0) return paint('', padded, c, { dim: true })
        return col === 0 ? `${ui.inline(ui.id(cell), c)}${padded.slice(cell.length)}` : padded
      })
      .join('  ')
      .trimEnd(),
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/**
 * `--sql`: one SELECT over the history (`runs`, `invocations`, and the
 * store's `entries`, `entry_inputs`, `task_durations`, `task_outcomes`),
 * so an agent asks what no flag answers: a task's memory trend, the
 * flakiest project, which input moved a key. `query_only` stops a write
 * the statement hides (`WITH … DELETE`); it does not stop ATTACH, which
 * creates a file, hence only SELECT or WITH may lead.
 */
function printQuery(db: Database, sql: string, format: 'pretty' | 'json'): number {
  if (!/^\s*(select|with)\b/i.test(sql)) {
    throw new UserError(
      `vx last: --sql reads only: one SELECT (or WITH … SELECT) over the history`,
      'VX_E_USAGE',
    )
  }
  db.exec('PRAGMA query_only = ON')
  let rows: Array<Record<string, unknown>>
  try {
    rows = db.query(sql).all() as Array<Record<string, unknown>>
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/readonly|query_only/i.test(message)) {
      throw new UserError(`vx last: --sql reads only: ${message}`, 'VX_E_USAGE')
    }
    throw new UserError(`vx last: --sql: ${message}`, 'VX_E_USAGE')
  }
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ rows })}\n`)
    return 0
  }
  if (rows.length === 0) return 0
  // A column's value as SQLite returns it: TEXT, a number, NULL or a BLOB.
  const cell = (v: string | number | bigint | Uint8Array | null): string =>
    v === null || v === undefined
      ? '-'
      : v instanceof Uint8Array
        ? `<${v.length} bytes>`
        : String(v)
  const table = [
    Object.keys(rows[0]!),
    ...rows.map((r) => Object.values(r).map((v) => cell(v as Parameters<typeof cell>[0]))),
  ]
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => r[c]!.length)))
  const lines = table.map((r) =>
    r
      .map((v, c) => v.padEnd(widths[c]!))
      .join('  ')
      .trimEnd(),
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/** How long a run has to answer before `--live` gives up on it. */
const LIVE_ANSWER_MS = 5_000

/**
 * `--live`: ask the run in progress (orchestrator/run-live.ts) for its
 * snapshot, and with `--follow` print its events until it lets go. The
 * history is not opened: the run itself answers.
 */
async function printLive(
  root: string,
  follow: boolean,
  format: 'pretty' | 'json',
): Promise<number> {
  const none = (): never => {
    throw refusal(
      { tone: 'info', headline: 'no run in progress', fix: 'vx last' },
      {
        code: 'VX_E_NO_HISTORY',
        message: 'vx last: no run in progress — `vx last` reads the last one',
      },
    )
  }
  let buffered = ''
  let snapshot: LiveSnapshot | undefined
  let settle!: (answered: boolean) => void
  const done = new Promise<boolean>((resolve) => (settle = resolve))
  const line = (text: string): void => {
    if (snapshot === undefined) {
      snapshot = JSON.parse(text) as LiveSnapshot
      if (format === 'json') process.stdout.write(`${text}\n`)
      else process.stdout.write(`${formatLive(snapshot).join('\n')}\n`)
      return
    }
    if (format === 'json') process.stdout.write(`${text}\n`)
    else process.stdout.write(formatLiveEvent(JSON.parse(text) as WireEvent))
  }
  try {
    await Bun.connect({
      unix: liveSocketPath(root),
      socket: {
        open(sock) {
          sock.write(follow ? 'follow\n' : 'snapshot\n')
        },
        data(_sock, chunk) {
          buffered += chunk.toString()
          for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
            line(buffered.slice(0, at))
            buffered = buffered.slice(at + 1)
          }
        },
        close() {
          settle(snapshot !== undefined)
        },
        error() {
          settle(snapshot !== undefined)
        },
      },
    })
  } catch {
    // ENOENT, ECONNREFUSED: no run listens there (a killed run's socket).
    none()
  }
  const timer = follow
    ? undefined
    : setTimeout(() => settle(snapshot !== undefined), LIVE_ANSWER_MS)
  const answered = await done
  clearTimeout(timer)
  if (!answered) none()
  return 0
}

function formatLive(s: LiveSnapshot): string[] {
  const count = (status: string): number => s.tasks.filter((t) => t.status === status).length
  const running = count('running')
  const waiting = count('waiting')
  const failed = count('failed')
  const lines = [
    `run ${s.live.runId} — running ${fmtMs(s.live.elapsedMs)}`,
    `  $ ${s.live.command}`,
    `  ${running} running · ${s.tasks.length - running - waiting} ended${failed > 0 ? ` · ${failed} failed` : ''} · ${waiting} waiting`,
    '',
  ]
  const width = Math.max(...s.tasks.map((t) => t.status.length), 7)
  const idWidth = Math.max(...s.tasks.map((t) => t.taskId.length), 0)
  const now = s.live.startedAt + s.live.elapsedMs
  for (const t of s.tasks) {
    const ms =
      t.durationMs !== null ? t.durationMs : t.startedAt !== null ? now - t.startedAt : null
    lines.push(
      `  ${t.status.padEnd(width)}  ${ms === null ? t.taskId : `${t.taskId.padEnd(idWidth)}  ${fmtMs(ms)}`}`,
    )
  }
  if (s.warnings.length > 0) {
    lines.push('', '  warnings', ...s.warnings.flatMap((w) => w.split('\n').map((l) => `    ${l}`)))
  }
  return lines
}

/** One followed event as a line: a task's output prefixed by its id, an end, a warning. */
function formatLiveEvent(e: WireEvent): string {
  switch (e.kind) {
    case 'task:stdout':
    case 'task:stderr':
      return e.chunk
        .replace(/\n$/, '')
        .split('\n')
        .map((l) => `${e.taskId} │ ${l}\n`)
        .join('')
    case 'task:complete':
      return `${outcomeWord(e.outcome)}  ${e.outcome.taskId}  ${fmtMs(e.outcome.durationMs)}\n`
    case 'run:status':
      return 'warn' in e ? `warn  ${Bun.stripANSI(e.line)}\n` : ''
    default:
      return ''
  }
}

const fmtWhen = (ms: number): string => new Date(ms).toISOString()

const fmtMs = (ms: number): string => formatElapsed(ms, true)

/**
 * What an executed task used — its peak RSS and its CPU parallelism (CPU
 * time over wall time) — as the runner recorded them. This is the number
 * `@vzn/vx-history` reserves from, so the replay shows it where
 * a developer can read it; a hit spent nothing and shows nothing.
 */
function fmtUsage(t: {
  cpuMs: number | null
  peakRssBytes: number | null
  durationMs: number
}): string {
  const parts: string[] = []
  if (t.peakRssBytes !== null) parts.push(formatBytes(t.peakRssBytes))
  if (t.cpuMs !== null && t.durationMs > 0)
    parts.push(`${(t.cpuMs / t.durationMs).toFixed(1)}× cpu`)
  return parts.length > 0 ? `  ${parts.join(' · ')}` : ''
}

/**
 * Why a row failed or was skipped, as the run's own footer said it (the
 * v27 columns): a timeout or a never-ready server instead of the signal
 * their exit stands for, the sandbox's violation count, a skip's blocker.
 * Older rows carry none and read as before.
 */
function reasonParts(t: RunSummaryRow, skippedHere: ReadonlySet<string>): string {
  const parts: string[] = []
  if (t.status === 'failed') {
    if (t.notReady !== null) {
      parts.push(
        `never ready: ${t.notReady === 'timeout' ? 'timed out' : t.notReady === 'exited' ? 'exited' : 'spawn failed'}`,
      )
    } else if (t.timedOut === true) {
      parts.push('timed out')
    } else {
      const signal = exitSignal(t.exitCode)
      if (signal !== undefined) parts.push(`128 + ${signal}`)
    }
    if (t.sandboxViolations !== null && t.sandboxViolations > 0) {
      parts.push(`${t.sandboxViolations} sandbox violation${t.sandboxViolations === 1 ? '' : 's'}`)
    }
  } else if (t.status === 'skipped' && t.blockedBy !== null) {
    // A blocker that is itself a skip is a platform skip: a failure's
    // dependants name the failure, never a skip between.
    parts.push(
      skippedHere.has(t.blockedBy)
        ? `after ${t.blockedBy} skipped: ${OTHER_PLATFORM}`
        : `after ${t.blockedBy} failed`,
    )
  } else if (t.status === 'skipped' && t.exitCode === 0) {
    // Exit 0 with no blocker is a platform skip; a fail-fast skip records 1.
    parts.push(OTHER_PLATFORM)
  }
  if (t.remoteError !== null) parts.push(`remote \u2717 ${t.remoteError}`)
  return parts.map((p) => `  ${p}`).join('')
}

const OTHER_PLATFORM = 'needs another platform'

/** Hit rows shown before the rest fold — the slowest restores. */
const HITS_SHOWN = 16

/**
 * The steps the run did not wait on (`vx:prefetch`), which its own output
 * never showed (2026-10-16): here for debugging, marked `internal`.
 */
function formatStepRows(steps: readonly RunStep[], c: ColorSupport): string[] {
  if (steps.length === 0) return []
  const idW = Math.max(...steps.map((s) => s.id.length), 4)
  return [
    '',
    ...steps.map(
      (s) =>
        `  ${paint(s.ok ? SUCCESS : ERROR, (s.ok ? 'success' : 'failed').padEnd(17), c)} ${paint('', s.id.padEnd(idW), c, { bold: true })}  ${paint('', `${fmtMs(s.durationMs).padStart(8)}  internal`, c, { dim: true })}`,
    ),
  ]
}

/**
 * The per-task rows: failures first, then what executed or was skipped,
 * then cache hits. Hits are the noise of a warm run — 996 of a thousand
 * rows on a red run put the failure a screen's height above the prompt
 * (item 280) — so past `HITS_SHOWN` they fold into one line with their
 * count; the ones shown are the slowest restores, the one thing a hit's
 * row tells. `--format json` lists every row.
 */

export function formatTaskRows(
  tasks: readonly RunSummaryRow[],
  c: ColorSupport = { enabled: false },
): string[] {
  if (tasks.length === 0) return []
  const failed = tasks.filter((t) => t.status === 'failed')
  const hits = tasks.filter((t) => t.status !== 'failed' && t.cacheHit === true)
  const rest = tasks.filter((t) => t.status !== 'failed' && t.cacheHit !== true)
  const folded = hits.length > HITS_SHOWN
  const shownHits = folded
    ? [...hits].sort((a, b) => b.durationMs - a.durationMs).slice(0, HITS_SHOWN)
    : hits
  const ordered = [...failed, ...rest, ...shownHits]
  const at = (t: (typeof ordered)[number]): string =>
    t.placement !== null ? `@${t.placement}` : ''
  const idW = Math.max(...ordered.map((t) => `${t.project}#${t.task}${at(t)}`.length), 4)
  const skippedHere = new Set(
    tasks.filter((t) => t.status === 'skipped').map((t) => `${t.project}#${t.task}`),
  )
  const lines = ['']
  for (const t of ordered) {
    const id = `${t.project}#${t.task}${at(t)}`
    // The terminal summary's own word for a task that runs every time
    // by design; a reader must not take its row for a miss.
    // A failure's row reads as the frame did — `failed (exit 137)` —
    // and above 128 names the signal the number stands for (260).
    // A hit reads as the run's own summary said it: up-to-date (nothing
    // restored) or restored-local / restored-remote.
    const status =
      t.status === 'failed'
        ? `failed (exit ${t.exitCode})`
        : t.cacheHit === true && t.restored !== null
          ? outcomeWord({ status: t.status as 'cache-hit', restored: t.restored })
          : t.status
    const hue = t.status === 'failed' ? ERROR : t.status === 'skipped' ? '' : SUCCESS
    lines.push(
      `  ${paint(hue, status.padEnd(17), c, { dim: hue === '' })} ${ui.inline(ui.id(id), c)}${' '.repeat(idW - id.length)}  ${fmtMs(t.durationMs).padStart(8)}` +
        paint(
          '',
          `${t.hash !== '' ? `  ${t.hash}` : ''}${t.cached === false ? '  no-cache' : ''}${fmtUsage(t)}` +
            reasonParts(t, skippedHere),
          c,
          { dim: true },
        ),
    )
  }
  if (folded) {
    lines.push(
      paint(
        '',
        `  … +${hits.length - HITS_SHOWN} more cache hit${hits.length - HITS_SHOWN === 1 ? '' : 's'} (the ${HITS_SHOWN} slowest restores shown) — vx last --format json lists every row`,
        c,
        { dim: true },
      ),
    )
  }
  return lines
}

/**
 * A run's hits by what they did to the disk, as its summary counted them:
 * `5 hits (3 up-to-date, 2 restored: 1 local, 1 remote)`; the layers only
 * when something was restored.
 */
function hitsLine(
  inv: Pick<
    InvocationDetail,
    'hitCount' | 'upToDateCount' | 'restoredLocalCount' | 'restoredRemoteCount'
  >,
): string {
  const hits = `${inv.hitCount} hit${inv.hitCount === 1 ? '' : 's'}`
  if (inv.hitCount === 0) return hits
  const restored = inv.restoredLocalCount + inv.restoredRemoteCount
  const layers =
    restored > 0 ? `: ${inv.restoredLocalCount} local, ${inv.restoredRemoteCount} remote` : ''
  return `${hits} (${inv.upToDateCount} up-to-date, ${restored} restored${layers})`
}

/**
 * `vx last --list`'s rows, in columns: the counts vary with what a run
 * hit and failed, so unpadded they pushed each run's duration and command
 * to a different column and the list could not be scanned down.
 */
export function formatRunList(
  runs: readonly {
    inv: Pick<
      InvocationDetail,
      | 'exitOk'
      | 'startedAt'
      | 'taskCount'
      | 'failedCount'
      | 'totalDurationMs'
      | 'command'
      | 'hitCount'
      | 'upToDateCount'
      | 'restoredLocalCount'
      | 'restoredRemoteCount'
    >
    id: string
  }[],
  c: ColorSupport = { enabled: false },
): string[] {
  const rows = runs.map(({ inv, id }) => ({
    head: `${inv.exitOk ? 'ok    ' : 'FAILED'} ${fmtWhen(inv.startedAt)}`,
    id,
    counts: `${inv.taskCount} task${inv.taskCount === 1 ? '' : 's'} · ${hitsLine(inv)}`,
    failed: inv.failedCount > 0 ? ` · ${inv.failedCount} failed` : '',
    ms: fmtMs(inv.totalDurationMs),
    command: inv.command,
  }))
  const idW = Math.max(...rows.map((r) => r.id.length))
  const countsW = Math.max(...rows.map((r) => r.counts.length + r.failed.length))
  const msW = Math.max(...rows.map((r) => r.ms.length))
  return rows.map(
    (r) =>
      `${paint(r.head.startsWith('ok') ? SUCCESS : ERROR, r.head.slice(0, 6), c)}${paint('', r.head.slice(6), c, { dim: true })}  ${paint('', r.id.padEnd(idW), c, { bold: true })}  ${paint('', r.counts, c, { dim: true })}${paint(ERROR, r.failed, c)}${paint('', `${' '.repeat(countsW - r.counts.length - r.failed.length)}  ${r.ms.padStart(msW)}  $`, c, { dim: true })} ${r.command}`,
  )
}

/**
 * A bare task name as `--log` reads it: the one project that ran it, the
 * cwd's among several (as `vx why` picks), else refused naming them. It
 * read as an id and said "no recorded run of build" for a task that ran.
 */
async function bareTaskId(db: Database, task: string): Promise<string> {
  if (task.includes('#')) return task
  const ids = (
    db.query('SELECT DISTINCT project FROM runs WHERE task = ? ORDER BY project').all(task) as {
      project: string
    }[]
  ).map((r) => `${r.project}#${task}`)
  if (ids.length <= 1) return ids[0] ?? task
  const here = await findCwdProject(process.cwd())
  if (here !== null && ids.includes(`${here}#${task}`)) return `${here}#${task}`
  throw new UserError(
    `vx last: "${task}" ran in ${ids.length} projects — pick one:\n${ids.map((id) => `  ${id}`).join('\n')}`,
    'VX_E_AMBIGUOUS',
  )
}

export async function lastCmd(args: readonly string[]): Promise<number> {
  const parsed = parseLastArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx last: ${parsed.error}`, 'VX_E_USAGE')

  const root = await findWorkspaceRoot(process.cwd())
  if (parsed.live === true) return await printLive(root, parsed.follow === true, parsed.format)
  const cacheDir = await cliCacheDir(root, parsed.cacheDir)
  const cache = Cache.inspect(cacheDir)
  try {
    const db = cache.dbHandle()
    // Nothing recorded at all is its own answer: `--failed` said "no
    // recorded run failed" and a run id pointed at a `--list` that lists
    // nothing, while `--list --failed` past green runs said there were none.
    const noRuns = (): boolean => listInvocations(db, { limit: 1 }).length === 0

    if (parsed.sql !== undefined) return printQuery(db, parsed.sql, parsed.format)

    if (parsed.stats === true) {
      const branch = currentBranch(root, undefined, parsed.branch)
      const task = parsed.task === undefined ? undefined : await rootSpelled(root, parsed.task)
      return await printStats(db, task, parsed.format, branch)
    }

    if (parsed.log !== undefined) {
      const runId =
        parsed.runId === undefined
          ? undefined
          : (resolveRunId(db, parsed.runId, 'vx last') ?? parsed.runId)
      const log = taskLog(
        cacheDir,
        db,
        await bareTaskId(db, await rootSpelled(root, parsed.log)),
        runId,
      )
      if (log === null) {
        throw new UserError(
          `vx last: no recorded run of ${parsed.log}${parsed.runId === undefined ? '' : ` in run ${parsed.runId}`} (a task id is project#task)`,
          'VX_E_NO_HISTORY',
        )
      }
      if (parsed.format === 'json') {
        process.stdout.write(`${JSON.stringify(log)}\n`)
        return 0
      }
      if (log.source === null) {
        // A cached task with no entry was not saved (a read-only policy) or
        // was pruned; calling it uncached sends the user to the config.
        const [project, task] = splitTaskId(log.taskId)
        const cached =
          log.status !== 'failed' &&
          (
            db
              .query('SELECT cached FROM runs WHERE run_id = ? AND project = ? AND task = ?')
              .get(log.runId, project, task) as { cached: number | null } | null
          )?.cached === 1
        sayNotice(
          'info',
          'vx last',
          log.status === 'failed'
            ? `${log.taskId} ended failed, and vx kept no output for it: it keeps the newest 50 failed runs`
            : cached
              ? `${log.taskId} ended ${log.status}, and its entry is not in the cache: the run did not save it, or it was pruned since`
              : `${log.taskId} ended ${log.status}. vx keeps output only for failed and cached tasks`,
        )
      } else if (log.output === '') {
        sayNotice('info', 'vx last', `${log.taskId} ended ${log.status} and printed nothing`)
      }
      process.stdout.write(log.output)
      return 0
    }

    if (parsed.list !== undefined) {
      const invocations =
        parsed.failed === true
          ? failedInvocations(db, parsed.list)
          : listInvocations(db, { limit: parsed.list })
      if (parsed.format === 'json') {
        process.stdout.write(`${JSON.stringify(invocations)}\n`)
        return 0
      }
      if (invocations.length === 0) {
        const none = parsed.failed === true && !noRuns() ? 'no failed runs' : 'no runs yet'
        ui.print('out', ui.status('info', 'vx last', none))
        return 0
      }
      const lines = formatRunList(
        invocations.map((inv) => ({ inv, id: shortRunId(db, inv.runId) })),
        detectColors(process.stdout),
      )
      process.stdout.write(`${lines.join('\n')}\n`)
      return 0
    }

    const inv =
      parsed.runId !== undefined
        ? getInvocation(db, resolveRunId(db, parsed.runId, 'vx last') ?? parsed.runId)
        : parsed.failed === true
          ? (failedInvocations(db, 1)[0] ?? null)
          : (listInvocations(db, { limit: 1 })[0] ?? null)
    if ((inv === null || inv === undefined) && noRuns()) {
      throw refusal(
        { tone: 'info', headline: 'no runs yet', fix: 'vx run' },
        { code: 'VX_E_NO_HISTORY', message: 'vx last: no recorded runs yet — run something first' },
      )
    }
    if (inv === null || inv === undefined) {
      throw new UserError(
        noRuns()
          ? 'vx last: no recorded runs yet — run something first'
          : parsed.runId?.includes('#') === true
            ? `vx last: ${parsed.runId} is a task, not a run id — \`vx last --log ${parsed.runId}\` prints its output, \`vx last --stats ${parsed.runId}\` its durations`
            : parsed.runId !== undefined
              ? `vx last: no recorded run ${parsed.runId} (vx last --list shows recent runs)`
              : parsed.failed === true
                ? 'vx last: no recorded run failed'
                : 'vx last: no recorded runs yet — run something first',
        'VX_E_NO_HISTORY',
      )
    }
    const detail = getRun(db, inv.runId)

    if (parsed.format === 'json') {
      const failures = new Map(
        (runFailures(cacheDir, db, inv.runId)?.tasks ?? []).map((f) => [f.taskId, f]),
      )
      const tasks = (detail?.tasks ?? []).map((t) => {
        const f = failures.get(`${t.project}#${t.task}`)
        return f === undefined
          ? t
          : {
              ...t,
              ...(f.inputMoved !== undefined ? { inputMoved: f.inputMoved } : {}),
              output: f.output,
              locations: f.locations,
              ...(f.sandboxFix !== undefined ? { sandboxFix: f.sandboxFix } : {}),
              ...(f.fixedIn !== undefined ? { fixedIn: f.fixedIn } : {}),
            }
      })
      const steps = runSteps(cacheDir, inv.runId)
      const warnings = runWarnings(cacheDir, inv.runId)
      process.stdout.write(
        `${JSON.stringify({
          invocation: inv,
          tasks,
          ...(steps.length > 0 ? { steps } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        })}\n`,
      )
      return 0
    }

    const c = detectColors(process.stdout)
    const dim = (s: string): string => paint('', s, c, { dim: true })
    const lines: string[] = []
    lines.push(
      `${paint('', 'run', c, { bold: true })} ${paint('', inv.runId, c, { bold: true })} ${dim('—')} ${inv.exitOk ? paint(SUCCESS, 'ok', c) : paint(ERROR, 'FAILED', c)}`,
    )
    lines.push(`  ${dim('$')} ${paint('', inv.command, c, { bold: true })}`)
    lines.push(
      dim(
        `  ${fmtWhen(inv.startedAt)} · ${fmtMs(inv.totalDurationMs)}` +
          `${inv.branch !== null ? ` · ${inv.branch}` : ''}` +
          `${inv.commitSha !== null ? ` @ ${inv.commitSha.slice(0, 8)}${inv.dirty === true ? '+dirty' : ''}` : ''}` +
          `${inv.ci ? ` · CI${inv.ciProvider !== null ? ` (${inv.ciProvider})` : ''}` : ''}`,
      ),
    )
    lines.push(
      dim(`  ${inv.taskCount} task${inv.taskCount === 1 ? '' : 's'} · ${hitsLine(inv)}`) +
        `${inv.failedCount > 0 ? paint(ERROR, ` · ${inv.failedCount} failed`, c) : ''}`,
    )
    lines.push(...formatTaskRows(detail?.tasks ?? [], c))
    lines.push(...formatStepRows(runSteps(cacheDir, inv.runId), c))
    const warnings = runWarnings(cacheDir, inv.runId)
    if (warnings.length > 0) {
      lines.push('', '  warnings', ...warnings.flatMap((w) => w.split('\n').map((l) => `    ${l}`)))
    }
    // The next command after reading a failed run, with the arguments the
    // run forwarded to the tasks that got them (a failure under `-- --shard
    // 2` is that shard's); a dependency never got them, so its line has none.
    const failed = (detail?.tasks ?? []).filter((t) => t.status === 'failed')
    if (failed.length > 0) {
      const at = inv.command.indexOf(' -- ')
      const args = at === -1 ? '' : inv.command.slice(at)
      const rerun: string[] = []
      for (const withArgs of [false, true]) {
        const ids = failed
          .filter((t) => t.forwarded === withArgs)
          .map((t) => shellQuote(`${t.project}#${t.task}`))
        if (ids.length > 0)
          rerun.push(
            `  ${dim('re-run what failed:')} ${paint('', `vx run ${ids.join(' ')}${withArgs ? args : ''}`, c, { bold: true })}`,
          )
      }
      lines.push('', ...rerun)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } finally {
    cache.close()
  }
}
