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
  const limit = clampInt(args.limit ?? 100, 1, 500)
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
 * Group recent runs by `runId` — what the SPA's overview page wants
 * (one row per `vx run` invocation, not per task).
 */
export interface InvocationRow {
  runId: string
  startedAt: number
  endedAt: number
  taskCount: number
  failedCount: number
  hitCount: number
  totalDurationMs: number
}

export function listInvocations(db: Database, limit = 50): InvocationRow[] {
  return db
    .query(
      `SELECT
         run_id AS runId,
         MIN(started_at) AS startedAt,
         MAX(ended_at) AS endedAt,
         COUNT(*) AS taskCount,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
         SUM(CASE WHEN cache_hit = 1 OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END) AS hitCount,
         SUM(duration_ms) AS totalDurationMs
       FROM runs
       WHERE run_id IS NOT NULL
       GROUP BY run_id
       ORDER BY MAX(started_at) DESC
       LIMIT ?`,
    )
    .all(clampInt(limit, 1, 500)) as InvocationRow[]
}

export interface RunDetail {
  runId: string
  startedAt: number
  endedAt: number
  tasks: RunSummaryRow[]
}

export function getRun(db: Database, runId: string): RunDetail | null {
  const tasks = listRuns(db, { runId, limit: 500 })
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
}

export function getCacheStatsSql(db: Database): CacheStatsResult {
  const aggregate = db
    .query('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM entries')
    .get() as { n: number; bytes: number }
  const since = Date.now() - 24 * 60 * 60 * 1000
  const runs = db
    .query(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'cache-hit' OR status = 'cache-hit-remote' THEN 1 ELSE 0 END), 0) AS hits FROM runs WHERE started_at >= ?",
    )
    .get(since) as { total: number; hits: number }
  return {
    entryCount: aggregate.n,
    totalBytes: aggregate.bytes,
    runCountLast24h: runs.total,
    hitCountLast24h: runs.hits,
    hitRate24h: runs.total > 0 ? runs.hits / runs.total : 0,
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
