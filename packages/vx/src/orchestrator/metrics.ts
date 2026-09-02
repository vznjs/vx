// Run-history queries — pure functions over a `bun:sqlite` Database.
//
// `vx why` and `vx last` read through them, and so can any out-of-process
// surface (an MCP server plugin, a dashboard). One canonical home for every
// aggregate over the runs / entries tables. The schema itself is owned by
// src/cache/cache.ts.
//
// Pure SQL + JSON-safe return shapes. No Cache lifecycle here; the
// caller opens and closes. bigints are serialized as decimal strings
// for JSON compatibility (matches the WireEvent timeUnixNano rule).

import type { Database } from 'bun:sqlite'
// The keyed-run predicate lives beside the schema in cache/cache.ts, so a
// rule written once cannot drift.
import { KEYED_RUNS_SQL } from '../cache/index.js'
import { splitTaskId } from '../graph/index.js'
import { clampInt } from '../util/index.js'

// ---------------------------------------------------------------------------
// Run listing + detail
// ---------------------------------------------------------------------------

export interface RunSummaryRow {
  runId: string | null
  project: string
  task: string
  status: string
  exitCode: number
  durationMs: number
  startedAt: number
  endedAt: number
  cacheHit: boolean | null
  hash: string
  cpuMs: number | null
  peakRssBytes: number | null
  // High-precision spans relative to run start. Decimal strings on the wire
  // (bigints aren't JSON-safe); use BigInt or Number on the client.
  wallclockStartNs: string | null
  wallclockEndNs: string | null
}

export interface ListRunsArgs {
  limit?: number
  project?: string
  task?: string
  runId?: string
}

export function listRuns(db: Database, args: ListRunsArgs = {}): RunSummaryRow[] {
  // Ceiling is high enough that a single run's full task set (getRun passes the
  // run_id) is never truncated; list views pass their own small limit.
  const limit = clampInt(args.limit ?? 100, 1, 100_000)
  const where: string[] = []
  const params: (string | number)[] = []
  if (args.project) {
    where.push('project = ?')
    params.push(args.project)
  }
  if (args.task) {
    where.push('task = ?')
    params.push(args.task)
  }
  if (args.runId) {
    where.push('run_id = ?')
    params.push(args.runId)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  type RawRow = Omit<RunSummaryRow, 'cacheHit' | 'wallclockStartNs' | 'wallclockEndNs'> & {
    cacheHit: number | null
    wallclockStartNs: bigint | null
    wallclockEndNs: bigint | null
  }
  const rows = db
    .query(
      `SELECT run_id AS runId, project, task, status, exit_code AS exitCode,
              duration_ms AS durationMs, started_at AS startedAt, ended_at AS endedAt,
              cache_hit AS cacheHit, hash,
              cpu_ms AS cpuMs, peak_rss_bytes AS peakRssBytes,
              wallclock_start_ns AS wallclockStartNs, wallclock_end_ns AS wallclockEndNs
       FROM runs ${clause} ORDER BY started_at DESC LIMIT ?`,
    )
    .all(...params, limit) as RawRow[]
  return rows.map((r) => ({
    ...r,
    cacheHit: r.cacheHit === null ? null : Boolean(r.cacheHit),
    wallclockStartNs: r.wallclockStartNs === null ? null : r.wallclockStartNs.toString(),
    wallclockEndNs: r.wallclockEndNs === null ? null : r.wallclockEndNs.toString(),
  }))
}

/**
 * One `vx run` invocation header — every `invocations` column, camelCased,
 * `tags` parsed to a `Record<string,string>` and `dirty`/`ci`/`exitOk`
 * surfaced as booleans. Superset of the old `InvocationRow`: the SPA's
 * existing fields (runId / startedAt / endedAt / taskCount / failedCount /
 * hitCount / totalDurationMs) are all present, so existing views keep working.
 */
export interface InvocationDetail {
  runId: string
  command: string
  /** The requested task names, parsed from the persisted JSON string[]. */
  requestedTasks: string[]
  cachePolicy: string
  concurrency: number
  flow: 'focused' | 'broad' | null
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  exitOk: boolean
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vxVersion: string
  tags: Record<string, string>
}

/** @deprecated kept as an alias of `InvocationDetail` for older callers. */
export type InvocationRow = InvocationDetail

interface InvocationRawRow {
  runId: string
  command: string
  requestedTasks: string
  cachePolicy: string
  concurrency: number
  flow: string | null
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  exitOk: number
  commitSha: string | null
  branch: string | null
  dirty: number | null
  ci: number
  ciProvider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vxVersion: string
  tags: string
}

const INVOCATION_COLUMNS = `
  run_id AS runId, command, requested_tasks AS requestedTasks,
  cache_policy AS cachePolicy, concurrency, flow,
  started_at AS startedAt, ended_at AS endedAt, total_duration_ms AS totalDurationMs,
  task_count AS taskCount, failed_count AS failedCount, hit_count AS hitCount,
  hit_local_count AS hitLocalCount, hit_remote_count AS hitRemoteCount,
  exit_ok AS exitOk,
  commit_sha AS commitSha, branch, dirty, ci, ci_provider AS ciProvider,
  host, os, arch, vx_version AS vxVersion, tags`

function mapInvocation(r: InvocationRawRow): InvocationDetail {
  let requestedTasks: string[] = []
  try {
    const parsed = JSON.parse(r.requestedTasks) as unknown
    if (Array.isArray(parsed)) requestedTasks = parsed.map(String)
  } catch {}
  let tags: Record<string, string> = {}
  try {
    const parsed = JSON.parse(r.tags) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      tags = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      )
    }
  } catch {}
  return {
    runId: r.runId,
    command: r.command,
    requestedTasks,
    cachePolicy: r.cachePolicy,
    concurrency: r.concurrency,
    flow: r.flow === 'focused' || r.flow === 'broad' ? r.flow : null,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    totalDurationMs: r.totalDurationMs,
    taskCount: r.taskCount,
    failedCount: r.failedCount,
    hitCount: r.hitCount,
    hitLocalCount: r.hitLocalCount,
    hitRemoteCount: r.hitRemoteCount,
    exitOk: Boolean(r.exitOk),
    commitSha: r.commitSha,
    branch: r.branch,
    dirty: r.dirty === null ? null : Boolean(r.dirty),
    ci: Boolean(r.ci),
    ciProvider: r.ciProvider,
    host: r.host,
    os: r.os,
    arch: r.arch,
    vxVersion: r.vxVersion,
    tags,
  }
}

export function getInvocation(db: Database, runId: string): InvocationDetail | null {
  const row = db
    .query(`SELECT ${INVOCATION_COLUMNS} FROM invocations WHERE run_id = ?`)
    .get(runId) as InvocationRawRow | undefined
  return row ? mapInvocation(row) : null
}

export interface ListInvocationsArgs {
  limit?: number
  branch?: string
  ci?: boolean
  tagKey?: string
  tagValue?: string
}

/**
 * List `vx run` invocations newest-first from the `invocations` header table
 * with optional branch / ci / tag filters. Reading the dedicated header table
 * (vs the old `GROUP BY run_id` over `runs`) is lossless — git/ci/tag context
 * survives. Accepts a bare `number` for the limit (back-compat with the old
 * `listInvocations(db, 50)` signature).
 */
export function listInvocations(
  db: Database,
  args: ListInvocationsArgs | number = {},
): InvocationDetail[] {
  const opts: ListInvocationsArgs = typeof args === 'number' ? { limit: args } : args
  const limit = clampInt(opts.limit ?? 50, 1, 500)
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.branch !== undefined) {
    where.push('branch = ?')
    params.push(opts.branch)
  }
  if (opts.ci !== undefined) {
    where.push('ci = ?')
    params.push(opts.ci ? 1 : 0)
  }
  if (opts.tagKey !== undefined && opts.tagValue !== undefined) {
    // The tags column is a JSON object {"k":"v"}; a LIKE over the serialized
    // pair is adequate at this table's scale (see the design doc).
    where.push('tags LIKE ?')
    params.push(`%${jsonPairFragment(opts.tagKey, opts.tagValue)}%`)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .query(
      `SELECT ${INVOCATION_COLUMNS} FROM invocations ${clause}
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(...params, limit) as InvocationRawRow[]
  return rows.map(mapInvocation)
}

/** The `"key":"value"` fragment as it appears in `JSON.stringify({k:v})`. */
function jsonPairFragment(key: string, value: string): string {
  const k = JSON.stringify(key).slice(1, -1)
  const v = JSON.stringify(value).slice(1, -1)
  return `"${k}":"${v}"`
}

export interface RunDetail {
  runId: string
  startedAt: number
  endedAt: number
  tasks: RunSummaryRow[]
}

export function getRun(db: Database, runId: string): RunDetail | null {
  const tasks = listRuns(db, { runId, limit: 100_000 })
  if (tasks.length === 0) return null
  const startedAt = Math.min(...tasks.map((t) => t.startedAt))
  const endedAt = Math.max(...tasks.map((t) => t.endedAt))
  return { runId, startedAt, endedAt, tasks }
}

// ---------------------------------------------------------------------------
// Cache stats
// ---------------------------------------------------------------------------

export interface CacheEntryRow {
  hash: string
  project: string
  task: string
  command: string
  exitCode: number
  durationMs: number
  sizeBytes: number
  createdAt: number
  accessedAt: number
}

// ---------------------------------------------------------------------------
// Task detail — full history for one (project, task)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cache key explain — latest entries row
// ---------------------------------------------------------------------------

export interface CacheKeyExplanation {
  taskId: string
  project: string
  task: string
  latestEntry: {
    hash: string
    command: string
    exitCode: number
    durationMs: number
    sizeBytes: number
    createdAt: number
  } | null
  note: string
}

export function explainCacheKey(db: Database, taskId: string): CacheKeyExplanation {
  const [project, task] = splitTaskId(taskId)
  const entry = db
    .query(
      `SELECT hash, command, exit_code AS exitCode, duration_ms AS durationMs,
              size_bytes AS sizeBytes, created_at AS createdAt
       FROM entries WHERE project = ? AND task = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(project, task) as CacheKeyExplanation['latestEntry']
  return {
    taskId,
    project,
    task,
    latestEntry: entry ?? null,
    note: 'cache key components (files / env / runtime / upstream) require live config evaluation; this surface returns persisted entry metadata',
  }
}

// ---------------------------------------------------------------------------
// Why did this rerun — compare two runs
// ---------------------------------------------------------------------------

export interface WhyDidThisRerun {
  runId: string
  taskId: string
  found: boolean
  thisRun?: { hash: string; status: string; cacheHit: boolean | null; startedAt: number }
  previousRun?: { hash: string; status: string; cacheHit: boolean | null; startedAt: number } | null
  hashChanged?: boolean | null
  note: string
}

/** The three endings an UNCHANGED cache key can have. */
function unchangedKeyNote(cacheHit: number | null): string {
  if (cacheHit === null) {
    return 'cache key unchanged — this run recorded no cache outcome, so whether it re-ran is unknown'
  }
  return cacheHit
    ? 'cache key unchanged — this run was served from cache, nothing re-ran'
    : 'cache key unchanged — re-executed on the same key (--no-cache / --force, or unrelated)'
}

export function whyDidThisRerun(db: Database, runId: string, taskId: string): WhyDidThisRerun {
  const [project, task] = splitTaskId(taskId)
  const this_ = db
    .query(
      `SELECT hash, status, cache_hit AS cacheHit, started_at AS startedAt
       FROM runs WHERE run_id = ? AND project = ? AND task = ?`,
    )
    .get(runId, project, task) as
    | { hash: string; status: string; cacheHit: number | null; startedAt: number }
    | undefined
  if (!this_) {
    return {
      runId,
      taskId,
      found: false,
      note: 'no row matching that runId + taskId',
    }
  }
  // The previous run to compare against is the previous run that RECORDED A
  // KEY. A skipped or persistent row carries `hash = ''`, and comparing
  // against it would answer "cache key unchanged" for two runs that never had
  // a key — a statement about inputs, made from no evidence.
  const prev = db
    .query(
      `SELECT hash, status, cache_hit AS cacheHit, started_at AS startedAt
       FROM runs WHERE project = ? AND task = ? AND started_at < ? AND ${KEYED_RUNS_SQL}
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(project, task, this_.startedAt) as
    | { hash: string; status: string; cacheHit: number | null; startedAt: number }
    | undefined
  // …and this run must have one too, or there is nothing to compare.
  const noKey = this_.hash === ''
  return {
    runId,
    taskId,
    found: true,
    thisRun: { ...this_, cacheHit: this_.cacheHit === null ? null : Boolean(this_.cacheHit) },
    previousRun: prev
      ? { ...prev, cacheHit: prev.cacheHit === null ? null : Boolean(prev.cacheHit) }
      : null,
    hashChanged: prev && !noKey ? prev.hash !== this_.hash : null,
    note: noKey
      ? 'this task recorded no cache key (skipped, or a persistent task) — nothing to compare'
      : prev && prev.hash !== this_.hash
        ? 'cache key changed between the previous run and this one (inputs differ)'
        : prev
          ? // An unchanged key has two very different endings, and calling
            // both a "re-run" answered the question wrong: a cache HIT did not
            // re-run at all, so blaming `--no-cache` named a cause that cannot
            // have applied. Only a run that EXECUTED on an unchanged key is
            // the case this verb exists to explain. A row with no recorded
            // cacheHit (older rows) is neither — say that, do not guess.
            unchangedKeyNote(this_.cacheHit)
          : 'no prior run for this (project, task)',
  }
}

// ---------------------------------------------------------------------------
// Cache-key diff — the input-fingerprint moat
// ---------------------------------------------------------------------------

/** One changed/added/removed cache-key component between two runs of a task. */
export interface InputDiffEntry {
  kind: string
  name: string
  change: 'added' | 'removed' | 'changed'
  /** The component's hash in the previous run (null when `added`). */
  before: string | null
  /** The component's hash in this run (null when `removed`). */
  after: string | null
}

export interface CacheKeyDiff {
  runId: string
  taskId: string
  found: boolean
  previousRunId: string | null
  /** Only changed / added / removed components. Unchanged ones are counted. */
  entries: InputDiffEntry[]
  unchangedCount: number
  note: string
}

interface EntryInputRow {
  kind: string
  name: string
  hash: string
}

function loadEntryInputs(db: Database, entryHash: string): Map<string, EntryInputRow> {
  const rows = db
    .query('SELECT kind, name, hash FROM entry_inputs WHERE entry_hash = ?')
    .all(entryHash) as EntryInputRow[]
  return new Map(rows.map((r) => [`${r.kind}\0${r.name}`, r]))
}

/**
 * The moat: name the exact cache-key components (files / env / runtime /
 * upstream …) that differ between this run of a task and its immediately-
 * previous run. Resolves each run to its task hash via `runs.hash`, then
 * full-outer-joins the two runs' `entry_inputs` rows (keyed by the entry
 * hash) over `(kind, name)`:
 *
 * - present in both with a different hash → `changed`
 * - only in this run → `added`
 * - only in the previous run → `removed`
 * - equal → counted as unchanged
 *
 * Pure SQL + an app-side set join — no config re-evaluation, no re-hash.
 * Always returns a value (never throws); `found:false` when the run/task pair
 * has no row, `entries:[]` for the first run of a task.
 */
export function cacheKeyDiff(db: Database, runId: string, taskId: string): CacheKeyDiff {
  const [project, task] = splitTaskId(taskId)
  const this_ = db
    .query(
      'SELECT hash, started_at AS startedAt FROM runs WHERE run_id = ? AND project = ? AND task = ?',
    )
    .get(runId, project, task) as { hash: string; startedAt: number } | undefined
  if (!this_) {
    return {
      runId,
      taskId,
      found: false,
      previousRunId: null,
      entries: [],
      unchangedCount: 0,
      note: 'no row matching that runId + taskId',
    }
  }

  // No key on this side → no diff to compute. `''` is the recorded-no-key
  // sentinel (skipped / persistent); treating it as a key would resolve the
  // `prev.hash === this_.hash` branch below and claim "same inputs".
  if (this_.hash === '') {
    return {
      runId,
      taskId,
      found: true,
      previousRunId: null,
      entries: [],
      unchangedCount: 0,
      note: 'this task recorded no cache key (skipped, or a persistent task) — nothing to diff',
    }
  }

  const prev = db
    .query(
      `SELECT run_id AS runId, hash FROM runs
       WHERE project = ? AND task = ? AND started_at < ? AND ${KEYED_RUNS_SQL}
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(project, task, this_.startedAt) as { runId: string | null; hash: string } | undefined

  if (!prev) {
    return {
      runId,
      taskId,
      found: true,
      previousRunId: null,
      entries: [],
      unchangedCount: 0,
      note: 'no prior run for this (project, task) — nothing to diff',
    }
  }

  if (prev.hash === this_.hash) {
    return {
      runId,
      taskId,
      found: true,
      previousRunId: prev.runId,
      entries: [],
      unchangedCount: 0,
      note: 'cache key unchanged between the previous run and this one (same inputs)',
    }
  }

  const cur = loadEntryInputs(db, this_.hash)
  const old = loadEntryInputs(db, prev.hash)

  // Input fingerprints are pruned with their entry (ON DELETE CASCADE); if
  // either side's rows are gone, we can name the hash change but not the
  // component-level diff.
  if (cur.size === 0 || old.size === 0) {
    return {
      runId,
      taskId,
      found: true,
      previousRunId: prev.runId,
      entries: [],
      unchangedCount: 0,
      note: 'cache key changed but input fingerprints are unavailable (entry pruned); only the hash change is known',
    }
  }

  const entries: InputDiffEntry[] = []
  let unchangedCount = 0
  const keys = new Set<string>([...cur.keys(), ...old.keys()])
  for (const key of keys) {
    const a = cur.get(key)
    const b = old.get(key)
    if (a && b) {
      if (a.hash === b.hash) unchangedCount++
      else
        entries.push({
          kind: a.kind,
          name: a.name,
          change: 'changed',
          before: b.hash,
          after: a.hash,
        })
    } else if (a) {
      entries.push({ kind: a.kind, name: a.name, change: 'added', before: null, after: a.hash })
    } else if (b) {
      entries.push({ kind: b.kind, name: b.name, change: 'removed', before: b.hash, after: null })
    }
  }
  entries.sort((x, y) => x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name))

  return {
    runId,
    taskId,
    found: true,
    previousRunId: prev.runId,
    entries,
    unchangedCount,
    note:
      entries.length > 0
        ? `${entries.length} cache-key component(s) changed since the previous run`
        : 'cache key changed but no component-level difference was recorded',
  }
}

// ---------------------------------------------------------------------------
// Run comparison — diff a run against the immediately-previous invocation
// ---------------------------------------------------------------------------

/** One task's outcome on one side of a comparison. */
