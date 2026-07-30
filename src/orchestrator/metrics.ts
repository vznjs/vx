// Metrics query module — pure functions over a `bun:sqlite` Database.
//
// A service plugin's serve exposes these as HTTP routes; a dashboard SPA
// and `vx mcp` both read through them. One canonical home for every
// aggregate over the runs / entries
// tables. The schema itself is owned by src/cache/cache.ts — the
// drift guard in tests/metrics.test.ts runs every exported query against
// a freshly-created cache.db so a schema bump that breaks one fails the
// gate here, not in the dashboard.
//
// Pure SQL + JSON-safe return shapes. No Cache lifecycle here; the
// caller opens and closes. bigints are serialized as decimal strings
// for JSON compatibility (matches the WireEvent timeUnixNano rule).

import type { Database } from 'bun:sqlite'
// The two `runs` predicates live beside the schema in cache/cache.ts: the 24h
// run count is answered BOTH here and by `Cache.stats` (what `vx info` and
// `vx mcp` read), and a rule written twice is a rule that drifts.
import { EXECUTED_RUNS_SQL, KEYED_RUNS_SQL } from '../cache/index.js'
import { splitTaskId } from '../graph/index.js'
import { clampInt } from '../util/index.js'
import { classifyFailureMode, mixedOutcomeKeyCount } from './failure-mode.js'
import type { FailureMode } from './failure-mode.js'

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

export interface CacheStatsResult {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
  hitRate24h: number
  /** `status = 'cache-hit'` over the last 24h. */
  hitLocalCountLast24h: number
  /** `status = 'cache-hit-remote'` over the last 24h. */
  hitRemoteCountLast24h: number
}

export function getCacheStatsSql(db: Database): CacheStatsResult {
  const aggregate = db
    .query('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM entries')
    .get() as { n: number; bytes: number }
  const since = Date.now() - 24 * 60 * 60 * 1000
  const runs = db
    .query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END), 0) AS hitLocal,
              COALESCE(SUM(CASE WHEN status = 'cache-hit-remote' THEN 1 ELSE 0 END), 0) AS hitRemote
       FROM runs WHERE started_at >= ? AND ${EXECUTED_RUNS_SQL}`,
    )
    .get(since) as { total: number; hitLocal: number; hitRemote: number }
  const hits = runs.hitLocal + runs.hitRemote
  return {
    entryCount: aggregate.n,
    totalBytes: aggregate.bytes,
    runCountLast24h: runs.total,
    hitCountLast24h: hits,
    hitRate24h: runs.total > 0 ? hits / runs.total : 0,
    hitLocalCountLast24h: runs.hitLocal,
    hitRemoteCountLast24h: runs.hitRemote,
  }
}

export interface HitRateSplit {
  total: number
  hits: number
  hitLocal: number
  hitRemote: number
  hitRate: number
  localShare: number
  remoteShare: number
}

/**
 * Local-vs-remote cache hit split over the last `days` days. `cache-hit` is a
 * local restore; `cache-hit-remote` was pulled over the network.
 */
export function getHitRateSplit(db: Database, days = 1): HitRateSplit {
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const r = db
    .query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END), 0) AS hitLocal,
              COALESCE(SUM(CASE WHEN status = 'cache-hit-remote' THEN 1 ELSE 0 END), 0) AS hitRemote
       FROM runs WHERE started_at >= ? AND ${EXECUTED_RUNS_SQL}`,
    )
    .get(since) as { total: number; hitLocal: number; hitRemote: number }
  const hits = r.hitLocal + r.hitRemote
  return {
    total: r.total,
    hits,
    hitLocal: r.hitLocal,
    hitRemote: r.hitRemote,
    hitRate: r.total > 0 ? hits / r.total : 0,
    localShare: hits > 0 ? r.hitLocal / hits : 0,
    remoteShare: hits > 0 ? r.hitRemote / hits : 0,
  }
}

// ---------------------------------------------------------------------------
// Task history (the same SQL CTE LocalHistoryProvider uses)
// ---------------------------------------------------------------------------

export interface TaskHistoryRow {
  id: string
  project: string
  task: string
  runs: number
  successes: number
  failures: number
  hits: number
  successRate: number
  hitRate: number
  failureMode: FailureMode
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
  minDurationMs: number | undefined
  maxDurationMs: number | undefined
  avgDurationMs: number | undefined
  totalDurationMs: number
  lastSeenAt: number | undefined
}

export interface GetHistoryArgs {
  project?: string
  task?: string
  limit?: number
}

export function getHistory(db: Database, args: GetHistoryArgs = {}): TaskHistoryRow[] {
  const limit = clampInt(args.limit ?? 50, 1, 500)
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
  // Execution history only: a task that has so far only ever been SKIPPED has
  // none, and every field below (successRate / hitRate / the percentiles /
  // failureMode's denominator) would be computed over a non-event. Its rows
  // still show on `getTaskDetail.recent`, which reads `listRuns` unfiltered.
  where.push(EXECUTED_RUNS_SQL)
  const clause = `WHERE ${where.join(' AND ')}`
  // Rank + LIMIT in SQL: the result is a PAGE, so slicing an unordered
  // DISTINCT scan in JS returns the ALPHABETICAL prefix — the task that just
  // ran is exactly the one a truncated page must not drop.
  const pairs = db
    .query(
      `SELECT project, task FROM runs ${clause}
       GROUP BY project, task
       ORDER BY MAX(started_at) DESC
       LIMIT ?`,
    )
    .all(...params, limit) as {
    project: string
    task: string
  }[]

  return pairs.map((p) => {
    const aggregate = db
      .query(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
           SUM(CASE WHEN cache_hit = 1 OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END) AS hits,
           SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS retried,
           SUM(duration_ms) AS totalDurationMs,
           MAX(ended_at) AS lastSeenAt
         FROM runs WHERE project = ? AND task = ? AND ${EXECUTED_RUNS_SQL}`,
      )
      .get(p.project, p.task) as {
      total: number
      successes: number
      failures: number
      hits: number
      retried: number
      totalDurationMs: number | null
      lastSeenAt: number | null
    }
    const total = aggregate.total || 0
    const failures = aggregate.failures || 0
    const failureMode = classifyFailureMode(db, p.project, p.task, {
      total,
      failures,
      retried: aggregate.retried || 0,
    })
    const durations = db
      .query(
        `SELECT duration_ms FROM runs
         WHERE project = ? AND task = ?
           AND (cache_hit IS NULL OR cache_hit = 0)
           AND status = 'success'
         ORDER BY started_at DESC LIMIT 50`,
      )
      .all(p.project, p.task) as { duration_ms: number }[]
    const sorted = durations.map((r) => r.duration_ms).sort((a, b) => a - b)
    const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : undefined
    return {
      id: `${p.project}#${p.task}`,
      project: p.project,
      task: p.task,
      runs: total,
      successes: aggregate.successes || 0,
      failures,
      hits: aggregate.hits || 0,
      successRate: total > 0 ? (aggregate.successes || 0) / total : 0,
      hitRate: total > 0 ? (aggregate.hits || 0) / total : 0,
      failureMode,
      p50DurationMs: pickPercentile(sorted, 0.5),
      p99DurationMs: pickPercentile(sorted, 0.99),
      minDurationMs: sorted[0],
      maxDurationMs: sorted[sorted.length - 1],
      avgDurationMs: avg !== undefined ? Math.round(avg) : undefined,
      totalDurationMs: aggregate.totalDurationMs ?? 0,
      lastSeenAt: aggregate.lastSeenAt ?? undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// Top time-burners — where to invest
// ---------------------------------------------------------------------------

export interface TopTaskRow {
  id: string
  project: string
  task: string
  runs: number
  totalDurationMs: number
  avgDurationMs: number
}

export function getTopTimeBurners(db: Database, limit = 10): TopTaskRow[] {
  return db
    .query(
      `SELECT project || '#' || task AS id, project, task,
              COUNT(*) AS runs,
              SUM(duration_ms) AS totalDurationMs,
              CAST(AVG(duration_ms) AS INTEGER) AS avgDurationMs
       FROM runs
       WHERE (cache_hit IS NULL OR cache_hit = 0) AND status = 'success'
       GROUP BY project, task
       ORDER BY SUM(duration_ms) DESC
       LIMIT ?`,
    )
    .all(clampInt(limit, 1, 100)) as TopTaskRow[]
}

// ---------------------------------------------------------------------------
// Recent failures — what's bleeding right now
// ---------------------------------------------------------------------------

export interface FailureRow {
  runId: string | null
  project: string
  task: string
  exitCode: number
  durationMs: number
  startedAt: number
  hash: string
}

export function getRecentFailures(db: Database, limit = 25): FailureRow[] {
  return db
    .query(
      `SELECT run_id AS runId, project, task, exit_code AS exitCode,
              duration_ms AS durationMs, started_at AS startedAt, hash
       FROM runs
       WHERE status = 'failed'
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(clampInt(limit, 1, 200)) as FailureRow[]
}

// ---------------------------------------------------------------------------
// Cache entries — what's actually stored
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

export interface ListCacheEntriesArgs {
  limit?: number
  orderBy?: 'created_at' | 'accessed_at' | 'size_bytes' | 'duration_ms'
  project?: string
}

export function listCacheEntries(db: Database, args: ListCacheEntriesArgs = {}): CacheEntryRow[] {
  const limit = clampInt(args.limit ?? 100, 1, 500)
  const orderBy = args.orderBy ?? 'created_at'
  const allowed = new Set(['created_at', 'accessed_at', 'size_bytes', 'duration_ms'])
  const order = allowed.has(orderBy) ? orderBy : 'created_at'
  const where: string[] = []
  const params: (string | number)[] = []
  if (args.project) {
    where.push('project = ?')
    params.push(args.project)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  return db
    .query(
      `SELECT hash, project, task, command, exit_code AS exitCode,
              duration_ms AS durationMs, size_bytes AS sizeBytes,
              created_at AS createdAt, accessed_at AS accessedAt
       FROM entries ${clause}
       ORDER BY ${order} DESC
       LIMIT ?`,
    )
    .all(...params, limit) as CacheEntryRow[]
}

// ---------------------------------------------------------------------------
// Cache breakdown — bytes per project
// ---------------------------------------------------------------------------

export interface CacheProjectRow {
  project: string
  entries: number
  totalBytes: number
}

export function getCacheBreakdown(db: Database, limit = 20): CacheProjectRow[] {
  return db
    .query(
      `SELECT project,
              COUNT(*) AS entries,
              COALESCE(SUM(size_bytes), 0) AS totalBytes
       FROM entries
       GROUP BY project
       ORDER BY SUM(size_bytes) DESC
       LIMIT ?`,
    )
    .all(clampInt(limit, 1, 100)) as CacheProjectRow[]
}

// ---------------------------------------------------------------------------
// Task detail — full history for one (project, task)
// ---------------------------------------------------------------------------

export interface TaskDetail {
  project: string
  task: string
  aggregate: TaskHistoryRow | null
  recent: RunSummaryRow[]
  latestEntry: CacheEntryRow | null
}

export function getTaskDetail(db: Database, taskId: string): TaskDetail | null {
  const [project, task] = splitTaskId(taskId)
  const existsRow = db
    .query('SELECT 1 FROM runs WHERE project = ? AND task = ? LIMIT 1')
    .get(project, task) as { 1: number } | undefined
  if (!existsRow) {
    const entryProbe = db
      .query('SELECT 1 FROM entries WHERE project = ? AND task = ? LIMIT 1')
      .get(project, task)
    if (!entryProbe) return null
  }
  const recent = listRuns(db, { project, task, limit: 100 })
  const histRows = getHistory(db, { project, task, limit: 1 })
  const entry = db
    .query(
      `SELECT hash, project, task, command, exit_code AS exitCode,
              duration_ms AS durationMs, size_bytes AS sizeBytes,
              created_at AS createdAt, accessed_at AS accessedAt
       FROM entries WHERE project = ? AND task = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(project, task) as CacheEntryRow | undefined
  return {
    project,
    task,
    aggregate: histRows[0] ?? null,
    recent,
    latestEntry: entry ?? null,
  }
}

// ---------------------------------------------------------------------------
// Cache savings — how much time the cache saved you (rough estimate)
// ---------------------------------------------------------------------------

export interface CacheSavings {
  /** EVERY cache hit in the last 24h — the same population `getCacheStatsSql`
   *  and `getHitRateSplit` count. */
  hitsLast24h: number
  /**
   * The subset of `hitsLast24h` that has a local executed-success baseline to
   * price against, and so contributes to `estimatedTimeSavedMs`. On a fresh
   * runner served by a warm remote cache this is legitimately 0 while
   * `hitsLast24h` is large — the hits are real, the saving is unmeasurable.
   */
  attributedHitsLast24h: number
  estimatedTimeSavedMs: number
  estimatedTimeSavedTotalMs: number
}

/**
 * For each cache-hit run, attribute the avg non-hit duration of the
 * same (project, task) as "time saved." Rough but useful — shows the
 * payoff of caching at a glance.
 */
export function getCacheSavings(db: Database): CacheSavings {
  const since = Date.now() - 24 * 60 * 60 * 1000
  // COUNT(*) counts every hit; COUNT(avgDur) counts the priceable subset, and
  // SUM ignores NULLs — so the hit count no longer inherits the baseline
  // filter that the SAVINGS figure needs.
  const r24 = db
    .query(
      `SELECT COALESCE(SUM(avgDur), 0) AS saved,
              COUNT(*) AS hits,
              COUNT(avgDur) AS attributed FROM (
         SELECT r.project, r.task,
                (SELECT CAST(AVG(duration_ms) AS INTEGER) FROM runs s
                 WHERE s.project = r.project AND s.task = r.task
                   AND (s.cache_hit IS NULL OR s.cache_hit = 0)
                   AND s.status = 'success') AS avgDur
         FROM runs r
         WHERE r.started_at >= ?
           AND (r.cache_hit = 1 OR r.status LIKE 'cache-hit%')
       )`,
    )
    .get(since) as { saved: number; hits: number; attributed: number }
  const rAll = db
    .query(
      `SELECT COALESCE(SUM(avgDur), 0) AS saved FROM (
         SELECT r.project, r.task,
                (SELECT CAST(AVG(duration_ms) AS INTEGER) FROM runs s
                 WHERE s.project = r.project AND s.task = r.task
                   AND (s.cache_hit IS NULL OR s.cache_hit = 0)
                   AND s.status = 'success') AS avgDur
         FROM runs r
         WHERE (r.cache_hit = 1 OR r.status LIKE 'cache-hit%')
       ) WHERE avgDur IS NOT NULL`,
    )
    .get() as { saved: number }
  return {
    hitsLast24h: r24.hits,
    attributedHitsLast24h: r24.attributed,
    estimatedTimeSavedMs: r24.saved,
    estimatedTimeSavedTotalMs: rAll.saved,
  }
}

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
          ? 'cache key unchanged — re-run with the same key (likely --no-cache or unrelated)'
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
export interface CompareTaskSide {
  status: string
  durationMs: number
  hash: string
  cacheHit: boolean | null
  exitCode: number
}

/** A per-task diff row. `a` = this run, `b` = the previous run. */
export interface CompareTaskRow {
  taskId: string
  project: string
  task: string
  a: CompareTaskSide | null
  b: CompareTaskSide | null
  /** Cache key differs (or the task is only on one side). */
  hashChanged: boolean
  /** a.durationMs − b.durationMs; null when either side is absent. */
  durationDeltaMs: number | null
  /** Outcome status differs (or the task is only on one side). */
  statusChanged: boolean
}

export interface CompareRuns {
  runId: string
  previousRunId: string | null
  startedAt: number | null
  prevStartedAt: number | null
  found: boolean
  summary: {
    aTotalMs: number
    bTotalMs: number
    totalDeltaMs: number
    tasksChanged: number
    tasksOnlyInA: number
    tasksOnlyInB: number
  }
  tasks: CompareTaskRow[]
  note: string
}

function sideOf(row: RunSummaryRow): CompareTaskSide {
  return {
    status: row.status,
    durationMs: row.durationMs,
    hash: row.hash,
    cacheHit: row.cacheHit,
    exitCode: row.exitCode,
  }
}

/**
 * Compare a run to the immediately-previous invocation (the one with the
 * largest `started_at` strictly before this run's start). For every task in
 * either invocation, emit a diff row. Tasks present on only one side carry a
 * null on the missing side and count as changed.
 */
export function compareRuns(db: Database, runId: string): CompareRuns {
  const aRun = getRun(db, runId)
  if (!aRun) {
    return {
      runId,
      previousRunId: null,
      startedAt: null,
      prevStartedAt: null,
      found: false,
      summary: {
        aTotalMs: 0,
        bTotalMs: 0,
        totalDeltaMs: 0,
        tasksChanged: 0,
        tasksOnlyInA: 0,
        tasksOnlyInB: 0,
      },
      tasks: [],
      note: 'no run matching that runId',
    }
  }
  const prev = db
    .query(
      `SELECT run_id AS runId, MIN(started_at) AS startedAt
       FROM runs
       WHERE run_id IS NOT NULL AND run_id != ? AND started_at < ?
       GROUP BY run_id
       ORDER BY MIN(started_at) DESC
       LIMIT 1`,
    )
    .get(runId, aRun.startedAt) as { runId: string; startedAt: number } | undefined

  const bRun = prev ? getRun(db, prev.runId) : null

  // Key by project#task; a run can list a task once per invocation.
  const byKeyA = new Map(aRun.tasks.map((t) => [`${t.project}#${t.task}`, t]))
  const byKeyB = new Map((bRun?.tasks ?? []).map((t) => [`${t.project}#${t.task}`, t]))
  const keys = [...new Set([...byKeyA.keys(), ...byKeyB.keys()])].sort()

  let aTotalMs = 0
  let bTotalMs = 0
  let tasksChanged = 0
  let tasksOnlyInA = 0
  let tasksOnlyInB = 0

  const tasks: CompareTaskRow[] = keys.map((key) => {
    const ra = byKeyA.get(key)
    const rb = byKeyB.get(key)
    const a = ra ? sideOf(ra) : null
    const b = rb ? sideOf(rb) : null
    if (a) aTotalMs += a.durationMs
    if (b) bTotalMs += b.durationMs
    const hashChanged = a !== null && b !== null ? a.hash !== b.hash : true
    const statusChanged = a !== null && b !== null ? a.status !== b.status : true
    const durationDeltaMs = a !== null && b !== null ? a.durationMs - b.durationMs : null
    if (!b) tasksOnlyInA++
    if (!a) tasksOnlyInB++
    if (hashChanged || statusChanged) tasksChanged++
    const [project, task] = splitTaskId(key)
    return { taskId: key, project, task, a, b, hashChanged, durationDeltaMs, statusChanged }
  })

  return {
    runId,
    previousRunId: prev?.runId ?? null,
    startedAt: aRun.startedAt,
    prevStartedAt: prev?.startedAt ?? null,
    found: prev != null,
    summary: {
      aTotalMs,
      bTotalMs,
      totalDeltaMs: aTotalMs - bTotalMs,
      tasksChanged,
      tasksOnlyInA,
      tasksOnlyInB,
    },
    tasks,
    note: prev
      ? 'compared against the immediately-previous invocation'
      : 'no previous invocation to compare against',
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of time buckets a trend fill-loop may emit. These
 * are public façade exports, so an embedder / plugin can hand in an enormous
 * `from`/`to`/`days` span (`{ from: 0, to: 1e15 }`) and drive a synchronous
 * fill loop into hundreds of millions of allocations — a hang or an OOM.
 * 10k covers >400 days of hourly buckets, far beyond any real range. Mirrors
 * `MAX_TREND_BUCKETS` in packages/cloud/src/db/analytics.ts.
 */
const MAX_TREND_BUCKETS = 10_000

/**
 * Cap on a caller-supplied day span. A huge span makes `WHERE created_at >=
 * <since>` degenerate to a full table scan; clamping to ~1 year keeps the
 * fetch bounded to the intended range. Mirrors `MAX_WINDOW_DAYS` in
 * packages/cloud/src/db/analytics.ts.
 */
const MAX_WINDOW_DAYS = 366

function pickPercentile(sorted: number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[idx]
}

// ---------------------------------------------------------------------------
// Project-level rollups — where the time and storage actually sit
// ---------------------------------------------------------------------------

export interface ProjectRollup {
  project: string
  taskCount: number
  runs: number
  failures: number
  hits: number
  hitRate: number
  totalDurationMs: number
  avgDurationMs: number
  cacheBytes: number
  cacheEntries: number
  lastRunAt: number | undefined
  estimatedTimeSavedMs: number
}

export function listProjects(db: Database, limit = 100): ProjectRollup[] {
  const rows = db
    .query(
      `SELECT project,
              COUNT(DISTINCT task) AS taskCount,
              COUNT(*) AS runs,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
              SUM(CASE WHEN cache_hit = 1 OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END) AS hits,
              SUM(duration_ms) AS totalDurationMs,
              CAST(AVG(duration_ms) AS INTEGER) AS avgDurationMs,
              MAX(ended_at) AS lastRunAt
       FROM runs WHERE ${EXECUTED_RUNS_SQL}
       GROUP BY project ORDER BY SUM(duration_ms) DESC LIMIT ?`,
    )
    .all(clampInt(limit, 1, 500)) as Array<{
    project: string
    taskCount: number
    runs: number
    failures: number
    hits: number
    totalDurationMs: number | null
    avgDurationMs: number | null
    lastRunAt: number | null
  }>
  return rows.map((r) => {
    const ent = db
      .query(
        'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b FROM entries WHERE project = ?',
      )
      .get(r.project) as { n: number; b: number }
    const saved = db
      .query(
        `SELECT COALESCE(SUM(avg), 0) AS saved FROM (
           SELECT (SELECT CAST(AVG(duration_ms) AS INTEGER) FROM runs s
                   WHERE s.project = r.project AND s.task = r.task
                     AND (s.cache_hit IS NULL OR s.cache_hit = 0)
                     AND s.status = 'success') AS avg
           FROM runs r WHERE r.project = ?
             AND (r.cache_hit = 1 OR r.status LIKE 'cache-hit%')
         ) WHERE avg IS NOT NULL`,
      )
      .get(r.project) as { saved: number }
    return {
      project: r.project,
      taskCount: r.taskCount,
      runs: r.runs,
      failures: r.failures,
      hits: r.hits,
      hitRate: r.runs > 0 ? r.hits / r.runs : 0,
      totalDurationMs: r.totalDurationMs ?? 0,
      avgDurationMs: r.avgDurationMs ?? 0,
      cacheBytes: ent.b,
      cacheEntries: ent.n,
      lastRunAt: r.lastRunAt ?? undefined,
      estimatedTimeSavedMs: saved.saved,
    }
  })
}

// ---------------------------------------------------------------------------
// Trends — bucketed time-series for charts
// ---------------------------------------------------------------------------

export type TrendBucket = 'hour' | 'day'

export interface TrendPoint {
  /** Epoch ms at the start of the bucket. */
  t: number
  runs: number
  hits: number
  /** `status = 'cache-hit'` in the bucket (local restores). */
  hitsLocal: number
  /** `status = 'cache-hit-remote'` in the bucket (remote pulls). */
  hitsRemote: number
  failures: number
  /** Sum of duration_ms in the bucket. */
  totalDurationMs: number
}

/**
 * Bucketed run counts + failure/hit/duration over time. Default range = last
 * 24h for hour buckets, last 30d for day buckets — picked to match the chart
 * defaults clients use.
 */
export function getRunTrends(
  db: Database,
  args: { bucket?: TrendBucket; from?: number; to?: number } = {},
): TrendPoint[] {
  const bucket: TrendBucket = args.bucket ?? 'hour'
  const bucketMs = bucket === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  // Clamp the span before it reaches the densify loop below: `to` no later
  // than now, `from` no earlier than MAX_TREND_BUCKETS buckets back — keeping
  // the MOST RECENT buckets, which is what a chart wants. Bounds the loop, the
  // array, AND the SQL range. Real ranges (24h hourly / 30d daily) are far
  // under the cap, so their results are unchanged.
  const now = Date.now()
  const to = Math.min(args.to ?? now, now)
  const defaultRangeMs = bucket === 'hour' ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
  const minFrom = to - (MAX_TREND_BUCKETS - 1) * bucketMs
  const from = Math.max(args.from ?? to - defaultRangeMs, minFrom)
  // Floor each timestamp to its bucket boundary in SQL so partial buckets line
  // up cleanly. `started_at` is already epoch-ms.
  const rows = db
    .query(
      `SELECT (started_at / ?) * ? AS t,
              COUNT(*) AS runs,
              SUM(CASE WHEN cache_hit = 1 OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END) AS hits,
              SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END) AS hitsLocal,
              SUM(CASE WHEN status = 'cache-hit-remote' THEN 1 ELSE 0 END) AS hitsRemote,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
              SUM(duration_ms) AS totalDurationMs
       FROM runs
       WHERE started_at >= ? AND started_at <= ? AND ${EXECUTED_RUNS_SQL}
       GROUP BY t ORDER BY t ASC`,
    )
    .all(bucketMs, bucketMs, from, to) as TrendPoint[]
  // Densify — emit zeros for empty buckets so the chart line stays continuous.
  const start = Math.floor(from / bucketMs) * bucketMs
  const end = Math.floor(to / bucketMs) * bucketMs
  const byT = new Map(rows.map((r) => [r.t, r]))
  const out: TrendPoint[] = []
  for (let t = start; t <= end; t += bucketMs) {
    out.push(
      byT.get(t) ?? {
        t,
        runs: 0,
        hits: 0,
        hitsLocal: 0,
        hitsRemote: 0,
        failures: 0,
        totalDurationMs: 0,
      },
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Heatmap — runs per (hour-of-day, day-of-week)
// ---------------------------------------------------------------------------

export interface HeatmapCell {
  /** 0 = Sun … 6 = Sat */
  dayOfWeek: number
  /** 0 … 23, local time */
  hourOfDay: number
  runs: number
  totalDurationMs: number
}

/** When do builds happen? Surfaces a 7×24 grid for the last `days` days. */
export function getRunHeatmap(db: Database, days = 30): HeatmapCell[] {
  // Same clamp as the trend readers: a hostile `days` makes `since` hugely
  // negative and the scan degenerate. The 7x24 grid is fixed-size, so this
  // bounds the FETCH, not the output.
  const since = Date.now() - clampInt(days, 1, MAX_WINDOW_DAYS) * 24 * 60 * 60 * 1000
  // Pull raw rows; bucket in JS (timezone math is ugly in pure SQLite, and
  // `days * 24 * runs/day` rows is a few thousand at most).
  const rows = db
    .query(
      `SELECT started_at, duration_ms FROM runs WHERE started_at >= ? AND ${EXECUTED_RUNS_SQL}`,
    )
    .all(since) as { started_at: number; duration_ms: number }[]
  const grid: HeatmapCell[] = []
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++)
      grid.push({ dayOfWeek: d, hourOfDay: h, runs: 0, totalDurationMs: 0 })
  for (const r of rows) {
    const date = new Date(r.started_at)
    const cell = grid[date.getDay() * 24 + date.getHours()]!
    cell.runs++
    cell.totalDurationMs += r.duration_ms
  }
  return grid
}

// ---------------------------------------------------------------------------
// Flakiness — tasks that fail unpredictably or whose p99/p50 gap is wide
// ---------------------------------------------------------------------------

export interface FlakyTask {
  id: string
  project: string
  task: string
  runs: number
  failures: number
  failureRate: number
  /**
   * Runs where the task needed MORE than one attempt (`exec.retries` /
   * `--retry` re-ran it and it eventually passed). This is the DIRECT
   * flaky signal — a task that failed then passed under identical inputs
   * is nondeterministic by definition, no cross-run inference needed.
   */
  withinRunRetries: number
  /** The worst attempt count seen in any single run (undefined if never retried). */
  maxAttempts: number | undefined
  /** True when `withinRunRetries > 0` — flakiness is CONFIRMED, not inferred. */
  flakyConfirmed: boolean
  /**
   * Distinct cache keys that produced BOTH a failure and a success across
   * runs — the cross-run nondeterminism signal (identical inputs, different
   * outcomes). Failures that each sit on their own key are legitimate breaks
   * and do NOT flag a task as flaky.
   */
  mixedOutcomeKeys: number
  /** p99 / p50 ratio for successful non-hit runs; >3 flags wide tail. */
  durationTailRatio: number | undefined
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
}

export function getFlakiestTasks(db: Database, limit = 25): FlakyTask[] {
  // A within-run retry is a confirmed flake even with few runs, so surface
  // such a task regardless of run count; cross-run failure variance still
  // needs 3+ runs to be meaningful (else a single red build reads as flaky).
  const pairs = db
    .query(
      `SELECT project, task, COUNT(*) AS runs,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
              SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS within_run_retries,
              MAX(attempts) AS max_attempts
       FROM runs WHERE ${EXECUTED_RUNS_SQL}
       GROUP BY project, task
       HAVING runs >= 3 OR within_run_retries > 0`,
    )
    .all() as {
    project: string
    task: string
    runs: number
    failures: number
    within_run_retries: number
    max_attempts: number | null
  }[]
  return pairs
    .map((p) => {
      const durs = db
        .query(
          `SELECT duration_ms FROM runs
           WHERE project = ? AND task = ?
             AND (cache_hit IS NULL OR cache_hit = 0) AND status = 'success'
           ORDER BY started_at DESC LIMIT 50`,
        )
        .all(p.project, p.task) as { duration_ms: number }[]
      const sorted = durs.map((r) => r.duration_ms).sort((a, b) => a - b)
      const p50 = pickPercentile(sorted, 0.5)
      const p99 = pickPercentile(sorted, 0.99)
      const ratio = p50 && p50 > 0 && p99 !== undefined ? p99 / p50 : undefined
      return {
        id: `${p.project}#${p.task}`,
        project: p.project,
        task: p.task,
        runs: p.runs,
        failures: p.failures,
        failureRate: p.runs > 0 ? p.failures / p.runs : 0,
        withinRunRetries: p.within_run_retries,
        maxAttempts: p.max_attempts ?? undefined,
        flakyConfirmed: p.within_run_retries > 0,
        mixedOutcomeKeys: p.failures > 0 ? mixedOutcomeKeyCount(db, p.project, p.task) : 0,
        durationTailRatio: ratio,
        p50DurationMs: p50,
        p99DurationMs: p99,
      } satisfies FlakyTask
    })
    .filter(
      (r) =>
        r.flakyConfirmed ||
        r.mixedOutcomeKeys > 0 ||
        (r.durationTailRatio !== undefined && r.durationTailRatio > 2),
    )
    .sort((a, b) => {
      // Confirmed-flaky tasks (a real within-run retry) outrank the same-key
      // inferred ones, which outrank wide-tail-only rows; within each tier,
      // failure rate dominates and the duration tail breaks ties.
      const score = (r: FlakyTask) =>
        (r.flakyConfirmed ? 100 : 0) +
        (r.mixedOutcomeKeys > 0 ? 50 : 0) +
        r.failureRate * 10 +
        (r.durationTailRatio ?? 1)
      return score(b) - score(a)
    })
    .slice(0, clampInt(limit, 1, 200))
}

// ---------------------------------------------------------------------------
// Regressions — "which tasks just started failing across branches?"
// ---------------------------------------------------------------------------

/**
 * A task that is currently failing on one or more branches and USED to pass —
 * a regression, distinct from a flaky task (nondeterministic) or a task that
 * has always been broken. "Across branches" is the key signal: a task failing
 * on several branches at once points at a real break in that task or in shared
 * code, not one developer's work-in-progress branch.
 */
export interface RegressedTask {
  id: string
  project: string
  task: string
  /** Distinct branches whose MOST-RECENT run in the window failed. */
  branchesFailing: number
  /** Distinct branches the task ran on in the window. */
  branchesTotal: number
  /** The currently-failing branch names (capped). */
  branches: string[]
  /**
   * True if the task has any prior successful run — it regressed, rather than
   * being perpetually broken. A regression is the more urgent signal.
   */
  regressed: boolean
  /** Earliest failed run in the window (ms epoch) — ≈ when it started failing. */
  firstFailedAt: number
  /** Most-recent run in the window (ms epoch). */
  lastRunAt: number
  /** Failed runs in the window. */
  failures: number
  /** Total runs in the window. */
  runs: number
}

export interface RegressionArgs {
  /** Look-back window in days. Default 7. */
  sinceDays?: number
  /** Minimum distinct currently-failing branches to surface. Default 2
   *  ("across branches"); pass 1 to include single-branch regressions. */
  minBranches?: number
  limit?: number
}

const PASS_STATUSES = "('success', 'cache-hit', 'cache-hit-remote')"
const BRANCH_CAP = 12

export function getRegressions(db: Database, args: RegressionArgs = {}): RegressedTask[] {
  const sinceDays = args.sinceDays ?? 7
  const minBranches = Math.max(1, args.minBranches ?? 2)
  const limit = clampInt(args.limit ?? 25, 1, 200)
  const since = Date.now() - sinceDays * 86_400_000

  // The most-recent non-skipped run per (task, branch) in the window: its
  // status is that task's CURRENT state on that branch. Skipped/aborted runs
  // never finished on their own terms, so they're excluded from the state.
  const latest = db
    .query(
      `WITH windowed AS (
         SELECT r.project AS project, r.task AS task, inv.branch AS branch,
                r.status AS status,
                ROW_NUMBER() OVER (
                  PARTITION BY r.project, r.task, inv.branch
                  ORDER BY r.started_at DESC, r.run_id DESC
                ) AS rn
         FROM runs r JOIN invocations inv ON r.run_id = inv.run_id
         WHERE inv.branch IS NOT NULL
           AND r.started_at >= ?
           AND r.status IN ('success', 'failed', 'cache-hit', 'cache-hit-remote')
       )
       SELECT project, task, branch, status FROM windowed WHERE rn = 1`,
    )
    .all(since) as { project: string; task: string; branch: string; status: string }[]

  // Aggregate the latest-per-branch rows into per-task failing/total branch
  // sets. `failing` = the task's most recent run on that branch failed.
  const byTask = new Map<
    string,
    { project: string; task: string; failing: string[]; total: Set<string> }
  >()
  for (const r of latest) {
    const id = `${r.project}#${r.task}`
    let agg = byTask.get(id)
    if (agg === undefined) {
      agg = { project: r.project, task: r.task, failing: [], total: new Set() }
      byTask.set(id, agg)
    }
    agg.total.add(r.branch)
    if (r.status === 'failed') agg.failing.push(r.branch)
  }

  const out: RegressedTask[] = []
  for (const [id, agg] of byTask) {
    if (agg.failing.length < minBranches) continue
    // Per-task follow-ups (the getFlakiestTasks pattern) — the regressed set
    // is small, so a couple of point queries each is cheap.
    const win = db
      .query(
        `SELECT COUNT(*) AS runs,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
                MIN(CASE WHEN status = 'failed' THEN started_at END) AS first_failed,
                MAX(started_at) AS last_run
         FROM runs
         WHERE project = ? AND task = ? AND started_at >= ? AND ${EXECUTED_RUNS_SQL}`,
      )
      .get(agg.project, agg.task, since) as {
      runs: number
      failures: number | null
      first_failed: number | null
      last_run: number | null
    }
    const everPassed =
      db
        .query(
          `SELECT 1 FROM runs WHERE project = ? AND task = ? AND status IN ${PASS_STATUSES} LIMIT 1`,
        )
        .get(agg.project, agg.task) !== null
    out.push({
      id,
      project: agg.project,
      task: agg.task,
      branchesFailing: agg.failing.length,
      branchesTotal: agg.total.size,
      branches: agg.failing.sort().slice(0, BRANCH_CAP),
      regressed: everPassed,
      firstFailedAt: win.first_failed ?? 0,
      lastRunAt: win.last_run ?? 0,
      failures: win.failures ?? 0,
      runs: win.runs,
    })
  }
  // Regressions (used-to-pass) first, then most branches affected, then the
  // most recently-started failures — the "act on this now" ordering.
  return out
    .sort(
      (a, b) =>
        Number(b.regressed) - Number(a.regressed) ||
        b.branchesFailing - a.branchesFailing ||
        b.firstFailedAt - a.firstFailedAt,
    )
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Period-over-period analysis — "how is CI trending vs the previous window,
// and which tasks moved the most?" Two adjacent equal-length windows.
// ---------------------------------------------------------------------------

export interface PeriodStats {
  /** Distinct runs (invocations) in the window. */
  runs: number
  /** Task executions recorded (rows). */
  taskRuns: number
  /** Executions that actually ran (not a cache hit). */
  executed: number
  /** Failed task executions. */
  failures: number
  /** Cache-hit task executions (local or remote). */
  cacheHits: number
  /** Sum of executed-task durations (ms). */
  totalDurationMs: number
  /** Mean duration of successful executed tasks (ms). */
  avgDurationMs: number
  p50DurationMs: number | undefined
  p95DurationMs: number | undefined
  /** failures / taskRuns. */
  failureRate: number
  /** cacheHits / taskRuns. */
  cacheHitRate: number
}

export interface TaskMover {
  id: string
  project: string
  task: string
  currentAvgMs: number
  previousAvgMs: number
  /** current − previous (positive = slower / regressed). */
  deltaMs: number
  /** (current − previous) / previous, as a fraction. */
  deltaPct: number
  currentRuns: number
  previousRuns: number
}

export interface PeriodComparison {
  windowDays: number
  current: { from: number; to: number; stats: PeriodStats }
  previous: { from: number; to: number; stats: PeriodStats }
  /**
   * Tasks whose average executed duration moved the most between the two
   * windows, by absolute impact (biggest ms shift first; positive = slower).
   * Only tasks with >= minRuns successful executions in BOTH windows qualify,
   * so a mover reflects a real trend, not one-off noise.
   */
  movers: TaskMover[]
}

export interface PeriodComparisonArgs {
  /** Length of each window in days. Default 7 (this week vs last week). */
  windowDays?: number
  /** End of the CURRENT window (ms). Default now — override for tests. */
  endMs?: number
  /** Min successful executions in EACH window for a mover to qualify. Default 3. */
  minRuns?: number
  /** Max movers returned. Default 8. */
  limit?: number
  /** Scope to one project — the project-detail "did MY project trend?" view. */
  project?: string
  /** Scope to one task within `project` — the task-detail trend. */
  task?: string
}

/** Optional per-project/task scoping shared by the two window queries. */
interface PeriodScope {
  project?: string
  task?: string
}

function scopeSql(scope: PeriodScope): { sql: string; params: string[] } {
  let sql = ''
  const params: string[] = []
  if (scope.project !== undefined) {
    sql += ' AND project = ?'
    params.push(scope.project)
  }
  if (scope.task !== undefined) {
    sql += ' AND task = ?'
    params.push(scope.task)
  }
  return { sql, params }
}

function periodStats(db: Database, from: number, to: number, scope: PeriodScope): PeriodStats {
  const { sql, params } = scopeSql(scope)
  const agg = db
    .query(
      // COALESCE every SUM: over an empty window SQLite SUM() returns NULL, and
      // the previous window is empty for any workspace younger than the window
      // (a fresh serve, a quiet prior week) — a bare SUM would ship `null` where
      // PeriodStats declares `number`, throwing on the client's `.toFixed()`.
      `SELECT COUNT(*) AS taskRuns,
              COUNT(DISTINCT run_id) AS runs,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failures,
              COALESCE(SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END), 0) AS cacheHits,
              COALESCE(SUM(CASE WHEN cache_hit IS NULL OR cache_hit = 0 THEN 1 ELSE 0 END), 0) AS executed,
              COALESCE(SUM(CASE WHEN cache_hit IS NULL OR cache_hit = 0 THEN duration_ms ELSE 0 END), 0) AS totalDurationMs
       FROM runs WHERE started_at >= ? AND started_at < ? AND ${EXECUTED_RUNS_SQL}${sql}`,
    )
    .get(from, to, ...params) as {
    taskRuns: number
    runs: number
    failures: number
    cacheHits: number
    executed: number
    totalDurationMs: number
  }
  const durs = (
    db
      .query(
        `SELECT duration_ms AS d FROM runs
         WHERE started_at >= ? AND started_at < ?
           AND (cache_hit IS NULL OR cache_hit = 0) AND status = 'success'${sql}
         ORDER BY duration_ms`,
      )
      .all(from, to, ...params) as { d: number }[]
  ).map((r) => r.d)
  const taskRuns = agg.taskRuns
  return {
    runs: agg.runs,
    taskRuns,
    executed: agg.executed,
    failures: agg.failures,
    cacheHits: agg.cacheHits,
    totalDurationMs: agg.totalDurationMs,
    avgDurationMs: durs.length > 0 ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0,
    p50DurationMs: pickPercentile(durs, 0.5),
    p95DurationMs: pickPercentile(durs, 0.95),
    failureRate: taskRuns > 0 ? agg.failures / taskRuns : 0,
    cacheHitRate: taskRuns > 0 ? agg.cacheHits / taskRuns : 0,
  }
}

function avgByTask(
  db: Database,
  from: number,
  to: number,
  scope: PeriodScope,
): Map<string, { avg: number; runs: number; project: string; task: string }> {
  const { sql, params } = scopeSql(scope)
  const rows = db
    .query(
      `SELECT project, task, AVG(duration_ms) AS avg, COUNT(*) AS runs
       FROM runs
       WHERE started_at >= ? AND started_at < ?
         AND (cache_hit IS NULL OR cache_hit = 0) AND status = 'success'${sql}
       GROUP BY project, task`,
    )
    .all(from, to, ...params) as { project: string; task: string; avg: number; runs: number }[]
  return new Map(
    rows.map((r) => [
      `${r.project}#${r.task}`,
      { avg: r.avg, runs: r.runs, project: r.project, task: r.task },
    ]),
  )
}

export function getPeriodComparison(
  db: Database,
  args: PeriodComparisonArgs = {},
): PeriodComparison {
  const windowDays = Math.max(1, args.windowDays ?? 7)
  const minRuns = Math.max(1, args.minRuns ?? 3)
  const limit = clampInt(args.limit ?? 8, 1, 100)
  const scope: PeriodScope = {
    ...(args.project !== undefined ? { project: args.project } : {}),
    ...(args.task !== undefined ? { task: args.task } : {}),
  }
  const to = args.endMs ?? Date.now()
  const win = windowDays * 86_400_000
  const curFrom = to - win
  const prevTo = curFrom
  const prevFrom = curFrom - win

  const cur = avgByTask(db, curFrom, to, scope)
  const prev = avgByTask(db, prevFrom, prevTo, scope)
  const movers: TaskMover[] = []
  for (const [id, c] of cur) {
    const p = prev.get(id)
    if (p === undefined || c.runs < minRuns || p.runs < minRuns) continue
    movers.push({
      id,
      project: c.project,
      task: c.task,
      currentAvgMs: Math.round(c.avg),
      previousAvgMs: Math.round(p.avg),
      deltaMs: Math.round(c.avg - p.avg),
      deltaPct: p.avg > 0 ? (c.avg - p.avg) / p.avg : 0,
      currentRuns: c.runs,
      previousRuns: p.runs,
    })
  }
  movers.sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs))
  return {
    windowDays,
    current: { from: curFrom, to, stats: periodStats(db, curFrom, to, scope) },
    previous: { from: prevFrom, to: prevTo, stats: periodStats(db, prevFrom, prevTo, scope) },
    movers: movers.slice(0, limit),
  }
}

// ---------------------------------------------------------------------------
// Bottlenecks — "if you sped up X, you'd save Y per week"
// ---------------------------------------------------------------------------

export interface BottleneckRow {
  id: string
  project: string
  task: string
  /** Runs in the last `lookbackDays`. */
  runsRecent: number
  /** Total non-hit success duration over the lookback. */
  totalDurationMs: number
  avgDurationMs: number
  /** Runs/day extrapolated from the lookback. */
  runsPerDay: number
  /** Time you'd save per week if you cut avg duration by 25%. */
  weeklySavingsAt25PctCutMs: number
}

/** Highest-leverage targets ranked by extrapolated weekly burn. */
export function getBottlenecks(db: Database, lookbackDays = 14, limit = 15): BottleneckRow[] {
  const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000
  const rows = db
    .query(
      `SELECT project, task,
              COUNT(*) AS runsRecent,
              SUM(duration_ms) AS totalDurationMs,
              CAST(AVG(duration_ms) AS INTEGER) AS avgDurationMs
       FROM runs
       WHERE started_at >= ?
         AND (cache_hit IS NULL OR cache_hit = 0) AND status = 'success'
       GROUP BY project, task
       ORDER BY SUM(duration_ms) DESC
       LIMIT ?`,
    )
    .all(since, clampInt(limit, 1, 100)) as Array<{
    project: string
    task: string
    runsRecent: number
    totalDurationMs: number
    avgDurationMs: number
  }>
  return rows.map((r) => {
    const runsPerDay = r.runsRecent / Math.max(1, lookbackDays)
    const weeklySavings = Math.round(runsPerDay * 7 * r.avgDurationMs * 0.25)
    return {
      id: `${r.project}#${r.task}`,
      project: r.project,
      task: r.task,
      runsRecent: r.runsRecent,
      totalDurationMs: r.totalDurationMs,
      avgDurationMs: r.avgDurationMs,
      runsPerDay,
      weeklySavingsAt25PctCutMs: weeklySavings,
    } satisfies BottleneckRow
  })
}

// ---------------------------------------------------------------------------
// Parallelism factor — how many workers you actually utilized
// ---------------------------------------------------------------------------

export interface ParallelismPoint {
  runId: string
  startedAt: number
  /** Total task CPU time. */
  cpuSumMs: number
  /** Wallclock from first task start to last task end. */
  wallMs: number
  /** cpuSumMs / wallMs — effective parallelism (1 = serial). */
  factor: number
  taskCount: number
}

/** Per-invocation parallelism, recent first. */
export function getParallelismHistory(db: Database, limit = 50): ParallelismPoint[] {
  // Filter out trivially-short invocations (wall &lt; 50 ms): the cpu/wall
  // ratio is dominated by measurement noise there and produces 0.5×/2×
  // junk that pollutes the chart's average.
  const rows = db
    .query(
      `SELECT run_id AS runId,
              MIN(started_at) AS startedAt,
              MIN(started_at) AS minStart,
              MAX(ended_at) AS maxEnd,
              SUM(COALESCE(cpu_ms, duration_ms)) AS cpuSumMs,
              COUNT(*) AS taskCount
       FROM runs
       WHERE run_id IS NOT NULL AND ${EXECUTED_RUNS_SQL}
       GROUP BY run_id
       HAVING taskCount > 1 AND (MAX(ended_at) - MIN(started_at)) >= 50
       ORDER BY MAX(started_at) DESC
       LIMIT ?`,
    )
    .all(clampInt(limit, 1, 500)) as Array<{
    runId: string
    startedAt: number
    minStart: number
    maxEnd: number
    cpuSumMs: number | null
    taskCount: number
  }>
  return rows.map((r) => {
    const wallMs = Math.max(1, r.maxEnd - r.minStart)
    const cpuSumMs = r.cpuSumMs ?? 0
    return {
      runId: r.runId,
      startedAt: r.startedAt,
      cpuSumMs,
      wallMs,
      factor: cpuSumMs / wallMs,
      taskCount: r.taskCount,
    } satisfies ParallelismPoint
  })
}

// ---------------------------------------------------------------------------
// Cache storage growth — bytes over time, with prunable hint
// ---------------------------------------------------------------------------

export interface StoragePoint {
  /** Epoch ms at bucket start. */
  t: number
  /** Bytes added in the bucket. */
  bytesAdded: number
  entriesAdded: number
}

/**
 * Daily storage growth from the entries table. NOTE: this reflects the rows
 * still in entries (prune evicts; we can't reconstruct pruned bytes). For most
 * workspaces it's the right "what's the cache doing" view.
 */
export function getStorageGrowth(db: Database, days = 30): StoragePoint[] {
  const bucketMs = 24 * 60 * 60 * 1000
  // Clamp the window so a hostile/typo `days` can neither drive the densify
  // loop below unbounded nor turn the fetch into a full table scan.
  const since = Date.now() - clampInt(days, 1, MAX_WINDOW_DAYS) * bucketMs
  const rows = db
    .query(
      `SELECT (created_at / ?) * ? AS t,
              COALESCE(SUM(size_bytes), 0) AS bytesAdded,
              COUNT(*) AS entriesAdded
       FROM entries WHERE created_at >= ?
       GROUP BY t ORDER BY t ASC`,
    )
    .all(bucketMs, bucketMs, since) as StoragePoint[]
  const start = Math.floor(since / bucketMs) * bucketMs
  const end = Math.floor(Date.now() / bucketMs) * bucketMs
  const byT = new Map(rows.map((r) => [r.t, r]))
  const out: StoragePoint[] = []
  for (let t = start; t <= end; t += bucketMs) {
    out.push(byT.get(t) ?? { t, bytesAdded: 0, entriesAdded: 0 })
  }
  return out
}

// ---------------------------------------------------------------------------
// Stale / prunable entries — what to evict first
// ---------------------------------------------------------------------------

export interface PrunableEntry {
  hash: string
  project: string
  task: string
  sizeBytes: number
  createdAt: number
  accessedAt: number
  /** Days since last access. */
  ageDays: number
}

/** Entries unused for ≥ `minAgeDays`, ordered by size — best prune targets. */
export function getPrunableEntries(db: Database, minAgeDays = 7, limit = 50): PrunableEntry[] {
  const since = Date.now() - minAgeDays * 24 * 60 * 60 * 1000
  const rows = db
    .query(
      `SELECT hash, project, task, size_bytes AS sizeBytes,
              created_at AS createdAt, accessed_at AS accessedAt
       FROM entries WHERE accessed_at <= ?
       ORDER BY size_bytes DESC LIMIT ?`,
    )
    .all(since, clampInt(limit, 1, 500)) as Array<{
    hash: string
    project: string
    task: string
    sizeBytes: number
    createdAt: number
    accessedAt: number
  }>
  const now = Date.now()
  return rows.map((r) => ({
    ...r,
    ageDays: Math.max(0, Math.floor((now - r.accessedAt) / (24 * 60 * 60 * 1000))),
  }))
}
