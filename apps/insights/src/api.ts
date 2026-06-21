// Typed read-only queries against the local `cache.db`. The SPA never
// writes — DuckDB is in-browser, the SQLite is fetched once and queried
// from there.

import { query } from './duckdb.ts'

export interface RunRow {
  run_id: string
  project: string
  task: string
  status: string
  exit_code: number
  duration_ms: number
  started_at: number
  ended_at: number
  cache_hit: number | null
  cpu_ms: number | null
  peak_rss_bytes: number | null
  wallclock_start_ns: number | null
  wallclock_end_ns: number | null
}

export interface RunSummary {
  run_id: string
  started_at: number
  ended_at: number
  total: number
  succeeded: number
  failed: number
  cache_hits: number
  duration_ms: number
}

export interface CacheStats {
  entries: number
  total_bytes: number
  hit_rate_24h: number
  runs_24h: number
}

export async function listRuns(limit = 50): Promise<RunSummary[]> {
  return await query<RunSummary>(`
    SELECT
      run_id,
      MIN(started_at) AS started_at,
      MAX(ended_at)   AS ended_at,
      COUNT(*)        AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
      SUM(COALESCE(cache_hit, 0))                          AS cache_hits,
      MAX(ended_at) - MIN(started_at)                      AS duration_ms
    FROM cachedb.runs
    WHERE run_id IS NOT NULL
    GROUP BY run_id
    ORDER BY started_at DESC
    LIMIT ${limit}
  `)
}

export async function getRun(runId: string): Promise<{
  runId: string
  tasks: RunRow[]
}> {
  const safe = runId.replaceAll("'", "''")
  const tasks = await query<RunRow>(`
    SELECT run_id, project, task, status, exit_code, duration_ms,
           started_at, ended_at, cache_hit,
           cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns
    FROM cachedb.runs
    WHERE run_id = '${safe}'
    ORDER BY started_at ASC
  `)
  return { runId, tasks }
}

export async function getCacheStats(): Promise<CacheStats> {
  const rows = await query<CacheStats>(`
    WITH e AS (
      SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes), 0) AS total_bytes
      FROM cachedb.entries
    ),
    r AS (
      SELECT
        COUNT(*) AS runs_24h,
        AVG(COALESCE(cache_hit, 0)::DOUBLE) AS hit_rate_24h
      FROM cachedb.runs
      WHERE started_at >= (epoch_ms(current_timestamp) - 86400000)
    )
    SELECT e.entries, e.total_bytes, r.hit_rate_24h, r.runs_24h FROM e, r
  `)
  return rows[0] ?? { entries: 0, total_bytes: 0, hit_rate_24h: 0, runs_24h: 0 }
}
