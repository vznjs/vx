// HistoryTable + HistoryProvider — historical run data the `schedule`
// plugin (`@vzn/vx-schedule-history`, and its `vx history` verb) and
// `--dry`'s time prediction read.
//
// The data has been in cache.db.runs since schema v11; what's new is
// surfacing it. One SQL statement per call pulls the last N executed rows
// per (project, task) pair out of a rowid-bounded slice of the table; the
// result becomes a read-only snapshot for the run's lifetime. Loaded once
// by the `schedule` stage (or `--dry`); never mutated mid-run.
//
// One provider ships, `LocalHistoryProvider`, reading cache.db directly
// (zero-config); the interface is the seam a plugin fills for any other.

import type { Database } from 'bun:sqlite'
import { branchSource, EXECUTED_RUNS_SQL } from '../cache/index.js'
import { splitTaskId } from '../util/index.js'
import { failureModeOf, mixedOutcomeKeysSql } from './failure-mode.js'
import type { FailureMode } from './failure-mode.js'
import { isPassStatus, TASK_STATUSES } from './telemetry.js'

const DEFAULT_RECENT = 50

/** A task's forecast is the median of this many of its newest timings. */
const FORECAST_RUNS = 5

// A hit is recorded as `cache-hit` / `cache-hit-remote` and replays a
// success; the list is derived so a new status cannot miss it.
/** The pass set as SQL, `(…)`: one definition, `isPassStatus`. */
export const PASS_STATUSES = `(${TASK_STATUSES.filter(isPassStatus)
  .map((s) => `'${s}'`)
  .join(', ')})`

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

/** What a scheduler learns from a task's history: its p50 and its resource maxima. */
export type TaskResources = Pick<
  TaskHistory,
  'p50DurationMs' | 'maxPeakRssBytes' | 'maxCpuParallelism'
>

export interface HistoryProvider {
  loadFor(taskIds: readonly string[]): Promise<HistoryTable>
  /**
   * Only `p50DurationMs` of each task `loadFor` would answer, for a reader
   * that needs nothing else (`--dry`'s prediction). Optional: without it
   * the reader takes them from `loadFor`.
   */
  p50sFor?(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
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
    readonly recent: number = DEFAULT_RECENT,
    /** The run's branch (`currentBranch`); undefined: a forecast reads every branch's timings. */
    private readonly branch?: string | null,
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
    if (taskIds.length === 0) return new Map()
    return this.load(new Set(taskIds))
  }

  /** Every task the window holds, as `loadFor` answers each (`vx last --stats`). */
  async loadAll(): Promise<HistoryTable> {
    return this.load(null)
  }

  private load(wanted: ReadonlySet<string> | null): HistoryTable {
    const out = new Map<string, TaskHistory>()
    const floor = this.floor()

    // `skipped` rows are excluded: a skip is a task the run never executed,
    // so it belongs in no success/hit RATE and no duration. Percentiles are
    // over the executed-success rows of the slice — work the runner actually
    // did — while the rates count every executed row.
    const sql = `
      SELECT
        r.project,
        r.task,
        COUNT(*) AS total,
        SUM(CASE WHEN r.status IN ${PASS_STATUSES} THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN r.cache_hit = 1 THEN 1 ELSE 0 END) AS hits,
        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN r.attempts > 1 THEN 1 ELSE 0 END) AS retried,
        GROUP_CONCAT(CASE WHEN (r.cache_hit IS NULL OR r.cache_hit = 0) AND r.status = 'success'
                          THEN r.duration_ms END) AS ds,
        MAX(CASE WHEN (r.cache_hit IS NULL OR r.cache_hit = 0) AND r.status = 'success'
                 THEN r.peak_rss_bytes
                 WHEN r.cache_hit = 1 THEN e.peak_rss_bytes END) AS rss,
        MAX(CASE WHEN (r.cache_hit IS NULL OR r.cache_hit = 0) AND r.status = 'success'
                      AND r.cpu_ms IS NOT NULL AND r.duration_ms > 0
                 THEN r.cpu_ms * 1.0 / r.duration_ms
                 WHEN r.cache_hit = 1 AND e.cpu_ms IS NOT NULL AND e.duration_ms > 0
                 THEN e.cpu_ms * 1.0 / e.duration_ms END) AS cpu
      FROM runs r
      -- A hit executed nothing here, but its entry carries what the
      -- PRODUCING execution used (the artifact's sidecar, indexed at save
      -- and ingest alike), so a task this machine has only ever restored
      -- — a fresh runner behind a remote cache — still has a number. The
      -- join is by primary key and only for hit rows; an entry pruned
      -- since contributes nothing.
      LEFT JOIN entries e ON r.cache_hit = 1 AND e.hash = r.hash
      WHERE r.id >= ? AND ${EXECUTED_RUNS_SQL}
      GROUP BY r.project, r.task
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
    const rows = (this.db.query(sql).all(floor) as Row[]).filter(
      (r) => wanted === null || wanted.has(`${r.project}#${r.task}`),
    )

    // The flakiness signal needs per-key outcomes, which the aggregate above
    // folded away — one more pass over the slice, only for the pairs whose
    // verdict actually depends on it (failed, and no retry already proving
    // nondeterminism); a green history never pays for it.
    const p50s = this.forecasts(new Set(rows.map((r) => `${r.project}#${r.task}`)))
    const mixed = this.mixedOutcomeKeys(
      floor,
      rows.filter((r) => r.failures > 0 && r.retried === 0),
    )

    for (const row of rows) {
      const key = `${row.project}#${row.task}`
      const total = row.total
      const counts = { total, failures: row.failures, retried: row.retried }
      const durations = row.ds === null ? undefined : row.ds.split(',').map(Number)
      if (durations !== undefined) durations.sort((a, b) => a - b)
      out.set(key, {
        runs: total,
        p50DurationMs: p50s.get(key),
        p99DurationMs: durations ? pickPercentile(durations, 0.99) : undefined,
        successRate: row.successes / total,
        hitRate: row.hits / total,
        failureMode: failureModeOf(counts, () => mixed.get(key) ?? 0),
        ...(row.rss !== null ? { maxPeakRssBytes: row.rss } : {}),
        ...(row.cpu !== null ? { maxCpuParallelism: row.cpu } : {}),
      })
    }
    return out
  }

  /**
   * The forecasts alone. `loadFor`'s rates and resource maxima read every
   * row of the window and join each hit to its entry: 38 ms at 27,000 rows
   * against 4 for the executed successes' durations alone.
   */
  async p50sFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (taskIds.length === 0) return new Map()
    return this.forecasts(new Set(taskIds))
  }

  /**
   * Whether the last forecast read found some task with no timing on this
   * branch (on any branch when the provider has none): what a
   * default-branch import is for. Learned by the read itself, so asking
   * costs nothing (a query per task was 70 ms at 8,002 tasks).
   */
  lackedBranchHistory = false

  /** Whether timings of default-branch commit `sha` were imported. */
  hasImported(sha: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM task_durations WHERE source = 'remote' AND sha = ? LIMIT 1`)
        .get(sha) !== null
    )
  }

  /**
   * Keep default-branch commit `sha`'s timings (task id → ms) as forecast
   * rows: one per task, so a repeat import, by this worktree or another
   * at once, adds nothing.
   */
  importTimings(sha: string, timings: ReadonlyMap<string, number>): void {
    const insert = this.db.query(
      `INSERT OR IGNORE INTO task_durations(project, task, source, sha, duration_ms, recorded_at)
       VALUES (?, ?, 'remote', ?, ?, ?)`,
    )
    const now = Date.now()
    this.db
      .transaction(() => {
        for (const [id, ms] of timings) {
          const [project, task] = splitTaskId(id)
          insert.run(project, task, sha, Math.round(ms), now)
        }
      })
      .immediate()
  }

  /**
   * Each task's duration forecast (owner, 2026-10-14): the median of its
   * last `FORECAST_RUNS` timings on this branch, else the default branch's
   * newest imported timing (`importTimings`), else the median on any
   * branch, else none. The timings are the shared store's `task_durations`, so every
   * worktree of the repo reads them and a new one forecasts on its first
   * run. A point read per task on `(project, task, source, id)`: exact
   * however old the rows, where the runs window holds only the newest
   * invocations.
   */
  private forecasts(wanted: ReadonlySet<string>): Map<string, number> {
    const out = new Map<string, number>()
    this.lackedBranchHistory = false
    if (wanted.size === 0) return out
    // Tiers, first answer wins.
    type Tier = (project: string, task: string) => Array<{ ms: number }>
    const tiers: Tier[] = []
    const newest = (where: string) =>
      this.db.query(
        `SELECT duration_ms AS ms FROM task_durations WHERE project = ? AND task = ? AND ${where}
         ORDER BY id DESC LIMIT ${FORECAST_RUNS}`,
      )
    if (this.branch !== undefined) {
      const source = branchSource(this.branch)
      const q = newest('source = ?')
      tiers.push((p, t) => q.all(p, t, source) as Array<{ ms: number }>)
    }
    // One probe on the partial index first: a store with no import costs
    // no query per task.
    if (
      this.db.query(`SELECT 1 FROM task_durations WHERE source = 'remote' LIMIT 1`).get() !== null
    ) {
      const remote = this.db.query(
        `SELECT duration_ms AS ms FROM task_durations WHERE project = ? AND task = ? AND source = 'remote'
         ORDER BY id DESC LIMIT 1`,
      )
      tiers.push((p, t) => remote.all(p, t) as Array<{ ms: number }>)
    }
    const any = newest(`source LIKE 'branch:%'`)
    tiers.push((p, t) => any.all(p, t) as Array<{ ms: number }>)
    const own = this.branch !== undefined ? tiers[0] : tiers.at(-1)
    let lacked = false
    for (const id of wanted) {
      const [project, task] = splitTaskId(id)
      let answered: Tier | undefined
      for (const tier of tiers) {
        const rows = tier(project, task)
        if (rows.length === 0) continue
        const durations = rows.map((r) => r.ms).sort((x, y) => x - y)
        out.set(id, pickPercentile(durations, 0.5))
        answered = tier
        break
      }
      if (answered !== own) lacked = true
    }
    this.lackedBranchHistory = lacked
    return out
  }

  /**
   * `loadFor`'s p50 and resource maxima over the same window, without its
   * rates. The rates group every row of the window and join each hit to
   * its entry: 407 ms at 168,000 rows (8,002 tasks, 21 runs), most of a
   * nothing-changed run's schedule stage. Here the executed successes are
   * grouped alone, and the hits only as distinct keys, each joined to its
   * entry once: 148 ms on the same table, the same numbers.
   */
  async resourcesFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, TaskResources>> {
    const out = new Map<string, TaskResources>()
    if (taskIds.length === 0) return out
    const floor = this.floor()
    const wanted = new Set(taskIds)
    type Executed = {
      project: string
      task: string
      rss: number | null
      cpu: number | null
    }
    const executed = this.db
      .query(
        `SELECT project, task, MAX(peak_rss_bytes) AS rss,
           MAX(CASE WHEN cpu_ms IS NOT NULL AND duration_ms > 0
                    THEN cpu_ms * 1.0 / duration_ms END) AS cpu
         FROM runs
         WHERE id >= ? AND status = 'success' AND (cache_hit IS NULL OR cache_hit = 0)
         GROUP BY project, task`,
      )
      .all(floor) as Executed[]
    const p50s = this.forecasts(wanted)
    for (const row of executed) {
      const key = `${row.project}#${row.task}`
      if (!wanted.has(key)) continue
      out.set(key, {
        p50DurationMs: p50s.get(key),
        ...(row.rss !== null ? { maxPeakRssBytes: row.rss } : {}),
        ...(row.cpu !== null ? { maxCpuParallelism: row.cpu } : {}),
      })
    }
    type Hit = { project: string; task: string; rss: number | null; cpu: number | null }
    const hits = this.db
      .query(
        `SELECT h.project, h.task, MAX(e.peak_rss_bytes) AS rss,
           MAX(CASE WHEN e.cpu_ms IS NOT NULL AND e.duration_ms > 0
                    THEN e.cpu_ms * 1.0 / e.duration_ms END) AS cpu
         FROM (SELECT DISTINCT project, task, hash FROM runs WHERE id >= ? AND cache_hit = 1) h
         JOIN entries e ON e.hash = h.hash
         GROUP BY h.project, h.task`,
      )
      .all(floor) as Hit[]
    for (const row of hits) {
      const key = `${row.project}#${row.task}`
      if (!wanted.has(key) || (row.rss === null && row.cpu === null)) continue
      const had = out.get(key)
      const rss = Math.max(had?.maxPeakRssBytes ?? -Infinity, row.rss ?? -Infinity)
      const cpu = Math.max(had?.maxCpuParallelism ?? -Infinity, row.cpu ?? -Infinity)
      out.set(key, {
        p50DurationMs: p50s.get(key),
        ...(rss !== -Infinity ? { maxPeakRssBytes: rss } : {}),
        ...(cpu !== -Infinity ? { maxCpuParallelism: cpu } : {}),
      })
    }
    // A forecast reads past the window: a task with none in it still has one.
    for (const [key, p50] of p50s) if (!out.has(key)) out.set(key, { p50DurationMs: p50 })
    return out
  }

  /** The first `runs` id of the newest `recent` invocations (see `loadFor`). */
  private floor(): number {
    const row = this.db
      .query(
        `SELECT MIN(id) AS id FROM runs WHERE run_id =
           (SELECT run_id FROM invocations ORDER BY rowid DESC LIMIT 1 OFFSET ?)`,
      )
      .get(this.recent - 1) as { id: number | null }
    // Fewer invocations than the window (or none): the whole table is the window.
    return row.id ?? 0
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

// A group holds at least one row, so every SUM is a number and `sorted` is
// never empty; q < 1 keeps the index inside it.
function pickPercentile(sorted: number[], q: number): number {
  return sorted[Math.floor(q * sorted.length)]!
}
