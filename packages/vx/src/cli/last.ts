// `vx last [RUNID]` — replay a recorded run's summary from the terminal,
// without re-executing anything. Comparison gap #12: with the dashboard's
// run-detail page gone (the 2026-08-23 cloud removal), the local run
// history in cache.db is the only replay surface, and this verb reads it.
// Read-only — no config evaluation, no re-hash, no cache probe; `--stats`
// reads the lock only for each task's definition.

import type { Database } from 'bun:sqlite'
import {
  indexDb,
  indexError,
  Cache,
  keptSteps,
  keptWarnings,
  type RunStep,
} from '../cache/index.js'
import { buildTaskGraph, expandRequested, isDefaultBuild, taskDefinitions } from '../graph/index.js'
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
  applyGraphStage,
  currentBranch,
  hasHook,
  type LiveSnapshot,
  liveSocketPath,
  exitSignal,
  resolveRunId,
  runFailures,
  shellQuote,
  shortRunId,
  taskLog,
} from '../orchestrator/index.js'
import {
  formatRecordedRow,
  formatSize,
  outcomeWord,
  taskList,
  type WireEvent,
} from '../report/index.js'
import {
  formatElapsed,
  nearest,
  parseDecimalInt,
  refusal,
  splitTaskId,
  UserError,
} from '../util/index.js'
import * as ui from '../ui/index.js'
import { sayNotice } from '../ui/index.js'
import { runRules } from '../settings.js'
import { buildPackageGraph, findWorkspaceRoot } from '../workspace/index.js'
import { findCwdProject } from './select.js'
import {
  cliCacheDir,
  loadCliProjects,
  parseCacheDirFlag,
  rootSpelled,
  stageCacheDir,
  verbWorkspace,
  type VerbWorkspace,
} from './workspace-config.js'

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

/** The run grid's mark for a number history does not hold. */
const UNKNOWN = '\u2014'

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
      // The space form took the next flag as the query, then blamed that
      // flag for combining with --sql.
      const flag =
        a === '--sql' && v?.startsWith('-') === true
          ? ` (got flag ${v}; a query that starts with - needs --sql=${v})`
          : ''
      if (v === undefined || v.trim() === '' || flag !== '') {
        return {
          ...out,
          error: `--sql requires a query, like 'SELECT * FROM runs'${flag}${seeHelp('last')}`,
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
      if (v === '') {
        return { ...out, error: `--log requires a task id, like app#build${seeHelp('last')}` }
      }
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
    // Empty is no run id: '' is the start of every one.
    if (a === '') continue
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
 * Each task's definition (`taskDefinitions`) as a run builds the graph
 * now: the lock's configs with the `project` and `graph` stages applied.
 * Undefined when none loads (no lock, a broken config): then every
 * definition's rows are read, as before definitions were kept.
 */
async function definitionsNow(
  at: VerbWorkspace,
  cacheDir: string | undefined,
): Promise<Map<string, string> | undefined> {
  try {
    const { root } = at
    // A plugin's warning is the run's to say, not a history read's.
    const opts = { warn: () => {}, ...(cacheDir === undefined ? {} : { cacheDir }) }
    const metas = await at.projects()
    const projects = await loadCliProjects(root, metas, 'all', opts)
    const ws = await at.workspace()
    const rules = runRules(ws.workspaceConfig)
    const names = new Set<string>()
    for (const p of projects.values())
      for (const t of Object.keys(p.config.tasks ?? {})) names.add(t)
    const nodes = buildTaskGraph({
      projects,
      packageGraph: buildPackageGraph(metas),
      requested: expandRequested([...names], [...projects.keys()], projects, isDefaultBuild),
      workspaceRoot: root,
      rules,
    })
    if (hasHook(ws.plugins, 'graph'))
      await applyGraphStage(ws.plugins, nodes, {
        workspaceRoot: root,
        cacheDir: stageCacheDir(ws, opts),
        projectMetas: metas,
        warn: opts.warn,
        rules,
      })
    return taskDefinitions(nodes.values())
  } catch {
    return undefined
  }
}

/** Each task's definition as run `runId` recorded it: what its live rows read history by. */
function runDefinitions(db: Database, runId: string): Map<string, string> {
  const rows = db
    .query(
      `SELECT r.project, r.task, r.def FROM main.runs r JOIN main.run_ids k ON k.id = r.run
       WHERE k.run_id = ? AND r.def IS NOT NULL`,
    )
    .all(runId) as { project: string; task: string; def: string }[]
  return new Map(rows.map((r) => [`${r.project}#${r.task}`, r.def]))
}

/**
 * `--stats`: what the scheduler and `--dry` learn from history, per task,
 * over the same window (`LocalHistoryProvider`), with the p50 a run on
 * `branch` forecasts from the timings of each task's definition `defs`.
 */
async function printStats(
  db: Database,
  target: string | undefined,
  format: 'pretty' | 'json',
  branch: string | null,
  defs: ReadonlyMap<string, string> | undefined,
): Promise<number> {
  const provider = new LocalHistoryProvider(db, undefined, branch, defs)
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
    ui.data('out', `${JSON.stringify({ window: provider.recent, branch, stats })}\n`)
    return 0
  }
  if (stats.length === 0) {
    ui.print('out', ui.status('info', 'vx last', 'no runs yet'))
    return 0
  }
  const pct = (r: number): string => `${Math.round(r * 100)}%`
  // The run grid's units and its unknown mark, so one number reads alike
  // in both: cpu `127%` (was `1.3×`), mem `3.6MB` (was `3.6 MB`), `—`.
  const ms = (v: number | null): string => (v === null ? UNKNOWN : fmtMs(v))
  const right = (title: string): ui.Column => ({ title, align: 'right' })
  ui.print(
    'out',
    ui.section(
      'Task stats',
      ui.table(
        [
          'task',
          right('runs'),
          right('p50'),
          right('p99'),
          right('pass'),
          right('hit'),
          'failure mode',
          right('peak rss'),
          right('cpu'),
        ],
        stats.map((s) => [
          ui.id(s.taskId),
          String(s.runs),
          ms(s.p50DurationMs),
          ms(s.p99DurationMs),
          pct(s.successRate),
          pct(s.hitRate),
          s.failureMode,
          s.maxPeakRssBytes === null ? UNKNOWN : formatSize(s.maxPeakRssBytes),
          s.maxCpuParallelism === null ? UNKNOWN : pct(s.maxCpuParallelism),
        ]),
      ),
    ),
  )
  return 0
}

/**
 * `--sql`: one SELECT over the history (`runs`, `invocations`, `steps`,
 * `warnings`, `failures`, and the store's `entries`, `entry_inputs`,
 * `task_durations`, `task_outcomes`),
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
  const refused = (err: unknown): never => {
    const message = err instanceof Error ? err.message : String(err)
    // `runs` is a view: a write to it fails before query_only is asked.
    if (/readonly|query_only|cannot modify/i.test(message)) {
      throw new UserError(`vx last: --sql reads only: ${message}`, 'VX_E_USAGE')
    }
    throw new UserError(`vx last: --sql: ${message}`, 'VX_E_USAGE')
  }
  let stmt: ReturnType<Database['query']>
  try {
    stmt = db.query(sql)
  } catch (err) {
    return refused(err)
  }
  // SQLite prepares the first statement and drops the rest unread. Its
  // text is the statement's own (a bound `?` expanded, hence the guard).
  const own = stmt.toString()
  const tail = sql.startsWith(own) ? sql.slice(own.length) : ''
  if (tail.replace(/--[^\n]*|\/\*[^]*?\*\/|[\s;]/g, '') !== '') {
    throw new UserError(
      `vx last: --sql takes one statement, and ${JSON.stringify(tail.replace(/^[\s;]+/, '').trimEnd())} follows the first: run each in its own --sql`,
      'VX_E_USAGE',
    )
  }
  // Read by position: a join's `SELECT *` names `run_id` twice, and rows
  // keyed by name kept one value per name.
  const columns = stmt.columnNames
  let values: unknown[][]
  try {
    values = stmt.values() as unknown[][]
  } catch (err) {
    return refused(err)
  }
  if (format === 'json') {
    const twice = columns.find((c, i) => columns.indexOf(c) !== i)
    if (twice !== undefined) {
      throw new UserError(
        `vx last: --sql: column ${JSON.stringify(twice)} is named twice, and a JSON row holds one value per name; name each with AS`,
        'VX_E_USAGE',
      )
    }
    const rows = values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])))
    ui.data('out', `${JSON.stringify({ rows })}\n`)
    return 0
  }
  if (values.length === 0) return 0
  // A column's value as SQLite returns it: TEXT, a number, NULL or a BLOB.
  const cell = (v: string | number | bigint | Uint8Array | null): string =>
    v === null || v === undefined
      ? '-'
      : v instanceof Uint8Array
        ? `<${v.length} bytes>`
        : String(v)
  ui.print(
    'out',
    ui.table(
      columns,
      values.map((r) => r.map((v) => ui.strong(cell(v as Parameters<typeof cell>[0])))),
    ),
  )
  return 0
}

/** `text` as JSON, or undefined where it is not. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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
  /** The run answered a snapshot this vx cannot read: another vx version's. */
  let unreadable = false
  /** `run:done` arrived: a follower whose stream stops before it lost the run. */
  let ended = false
  let settle!: (answered: boolean) => void
  const done = new Promise<boolean>((resolve) => (settle = resolve))
  const line = (text: string): void => {
    if (unreadable) return
    if (snapshot === undefined) {
      const s = parsed(text) as Partial<LiveSnapshot> | undefined
      const l = s?.live
      if (
        typeof l?.runId !== 'string' ||
        typeof l.command !== 'string' ||
        typeof l.startedAt !== 'number' ||
        typeof l.elapsedMs !== 'number' ||
        !Array.isArray(s!.tasks) ||
        !Array.isArray(s!.warnings)
      ) {
        unreadable = true
        return settle(false)
      }
      snapshot = s as LiveSnapshot
      if (format === 'json') ui.data('out', `${text}\n`)
      else ui.print('out', ...formatLive(snapshot))
      return
    }
    // Parsed only where it may be the end: JSON mode passes lines through.
    if (text.includes('"run:done"') && (parsed(text) as { kind?: unknown })?.kind === 'run:done')
      ended = true
    if (format === 'json') ui.data('out', `${text}\n`)
    else {
      const e = parsed(text)
      const event =
        typeof e === 'object' && e !== null ? formatLiveEvent(e as WireEvent) : undefined
      if (event !== undefined) ui.print('out', event)
    }
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
  if (unreadable)
    throw refusal({
      headline: 'the run in progress answered in a form this vx does not read',
      fix: 'ask with the vx that started the run',
    })
  if (!answered) none()
  // Exit 0 read as "followed to its end" to a script that had lost the run.
  if (follow && !ended)
    throw refusal({
      headline: 'the run let go before it ended: it was killed, or this follower fell 1 MiB behind',
      fix: 'vx last',
    })
  return 0
}

function formatLive(s: LiveSnapshot): ui.Block[] {
  const count = (status: string): number => s.tasks.filter((t) => t.status === status).length
  const running = count('running')
  const waiting = count('waiting')
  const failed = count('failed')
  const now = s.live.startedAt + s.live.elapsedMs
  const blocks = [
    ui.section(
      'Run',
      s.live.runId,
      ui.fields([
        ['status', ui.tone('info', `running ${fmtMs(s.live.elapsedMs)}`)],
        ['command', ui.cmd(s.live.command)],
        [
          'tasks',
          `${running} running · ${s.tasks.length - running - waiting} ended${failed > 0 ? ` · ${failed} failed` : ''} · ${waiting} waiting`,
        ],
      ]),
    ),
    ui.section(
      'Tasks',
      String(s.tasks.length),
      ui.table(
        ['status', 'task', { title: 'time', align: 'right' }],
        s.tasks.map((t) => {
          const ms =
            t.durationMs !== null ? t.durationMs : t.startedAt !== null ? now - t.startedAt : null
          return [
            ui.tone(
              t.status === 'failed' ? 'error' : t.status === 'running' ? 'info' : 'muted',
              t.status,
            ),
            ui.id(t.taskId),
            ms === null ? '' : fmtMs(ms),
          ]
        }),
      ),
    ),
  ]
  if (s.warnings.length > 0)
    blocks.push(ui.section('Warnings', String(s.warnings.length), ui.text(...s.warnings)))
  return blocks
}

/** One followed event: a task's output under its id, an end, a warning. */
function formatLiveEvent(e: WireEvent): ui.Block | undefined {
  switch (e.kind) {
    case 'task:stdout':
    case 'task:stderr':
      return ui.text(
        ...e.chunk
          .replace(/\n$/, '')
          .split('\n')
          .map((l): ui.Inline => [ui.id(e.taskId), ui.dim(' │ '), ui.tone('plain', l)]),
      )
    case 'task:complete':
      return ui.text([
        ui.tone(e.outcome.status === 'failed' ? 'error' : 'ok', outcomeWord(e.outcome)),
        '  ',
        ui.id(e.outcome.taskId),
        ui.dim(`  ${fmtMs(e.outcome.durationMs)}`),
      ])
    case 'run:status':
      return 'warn' in e ? ui.status('warn', 'warn', Bun.stripANSI(e.line)) : undefined
    default:
      return undefined
  }
}

const fmtWhen = (ms: number): string => new Date(ms).toISOString()

const fmtMs = (ms: number): string => formatElapsed(ms, true)

/**
 * Why a row failed or was skipped, as the run's own footer said it (the
 * v27 columns): a timeout or a never-ready server instead of the signal
 * their exit stands for, the sandbox's violation count, a skip's blocker.
 * Older rows carry none and read as before.
 */
function reasonParts(
  t: RunSummaryRow,
  skippedHere: ReadonlySet<string>,
  inputMoved: string | undefined,
): string {
  const parts: string[] = []
  if (t.status === 'failed') {
    if (t.notReady !== null) {
      parts.push(
        `never ready: ${t.notReady === 'timeout' ? 'timed out' : t.notReady === 'exited' ? 'exited' : 'spawn failed'}`,
      )
    } else if (inputMoved !== undefined) {
      // `inputStability.severity: 'error'` forced the exit; the run keeps
      // the input with the failure's output, not in the row.
      parts.push(`${inputMoved === '' ? 'an input' : inputMoved} changed during the run`)
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
  // The run's own row said `flaky - 2 attempts`: a pass that needed a
  // retry is the one sign of a flaky task a replay can give.
  if (t.attempts !== null && t.attempts > 1) parts.push(`${t.attempts} attempts`)
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
function formatStepRows(steps: readonly RunStep[]): ui.Block | undefined {
  if (steps.length === 0) return undefined
  return ui.table(
    ['', '', { title: '', align: 'right' }, ''],
    steps.map((s) => [
      ui.tone(s.ok ? 'ok' : 'error', s.ok ? 'success' : 'failed'),
      ui.strong(s.id),
      fmtMs(s.durationMs),
      'internal',
    ]),
  )
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
  /** Task id → the input that moved under it, from the run's kept failures. */
  inputMoved: ReadonlyMap<string, string> = new Map(),
  /** Task id → its usual time now, from history; a task absent was never timed. */
  usual?: ReadonlyMap<string, number>,
): ui.Block[] {
  if (tasks.length === 0) return []
  const failed = tasks.filter((t) => t.status === 'failed')
  const hits = tasks.filter((t) => t.status !== 'failed' && t.cacheHit === true)
  const rest = tasks.filter((t) => t.status !== 'failed' && t.cacheHit !== true)
  const folded = hits.length > HITS_SHOWN
  const shownHits = folded
    ? [...hits].sort((a, b) => b.durationMs - a.durationMs).slice(0, HITS_SHOWN)
    : hits
  const ordered = [...failed, ...rest, ...shownHits]
  const skippedHere = new Set(
    tasks.filter((t) => t.status === 'skipped').map((t) => `${t.project}#${t.task}`),
  )
  // The run's own grid (`taskList`): a replay reads as the run did. What
  // the run said below the row (an exit, why it skipped) rides it dim.
  const rows = ordered.map((t) => {
    // A cached failure with no cache outcome is a hit whose restore failed: no
    // exit. One whose command exited 0 failed in its save (a server that
    // exited 0 before ready says so in its reason).
    const failure =
      t.status !== 'failed'
        ? ''
        : t.cached === true && t.cacheHit === null
          ? 'cache restore failed'
          : t.exitCode === 0 && t.notReady === null
            ? 'cache save failed'
            : `exit ${t.exitCode}`
    const note = (
      failure + reasonParts(t, skippedHere, inputMoved.get(`${t.project}#${t.task}`))
    ).trim()
    const id = `${t.project}#${t.task}`
    const usualMs = usual === undefined ? undefined : (usual.get(id) ?? null)
    return (c: ui.ColorSupport) => formatRecordedRow(t, c, note, usualMs)
  })
  const blocks = [taskList(rows)]
  if (folded)
    blocks.push(
      ui.text(
        `… +${hits.length - HITS_SHOWN} more cache hit${hits.length - HITS_SHOWN === 1 ? '' : 's'} (the ${HITS_SHOWN} slowest restores shown): \`vx last --format json\` lists every row`,
      ),
    )
  return blocks
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
): ui.Block {
  return ui.table(
    ['', 'when', 'run', 'tasks', { title: 'time', align: 'right' }, 'command'],
    runs.map(({ inv, id }) => [
      inv.exitOk ? ui.tone('ok', 'ok') : ui.tone('error', 'FAILED'),
      fmtWhen(inv.startedAt),
      ui.strong(id),
      [
        ui.dim(`${inv.taskCount} task${inv.taskCount === 1 ? '' : 's'} · ${hitsLine(inv)}`),
        ...(inv.failedCount > 0 ? [ui.tone('error', ` · ${inv.failedCount} failed`)] : []),
      ],
      fmtMs(inv.totalDurationMs),
      ui.cmd(inv.command),
    ]),
  )
}

/**
 * A bare task name as `--log` reads it: the one project that ran it, the
 * cwd's among several (as `vx why` picks), else refused naming them. It
 * read as an id and said "no recorded run of build" for a task that ran.
 */
async function bareTaskId(db: Database, task: string, at: VerbWorkspace): Promise<string> {
  if (task.includes('#')) return task
  const ids = (
    db
      .query('SELECT DISTINCT project FROM main.runs WHERE task = ? ORDER BY project')
      .all(task) as {
      project: string
    }[]
  ).map((r) => `${r.project}#${task}`)
  if (ids.length <= 1) return ids[0] ?? task
  const here = await findCwdProject(process.cwd(), at)
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
  const at = verbWorkspace(root)
  const cacheDir = await cliCacheDir(at, parsed.cacheDir)
  const cache = Cache.inspect(cacheDir)
  try {
    const db = indexDb(cache)
    // Nothing recorded at all is its own answer: `--failed` said "no
    // recorded run failed" and a run id pointed at a `--list` that lists
    // nothing, while `--list --failed` past green runs said there were none.
    const noRuns = (): boolean => listInvocations(db, { limit: 1 }).length === 0
    const noRunsYet = (): UserError =>
      refusal(
        { tone: 'info', headline: 'no runs yet', fix: 'vx run' },
        { code: 'VX_E_NO_HISTORY', message: 'vx last: no recorded runs yet — run something first' },
      )

    if (parsed.sql !== undefined) return printQuery(db, parsed.sql, parsed.format)

    if (parsed.stats === true) {
      if (noRuns()) throw noRunsYet()
      const branch = currentBranch(root, undefined, parsed.branch)
      const task = parsed.task === undefined ? undefined : await rootSpelled(at, parsed.task)
      return await printStats(
        db,
        task,
        parsed.format,
        branch,
        await definitionsNow(at, parsed.cacheDir),
      )
    }

    if (parsed.log !== undefined) {
      const runId =
        parsed.runId === undefined
          ? undefined
          : (resolveRunId(db, parsed.runId, 'vx last') ?? parsed.runId)
      const log = taskLog(db, await bareTaskId(db, await rootSpelled(at, parsed.log), at), runId)
      if (log === null) {
        // The id's form is hinted only when it lacks one: a task that
        // never ran was told how to spell a task id. A typo of one that
        // ran is named, as `vx why` names it.
        const recorded = parsed.log.includes('#')
          ? new LocalHistoryProvider(db).recentTaskIds()
          : []
        const ran = nearest(parsed.log, recorded)
        // No near name: what of that project has run, so the next try is a pick.
        const project = parsed.log.slice(0, parsed.log.lastIndexOf('#') + 1)
        const theirs = recorded
          .filter((id) => project !== '' && id.startsWith(project))
          .map((id) => id.slice(project.length))
          .sort()
        const listed =
          ran === undefined && theirs.length > 0
            ? `; ${project.slice(0, -1)}'s recorded tasks: ${theirs.join(', ')}`
            : ''
        throw new UserError(
          `vx last: no recorded run of ${parsed.log}${parsed.runId === undefined ? '' : ` in run ${parsed.runId}`}${parsed.log.includes('#') ? '' : ' (a task id is project#task)'}${ran === undefined ? '' : ` — did you mean ${ran}?`}${listed}`,
          'VX_E_NO_HISTORY',
        )
      }
      if (parsed.format === 'json') {
        ui.data('out', `${JSON.stringify(log)}\n`)
        return 0
      }
      if (log.source === null) {
        // A cached task with no entry of its own was not saved (a read-only
        // policy, a `--force` run that kept the entry it found), or its entry
        // was pruned or saved over; calling it uncached sends the user to the config.
        const [project, task] = splitTaskId(log.taskId)
        const cached =
          log.status !== 'failed' &&
          (
            db
              .query('SELECT cached FROM runs WHERE run_id = ? AND project = ? AND task = ?')
              .get(log.runId, project, task) as { cached: number | null } | null
          )?.cached === 1
        // A skip ran nothing: the output to read is its blocker's.
        const blocker =
          log.status === 'skipped'
            ? (
                db
                  .query(
                    'SELECT blocked_by AS b FROM runs WHERE run_id = ? AND project = ? AND task = ?',
                  )
                  .get(log.runId, project, task) as { b: string | null } | null
              )?.b
            : null
        sayNotice(
          'info',
          'vx last',
          typeof blocker === 'string'
            ? `${log.taskId} did not run: ${blocker} blocked it (vx last --log ${blocker})`
            : log.status === 'failed'
              ? `${log.taskId} ended failed, and vx kept no output for it: it keeps the newest 50 failed runs`
              : cached
                ? `${log.taskId} ended ${log.status}, and the cache does not hold its output: the run did not save it, or it was pruned or saved over since`
                : `${log.taskId} ended ${log.status}. vx keeps output only for failed and cached tasks`,
        )
      } else if (log.output === '') {
        sayNotice('info', 'vx last', `${log.taskId} ended ${log.status} and printed nothing`)
      }
      // The task's own bytes, as it wrote them.
      ui.data('out', log.output)
      return 0
    }

    if (parsed.list !== undefined) {
      const invocations =
        parsed.failed === true
          ? failedInvocations(db, parsed.list)
          : listInvocations(db, { limit: parsed.list })
      if (parsed.format === 'json') {
        ui.data('out', `${JSON.stringify(invocations)}\n`)
        return 0
      }
      if (invocations.length === 0) {
        const none = parsed.failed === true && !noRuns() ? 'no failed runs' : 'no runs yet'
        ui.print('out', ui.status('info', 'vx last', none))
        return 0
      }
      ui.print(
        'out',
        ui.section(
          'Runs',
          String(invocations.length),
          formatRunList(invocations.map((inv) => ({ inv, id: shortRunId(db, inv.runId) }))),
        ),
      )
      return 0
    }

    const named = parsed.runId === undefined ? null : resolveRunId(db, parsed.runId, 'vx last')
    const inv =
      parsed.runId !== undefined
        ? getInvocation(db, named ?? parsed.runId)
        : parsed.failed === true
          ? (failedInvocations(db, 1)[0] ?? null)
          : (listInvocations(db, { limit: 1 })[0] ?? null)
    // A run with rows and no header is one a stop ended (item 854): `vx why`
    // printed its id, so it is named, not called unrecorded.
    if (named !== null && (inv === null || inv === undefined)) {
      throw new UserError(
        `vx last: run ${named} was stopped before it finished, so vx kept its tasks but no summary: \`vx last ${named} --log <task>\` prints one's output`,
        'VX_E_NO_HISTORY',
      )
    }
    if ((inv === null || inv === undefined) && noRuns()) throw noRunsYet()
    // Nothing failed is no fault: said as `--list --failed` says it.
    if ((inv === null || inv === undefined) && parsed.failed === true) {
      throw refusal(
        { tone: 'info', headline: 'no failed runs', fix: 'vx last' },
        { code: 'VX_E_NO_HISTORY', message: 'vx last: no failed runs' },
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
              : 'vx last: no recorded runs yet — run something first',
        'VX_E_NO_HISTORY',
      )
    }
    const detail = getRun(db, inv.runId)

    if (parsed.format === 'json') {
      const failures = new Map((runFailures(db, inv.runId)?.tasks ?? []).map((f) => [f.taskId, f]))
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
      const steps = keptSteps(db, inv.runId)
      const warnings = keptWarnings(db, inv.runId)
      ui.data(
        'out',
        `${JSON.stringify({
          invocation: inv,
          tasks,
          ...(steps.length > 0 ? { steps } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        })}\n`,
      )
      return 0
    }

    const moved = new Map<string, string>()
    if (inv.failedCount > 0) {
      for (const f of runFailures(db, inv.runId)?.tasks ?? [])
        if (f.inputMoved !== undefined) moved.set(f.taskId, f.inputMoved)
    }
    const blocks: ui.Block[] = [
      ui.section(
        'Run',
        inv.runId,
        ui.fields([
          ['status', inv.exitOk ? ui.tone('ok', 'ok') : ui.tone('error', 'FAILED', true)],
          ['command', ui.cmd(inv.command)],
          [
            'when',
            `${fmtWhen(inv.startedAt)} · ${fmtMs(inv.totalDurationMs)}` +
              `${inv.branch !== null ? ` · ${inv.branch}` : ''}` +
              `${inv.commitSha !== null ? ` @ ${inv.commitSha.slice(0, 8)}${inv.dirty === true ? '+dirty' : ''}` : ''}` +
              `${inv.ci ? ` · CI${inv.ciProvider !== null ? ` (${inv.ciProvider})` : ''}` : ''}`,
          ],
          [
            'tasks',
            [
              ui.dim(`${inv.taskCount} task${inv.taskCount === 1 ? '' : 's'} · ${hitsLine(inv)}`),
              ...(inv.failedCount > 0 ? [ui.tone('error', ` · ${inv.failedCount} failed`)] : []),
            ],
          ],
        ]),
      ),
    ]
    // ±usual against the task's usual time now, as a run on this branch reads it.
    const ranIds = (detail?.tasks ?? [])
      .filter((t) => t.status === 'success' || t.status === 'failed')
      .map((t) => `${t.project}#${t.task}`)
    // Each task's timings of the definition it ran under, as its live row
    // read them: an older definition's timings are another task's.
    const history = new LocalHistoryProvider(
      db,
      undefined,
      currentBranch(root),
      runDefinitions(db, inv.runId),
    )
    const usual = new Map(history.p50sNow(ranIds))
    // A task whose one timing is this run's own has no usual to compare
    // with: `+0ms` claimed a baseline the live row rightly showed as `—`.
    for (const id of history.timedOnlySince(ranIds, inv.startedAt)) usual.delete(id)
    const taskRows = formatTaskRows(detail?.tasks ?? [], moved, usual)
    if (taskRows.length > 0)
      blocks.push(ui.section('Tasks', String(detail?.tasks.length ?? 0), ...taskRows))
    const stepRows = formatStepRows(keptSteps(db, inv.runId))
    if (stepRows !== undefined) blocks.push(ui.section('Steps', stepRows))
    const warnings = keptWarnings(db, inv.runId)
    if (warnings.length > 0)
      blocks.push(ui.section('Warnings', String(warnings.length), ui.text(...warnings)))
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
        if (ids.length > 0) rerun.push(`vx run ${ids.join(' ')}${withArgs ? args : ''}`)
      }
      blocks.push(ui.fields([['next', ...rerun.map((r) => ui.cmd(r))]]))
    }
    ui.print('out', ...blocks)
    return 0
  } catch (err) {
    throw indexError(cache, err)
  } finally {
    cache.close()
  }
}
