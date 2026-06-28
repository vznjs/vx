// Metrics query module — pure functions over a `bun:sqlite` Database.
//
// `vx serve` exposes these as /v1/* HTTP routes; the dashboard SPA in
// apps/ui and `vx mcp` both read through them. One canonical home for
// every aggregate over the runs / entries tables.
//
// Pure SQL + JSON-safe return shapes. No Cache lifecycle here; the
// caller opens and closes. bigints are serialized as decimal strings
// for JSON compatibility (matches the WireEvent timeUnixNano rule).

import type { Database } from 'bun:sqlite'

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
       FROM runs WHERE started_at >= ?`,
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
       FROM runs WHERE started_at >= ?`,
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
  failureMode: 'stable' | 'flaky-recoverable' | 'flaky-fatal'
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
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const pairs = db.query(`SELECT DISTINCT project, task FROM runs ${clause}`).all(...params) as {
    project: string
    task: string
  }[]

  return pairs.slice(0, limit).map((p) => {
    const aggregate = db
      .query(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
           SUM(CASE WHEN cache_hit = 1 OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END) AS hits,
           SUM(duration_ms) AS totalDurationMs,
           MAX(ended_at) AS lastSeenAt
         FROM runs WHERE project = ? AND task = ?`,
      )
      .get(p.project, p.task) as {
      total: number
      successes: number
      failures: number
      hits: number
      totalDurationMs: number | null
      lastSeenAt: number | null
    }
    const total = aggregate.total || 0
    const failures = aggregate.failures || 0
    const failureMode: TaskHistoryRow['failureMode'] =
      failures === 0 ? 'stable' : failures < total / 5 ? 'flaky-recoverable' : 'flaky-fatal'
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
  const [project, task] = taskId.split('#', 2) as [string, string]
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
  hitsLast24h: number
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
  const r24 = db
    .query(
      `SELECT COALESCE(SUM(avgDur), 0) AS saved, COUNT(*) AS hits FROM (
         SELECT r.project, r.task,
                (SELECT CAST(AVG(duration_ms) AS INTEGER) FROM runs s
                 WHERE s.project = r.project AND s.task = r.task
                   AND (s.cache_hit IS NULL OR s.cache_hit = 0)
                   AND s.status = 'success') AS avgDur
         FROM runs r
         WHERE r.started_at >= ?
           AND (r.cache_hit = 1 OR r.status LIKE 'cache-hit%')
       ) WHERE avgDur IS NOT NULL`,
    )
    .get(since) as { saved: number; hits: number }
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
  const [project, task] = taskId.split('#', 2) as [string, string]
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
  const [project, task] = taskId.split('#', 2) as [string, string]
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
  const prev = db
    .query(
      `SELECT hash, status, cache_hit AS cacheHit, started_at AS startedAt
       FROM runs WHERE project = ? AND task = ? AND started_at < ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(project, task, this_.startedAt) as
    | { hash: string; status: string; cacheHit: number | null; startedAt: number }
    | undefined
  return {
    runId,
    taskId,
    found: true,
    thisRun: { ...this_, cacheHit: this_.cacheHit === null ? null : Boolean(this_.cacheHit) },
    previousRun: prev
      ? { ...prev, cacheHit: prev.cacheHit === null ? null : Boolean(prev.cacheHit) }
      : null,
    hashChanged: prev ? prev.hash !== this_.hash : null,
    note:
      prev && prev.hash !== this_.hash
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
  const [project, task] = taskId.split('#', 2) as [string, string]
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

  const prev = db
    .query(
      `SELECT run_id AS runId, hash FROM runs
       WHERE project = ? AND task = ? AND started_at < ?
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
    const [project, task] = key.split('#', 2) as [string, string]
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

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.floor(n)))
}

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
       FROM runs GROUP BY project ORDER BY SUM(duration_ms) DESC LIMIT ?`,
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
  const to = args.to ?? Date.now()
  const defaultRangeMs = bucket === 'hour' ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
  const from = args.from ?? to - defaultRangeMs
  const bucketMs = bucket === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
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
       WHERE started_at >= ? AND started_at <= ?
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
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  // Pull raw rows; bucket in JS (timezone math is ugly in pure SQLite, and
  // `days * 24 * runs/day` rows is a few thousand at most).
  const rows = db
    .query('SELECT started_at, duration_ms FROM runs WHERE started_at >= ?')
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
  /** p99 / p50 ratio for successful non-hit runs; >3 flags wide tail. */
  durationTailRatio: number | undefined
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
}

export function getFlakiestTasks(db: Database, limit = 25): FlakyTask[] {
  const pairs = db
    .query(
      `SELECT project, task, COUNT(*) AS runs,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
       FROM runs GROUP BY project, task HAVING runs >= 3`,
    )
    .all() as { project: string; task: string; runs: number; failures: number }[]
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
        durationTailRatio: ratio,
        p50DurationMs: p50,
        p99DurationMs: p99,
      } satisfies FlakyTask
    })
    .filter(
      (r) => r.failureRate > 0 || (r.durationTailRatio !== undefined && r.durationTailRatio > 2),
    )
    .sort((a, b) => {
      // Rank by a composite score: failure rate dominates, tail ratio breaks ties.
      const sa = a.failureRate * 10 + (a.durationTailRatio ?? 1)
      const sb = b.failureRate * 10 + (b.durationTailRatio ?? 1)
      return sb - sa
    })
    .slice(0, clampInt(limit, 1, 200))
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
       WHERE run_id IS NOT NULL
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
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const bucketMs = 24 * 60 * 60 * 1000
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
