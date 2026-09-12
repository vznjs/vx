// HistoryTable + HistoryProvider — historical run data the scheduler
// uses for predictive priority and `vx info --history` surfaces.
//
// The data has been in cache.db.runs since schema v11; what's new is
// surfacing it. One SQL statement per call pulls the last N executed rows
// per (project, task) pair out of a rowid-bounded slice of the table; the
// result becomes a read-only snapshot for the run's lifetime. Loaded once
// by the `schedule` stage (or `--dry`); never mutated mid-run.
//
// Two providers:
//   LocalHistoryProvider  — reads cache.db directly (zero-config).
//   RemoteHistoryProvider — would call a service RPC; deferred to
//                            when such an RPC actually exists.

import type { Database } from 'bun:sqlite'
import { EXECUTED_RUNS_SQL } from '../cache/index.js'
import { failureModeOf, mixedOutcomeKeysSql } from './failure-mode.js'
import type { FailureMode } from './failure-mode.js'

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
  /** Failure mode classification over the same window (`failureModeOf`,
   *  the one rule `vx why`'s all-time query also applies). */
  failureMode: FailureMode
  /**
   * Largest peak RSS (bytes) any successful execution in the window
   * reported; undefined when none did (hits report nothing, and a
   * platform may not expose rusage). The floor a memory reservation
   * learned from history packs on.
   */
  maxPeakRssBytes?: number
  /**
   * The most CPU parallelism any successful execution in the window
   * showed: cpu time over wall time, so 2.0 means two cores busy for the
   * whole task. Undefined when no row carried both numbers.
   */
  maxCpuParallelism?: number
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

  /**
   * The window is the last `recent` INVOCATIONS, read as one rowid slice.
   *
   * `runs` has no (project, task) index: it cost every run a scattered
   * B-tree write per task (2026-09-09, 1,000 warm hits: the record stage
   * 57–79 ms with it, 14–19 ms without) and bought this reader nothing —
   * ranking every pair's rows newest-first (`ROW_NUMBER` over a partition)
   * sorted the whole table either way, 230 ms at 116k rows. Rows are
   * appended in time order, one contiguous block per invocation, so the
   * rows of the newest `recent` invocations are exactly `id >= MIN(id)` of
   * the `recent`-th newest header — a primary-key range, no sort, plain
   * aggregates, and at most one row per pair per invocation, so "the last
   * `recent` invocations" IS the last `recent` runs for a pair that runs
   * every time and whatever fewer it has for one that runs less often. A
   * hint for ordering and prediction, not a ledger; `vx why` / `vx last`
   * read by `run_id` and stay exact.
   */
  async loadFor(taskIds: readonly string[]): Promise<HistoryTable> {
    const out = new Map<string, TaskHistory>()
    if (taskIds.length === 0) return out

    const floorRow = this.db
      .query(
        `SELECT MIN(id) AS id FROM runs WHERE run_id =
           (SELECT run_id FROM invocations ORDER BY started_at DESC LIMIT 1 OFFSET ?)`,
      )
      .get(this.recent - 1) as { id: number | null }
    // Fewer invocations than the window (or none): the whole table is the window.
    const floor = floorRow.id ?? 0

    // `skipped` rows are excluded: a skip is a task the run never executed,
    // so it belongs in no success/hit RATE and no duration. Percentiles are
    // over the executed-success rows of the slice — work the runner actually
    // did — while the rates count every executed row.
    const sql = `
      SELECT
        project,
        task,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS hits,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS retried,
        GROUP_CONCAT(CASE WHEN (cache_hit IS NULL OR cache_hit = 0) AND status = 'success'
                          THEN duration_ms END) AS ds,
        MAX(CASE WHEN (cache_hit IS NULL OR cache_hit = 0) AND status = 'success'
                 THEN peak_rss_bytes END) AS rss,
        MAX(CASE WHEN (cache_hit IS NULL OR cache_hit = 0) AND status = 'success'
                      AND cpu_ms IS NOT NULL AND duration_ms > 0
                 THEN cpu_ms * 1.0 / duration_ms END) AS cpu
      FROM runs
      WHERE id >= ? AND ${EXECUTED_RUNS_SQL}
      GROUP BY project, task
    `
    type Row = {
      project: string
      task: string
      total: number
      successes: number
      hits: number
      failures: number
      retried: number
      ds: string | null
      rss: number | null
      cpu: number | null
    }
    // Every pair in the slice is grouped (the slice is bounded, so this is
    // cheap) and the asked-for ones are picked out here — a per-row IN-list
    // probe in SQL cost more than the grouping it would have saved.
    const wanted = new Set(taskIds)
    const rows = (this.db.query(sql).all(floor) as Row[]).filter((r) =>
      wanted.has(`${r.project}#${r.task}`),
    )

    // The flakiness signal needs per-key outcomes, which the aggregate above
    // folded away — one more pass over the slice, only for the pairs whose
    // verdict actually depends on it (failed, and no retry already proving
    // nondeterminism); a green history never pays for it.
    const mixed = this.mixedOutcomeKeys(
      floor,
      rows.filter((r) => (r.failures || 0) > 0 && (r.retried || 0) === 0),
    )

    for (const row of rows) {
      const key = `${row.project}#${row.task}`
      const total = row.total || 0
      const counts = { total, failures: row.failures || 0, retried: row.retried || 0 }
      const durations = row.ds === null ? undefined : row.ds.split(',').map(Number)
      if (durations !== undefined) durations.sort((a, b) => a - b)
      out.set(key, {
        runs: total,
        p50DurationMs: durations ? pickPercentile(durations, 0.5) : undefined,
        p99DurationMs: durations ? pickPercentile(durations, 0.99) : undefined,
        successRate: total > 0 ? (row.successes || 0) / total : 0,
        hitRate: total > 0 ? (row.hits || 0) / total : 0,
        failureMode: failureModeOf(counts, () => mixed.get(key) ?? 0),
        ...(row.rss !== null ? { maxPeakRssBytes: row.rss } : {}),
        ...(row.cpu !== null ? { maxCpuParallelism: row.cpu } : {}),
      })
    }
    return out
  }

  /** Mixed-outcome key count per `project#task`, over the slice, for `pairs` only. */
  private mixedOutcomeKeys(
    floor: number,
    pairs: readonly { project: string; task: string }[],
  ): Map<string, number> {
    const out = new Map<string, number>()
    if (pairs.length === 0) return out
    const placeholders = pairs.map(() => '(?,?)').join(',')
    const rows = this.db
      .query(
        `SELECT project, task, COUNT(*) AS n FROM (${mixedOutcomeKeysSql(
          'runs',
          ` AND id >= ? AND (project, task) IN (VALUES ${placeholders})`,
        )}) GROUP BY project, task`,
      )
      .all(floor, ...pairs.flatMap((p) => [p.project, p.task])) as {
      project: string
      task: string
      n: number
    }[]
    for (const r of rows) out.set(`${r.project}#${r.task}`, r.n)
    return out
  }
}

function pickPercentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[idx]!
}
