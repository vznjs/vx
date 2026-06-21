// HistoryTable + HistoryProvider — historical run data the scheduler
// uses for predictive priority and `vx info --history` surfaces.
//
// The data has been in cache.db.runs since schema v11; what's new is
// surfacing it. A single SQL CTE per run pulls the last N rows per
// (project, task) pair; the result becomes a read-only snapshot for
// the run's lifetime. Loaded once at prepareRun; never mutated mid-run.
//
// Two providers:
//   LocalHistoryProvider  — reads cache.db directly (zero-config).
//   CloudHistoryProvider  — would call a vx-cloud RPC; deferred to
//                            when the cloud RPC actually exists.

import type { Database } from 'bun:sqlite'

const DEFAULT_RECENT = 50

/** Per (project#task) — last RECENT runs collapsed into a summary. */
export interface TaskHistory {
  /** Total runs in the recent window. */
  runs: number
  /** Wall-clock p50 (ms). Cache-hit rows excluded so this reflects work actually done. */
  p50DurationMs: number | undefined
  /** Wall-clock p99 (ms). Same exclusion. */
  p99DurationMs: number | undefined
  /** Success rate over the recent window ([0, 1]). */
  successRate: number
  /** Cache hit rate over the recent window ([0, 1]). */
  hitRate: number
  /** Failure mode classification. */
  failureMode: 'stable' | 'flaky-recoverable' | 'flaky-fatal'
}

/** Map keyed by `project#task`. */
export type HistoryTable = ReadonlyMap<string, TaskHistory>

export interface HistoryProvider {
  loadFor(taskIds: readonly string[]): Promise<HistoryTable>
}

/** A no-op provider — every lookup returns an empty table. */
export class EmptyHistoryProvider implements HistoryProvider {
  async loadFor(_taskIds: readonly string[]): Promise<HistoryTable> {
    return new Map()
  }
}

/** Reads from the orchestrator's local SQLite cache.db. */
export class LocalHistoryProvider implements HistoryProvider {
  constructor(
    private readonly db: Database,
    private readonly recent: number = DEFAULT_RECENT,
  ) {}

  async loadFor(taskIds: readonly string[]): Promise<HistoryTable> {
    const out = new Map<string, TaskHistory>()
    if (taskIds.length === 0) return out

    // One CTE per call: rank rows per (project, task) descending by
    // started_at, keep the top `recent`, aggregate. Cache-hit rows
    // (cache_hit = 1) are excluded from the duration percentiles so
    // p50/p99 reflect work the runner actually did. successRate +
    // hitRate are computed over ALL recent rows.
    const sql = `
      WITH recent AS (
        SELECT
          project,
          task,
          status,
          duration_ms,
          cache_hit,
          ROW_NUMBER() OVER (PARTITION BY project, task ORDER BY started_at DESC) AS rn
        FROM runs
        WHERE (project || '#' || task) IN (${taskIds.map(() => '?').join(',')})
      )
      SELECT
        project,
        task,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS hits,
        SUM(CASE WHEN cache_hit IS NULL OR cache_hit = 0 THEN 1 ELSE 0 END) AS executed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
      FROM recent
      WHERE rn <= ${this.recent}
      GROUP BY project, task
    `

    type Row = {
      project: string
      task: string
      total: number
      successes: number
      hits: number
      executed: number
      failures: number
    }
    const rows = this.db.query(sql).all(...(taskIds as string[])) as Row[]

    for (const row of rows) {
      const key = `${row.project}#${row.task}`
      const total = row.total || 0
      const failures = row.failures || 0
      const failureMode: TaskHistory['failureMode'] =
        failures === 0 ? 'stable' : failures < total / 5 ? 'flaky-recoverable' : 'flaky-fatal'
      const { p50, p99 } = this.percentilesFor(row.project, row.task)
      out.set(key, {
        runs: total,
        p50DurationMs: p50,
        p99DurationMs: p99,
        successRate: total > 0 ? (row.successes || 0) / total : 0,
        hitRate: total > 0 ? (row.hits || 0) / total : 0,
        failureMode,
      })
    }
    return out
  }

  // Percentiles need a row-wise read; do it in JS rather than try to
  // express the percentile_cont equivalent in SQLite. Tiny rows.
  private percentilesFor(
    project: string,
    task: string,
  ): { p50: number | undefined; p99: number | undefined } {
    const rows = this.db
      .query(
        `SELECT duration_ms FROM runs
         WHERE project = ? AND task = ?
           AND (cache_hit IS NULL OR cache_hit = 0)
           AND status = 'success'
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(project, task, this.recent) as { duration_ms: number }[]
    if (rows.length === 0) return { p50: undefined, p99: undefined }
    const durations = rows.map((r) => r.duration_ms).sort((a, b) => a - b)
    return {
      p50: pickPercentile(durations, 0.5),
      p99: pickPercentile(durations, 0.99),
    }
  }
}

function pickPercentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[idx]!
}
