// HistoryTable + HistoryProvider — historical run data the `schedule`
// plugin (`@vzn/vx-history`, and its `vx history` verb) and
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
import { isMeasure, splitTaskId } from '../util/index.js'
import { failureModeOf, mixedOutcomeKeysSql } from './failure-mode.js'
import type { FailureMode } from './failure-mode.js'
import { isPassStatus, TASK_STATUSES } from '../graph/index.js'

const DEFAULT_RECENT = 50

/** A task's forecast is the median of this many of its newest timings. */
const FORECAST_RUNS = 5

// A hit is recorded as `cache-hit` / `cache-hit-remote` and replays a
// success; the list is derived so a new status cannot miss it.
/** The pass set as SQL, `(…)`: one definition, `isPassStatus`. */
export const PASS_STATUSES = `(${TASK_STATUSES.filter(isPassStatus)
  .map((s) => `'${s}'`)
  .join(', ')})`

/** The share of a machine a task must use to have filled it. */
const SATURATED = 0.9

/**
 * The cores a run of `runs r` kept busy, as need: its CPU over its time,
 * divided by the share of a core its threads got (`cpu_share`, v49). A run
 * on a crowded worker used its fair share only: nine test shards on four
 * cores each used 0.36 of the 1.1 they take alone, and learning 0.36 packed
 * the next run as tight (main c27c238, 2026-10-23). Never past the machine.
 */
const NEED_SQL = `MIN(r.cpu_ms * 1.0 / (r.duration_ms * COALESCE(r.cpu_share, 1)),
        COALESCE(r.placement_cores, r.cpu_ms * 1.0 / (r.duration_ms * COALESCE(r.cpu_share, 1))))`

/** Per (project#task) — last RECENT runs collapsed into a summary. */
export interface TaskHistory {
  /** Total runs in the recent window. */
  runs: number
  /** Wall-clock p50 (ms), a crowded run's as if alone. Cache-hit rows excluded so this reflects work actually done. */
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
   * The CPU parallelism the window's successful executions needed on
   * average: cpu time over wall time over the share of a core it got, so
   * 2.0 means two cores busy for the whole task. An average, not the
   * most: one crowded run's need read 2.84 cores for a build that uses
   * 1.3 to 1.9, booked it a whole 3-core Mac, and the tasks beside it
   * waited 45 s (main b5b83bb). Undefined when no row carried both numbers.
   */
  maxCpuParallelism?: number
  /**
   * The most cores, and the most memory, of a machine an executor ran it
   * on (`ExecuteResult.machine`) that it used all of: 90% of the cores
   * over its whole run, averaged over the window's runs on machines that
   * size, or 90% of the memory in any one. A burst to every core is
   * not one: tasks beside it slow for a moment, and booking a machine for
   * it left CI agents half idle (2026-10-22). A
   * task that filled a machine wanted a bigger one. Set by `resourcesFor`.
   */
  saturatedCores?: number
  saturatedMemoryBytes?: number
}

/** Map keyed by `project#task`. */
export type HistoryTable = ReadonlyMap<string, TaskHistory>

/** What a scheduler learns from a task's history: its p50 and its resource maxima. */
export type TaskResources = Pick<
  TaskHistory,
  | 'p50DurationMs'
  | 'maxPeakRssBytes'
  | 'maxCpuParallelism'
  | 'saturatedCores'
  | 'saturatedMemoryBytes'
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
    /**
     * Each task's definition (`taskDefinitions`): given, a task reads only
     * the rows of it as it is now, and a task not in it reads none. A row
     * of no definition (timings shared before definitions were kept) is
     * read: dropping them left a PR's run with no task measured (#4150).
     */
    private readonly defs?: ReadonlyMap<string, string>,
  ) {}

  /** `r.def` in a SELECT and GROUP BY when rows are matched to definitions. */
  private get byDef(): string {
    return this.defs === undefined ? '' : ', r.def'
  }

  /** Whether a row of `id` under `def` is the task as it is now. */
  private current(id: string, def: string | null | undefined): boolean {
    return this.defs === undefined || def == null || this.defs.get(id) === def
  }

  /** A task id's `[project, task, def?]`, the JSON a statement matches rows by. */
  private keyOf(id: string): string[] {
    const [project, task] = splitTaskId(id)
    if (this.defs === undefined) return [project, task]
    return [project, task, this.defs.get(id) ?? '']
  }

  /** The condition on a `task_durations` row's `def`, against `j.value ->> 2`. */
  private get durationDef(): string {
    return this.defs === undefined ? '' : 'AND (def IS NULL OR def = j.value ->> 2)'
  }

  /**
   * The window is the last `recent` INVOCATIONS, read as one rowid slice.
   *
   * `runs` has no (project, task) index: it cost every run a scattered
   * B-tree write per task (2026-09-09, 1,000 warm hits: the record stage
   * 57–79 ms with it, 14–19 ms without) and bought this reader nothing —
   * ranking every pair's rows newest-first (`ROW_NUMBER` over a partition)
   * sorted the whole table either way, 230 ms at 116k rows. Rows are
   * appended in time order, one contiguous block per invocation, so the
   * rows of the newest `recent` invocations are exactly `id >=` the first
   * row of the newest `recent` headers — a primary-key range, no sort, plain
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
        r.task${this.defs === undefined ? '' : ', r.def AS def'},
        COUNT(*) AS total,
        SUM(CASE WHEN r.status IN ${PASS_STATUSES} THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN r.cache_hit = 1 THEN 1 ELSE 0 END) AS hits,
        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN r.status = 'success' AND r.attempts > 1 THEN 1 ELSE 0 END) AS retried,
        GROUP_CONCAT(CASE WHEN (r.cache_hit IS NULL OR r.cache_hit = 0) AND r.status = 'success'
                          THEN r.duration_ms END) AS ds,
        MAX(CASE WHEN (r.cache_hit IS NULL OR r.cache_hit = 0) AND r.status = 'success'
                 THEN r.peak_rss_bytes
                 WHEN r.cache_hit = 1 THEN e.peak_rss_bytes END) AS rss,
        -- A hit's producer use only where no run here measured it (resourcesFor).
        COALESCE(
          AVG(CASE WHEN (r.cache_hit IS NULL OR r.cache_hit = 0) AND r.status = 'success'
                        AND r.cpu_ms IS NOT NULL AND r.duration_ms > 0
                   THEN ${NEED_SQL} END),
          MAX(CASE WHEN r.cache_hit = 1 AND e.cpu_ms IS NOT NULL AND e.duration_ms > 0
                   THEN e.cpu_ms * 1.0 / e.duration_ms END)) AS cpu
      FROM runs r
      -- A hit executed nothing here, but its entry carries what the
      -- PRODUCING execution used (the artifact's sidecar, indexed at save
      -- and ingest alike), so a task this machine has only ever restored
      -- — a fresh runner behind a remote cache — still has a number. The
      -- join is by primary key and only for hit rows; an entry pruned
      -- since contributes nothing.
      LEFT JOIN entries e ON r.cache_hit = 1 AND e.hash = r.hash
      WHERE r.id >= ? AND ${EXECUTED_RUNS_SQL}
      GROUP BY r.project, r.task${this.byDef}
    `
    type Row = {
      project: string
      task: string
      def?: string | null
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
    const rows = (this.db.query(sql).all(floor) as Row[]).filter((r) => {
      const id = `${r.project}#${r.task}`
      return (wanted === null || wanted.has(id)) && this.current(id, r.def)
    })

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
   * rows, each with the task's measured need from `needs` when it has one
   * (what `resourcesFor` answers for a task with no run here): one row per
   * task, so a repeat import, by this worktree or another at once, adds
   * nothing.
   */
  importTimings(
    sha: string,
    timings: ReadonlyMap<string, number>,
    needs: ReadonlyMap<string, TaskResources> = new Map(),
    /** Each task's definition when it was timed (`taskDefinition`). */
    defs: ReadonlyMap<string, string> = new Map(),
  ): void {
    const insert = this.db.query(
      `INSERT OR IGNORE INTO task_durations(project, task, source, sha, duration_ms, recorded_at,
         cpu_parallelism, peak_rss_bytes, saturated_cores, saturated_memory_bytes, def)
       VALUES (?, ?, 'remote', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = Date.now()
    this.db
      .transaction(() => {
        for (const [id, ms] of timings) {
          const n = needs.get(id)
          // A plugin's Infinity or negative, kept, made every later forecast
          // NaN or below zero: the row is never written again to correct it.
          if (
            !isMeasure(ms) ||
            (n !== undefined && !Object.values(n).every((v) => v === undefined || isMeasure(v)))
          )
            continue
          const [project, task] = splitTaskId(id)
          insert.run(
            project,
            task,
            sha,
            Math.round(ms),
            now,
            n?.maxCpuParallelism ?? null,
            n?.maxPeakRssBytes ?? null,
            n?.saturatedCores ?? null,
            n?.saturatedMemoryBytes ?? null,
            defs.get(id) ?? null,
          )
        }
      })
      .immediate()
  }

  /**
   * Each task's duration forecast (2026-10-14): the median of its
   * last `FORECAST_RUNS` timings on this branch, else the default branch's
   * newest imported timing (`importTimings`), else the median on any
   * branch, else none. The timings are the shared store's `task_durations`, so every
   * worktree of the repo reads them and a new one forecasts on its first
   * run. One statement per tier, an index probe per task on `(project,
   * task, source, id)` inside it: exact however old the rows, where the
   * runs window holds only the newest invocations.
   */
  private forecasts(wanted: ReadonlySet<string>): Map<string, number> {
    const out = new Map<string, number>()
    this.lackedBranchHistory = false
    if (wanted.size === 0) return out
    // Tiers, first answer wins: a WHERE over `task_durations`, its params,
    // and how many of the newest rows it reads.
    type Tier = { where: string; params: string[]; limit: number }
    const tiers: Tier[] = []
    if (this.branch !== undefined) {
      tiers.push({ where: 'source = ?', params: [branchSource(this.branch)], limit: FORECAST_RUNS })
    }
    // One probe on the partial index first: a store with no import costs
    // no tier.
    if (
      this.db.query(`SELECT 1 FROM task_durations WHERE source = 'remote' LIMIT 1`).get() !== null
    ) {
      tiers.push({ where: `source = 'remote'`, params: [], limit: 1 })
    }
    tiers.push({ where: `source LIKE 'branch:%'`, params: [], limit: FORECAST_RUNS })
    const own = this.branch !== undefined ? tiers[0] : tiers.at(-1)
    let pending = [...wanted]
    let ownAnswered = 0
    for (const tier of tiers) {
      if (pending.length === 0) break
      // One statement per tier over every task it is asked for: an index
      // probe per task inside SQLite, where a query per task from here was
      // 31-40 ms of 2,000 tasks against 5-8.
      const rows = this.db
        .query(
          `SELECT j.key AS i, (SELECT group_concat(ms) FROM (
             SELECT duration_ms AS ms FROM task_durations
             WHERE project = j.value ->> 0 AND task = j.value ->> 1 AND ${tier.where} ${this.durationDef}
             ORDER BY id DESC LIMIT ${tier.limit})) AS ds
           FROM json_each(?) AS j`,
        )
        .all(...tier.params, JSON.stringify(pending.map((id) => this.keyOf(id)))) as {
        i: number
        ds: string | null
      }[]
      const left: string[] = []
      for (const r of rows) {
        const id = pending[r.i]!
        if (r.ds === null) {
          left.push(id)
          continue
        }
        const durations = r.ds
          .split(',')
          .map(Number)
          .sort((x, y) => x - y)
        out.set(id, pickPercentile(durations, 0.5))
        if (tier === own) ownAnswered++
      }
      pending = left
    }
    this.lackedBranchHistory = ownAnswered < wanted.size
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
      def?: string | null
      rss: number | null
      cpu: number | null
    }
    const executed = this.db
      .query(
        `SELECT r.project, r.task${this.byDef}, MAX(r.peak_rss_bytes) AS rss,
           AVG(CASE WHEN r.cpu_ms IS NOT NULL AND r.duration_ms > 0
                    THEN ${NEED_SQL} END) AS cpu
         FROM runs r
         WHERE r.id >= ? AND r.status = 'success' AND (r.cache_hit IS NULL OR r.cache_hit = 0)
         GROUP BY r.project, r.task${this.byDef}`,
      )
      .all(floor) as Executed[]
    const p50s = this.forecasts(wanted)
    for (const row of executed) {
      const key = `${row.project}#${row.task}`
      if (!wanted.has(key) || !this.current(key, row.def)) continue
      out.set(key, {
        p50DurationMs: p50s.get(key),
        ...(row.rss !== null ? { maxPeakRssBytes: row.rss } : {}),
        ...(row.cpu !== null ? { maxCpuParallelism: row.cpu } : {}),
      })
    }
    type Hit = {
      project: string
      task: string
      def?: string | null
      rss: number | null
      cpu: number | null
      ms: number | null
    }
    const hits = this.db
      .query(
        `SELECT r.project, r.task${this.byDef}, MAX(e.peak_rss_bytes) AS rss,
           MAX(CASE WHEN e.cpu_ms IS NOT NULL AND e.duration_ms > 0
                    THEN e.cpu_ms * 1.0 / e.duration_ms END) AS cpu,
           MAX(CASE WHEN e.duration_ms > 0 THEN e.duration_ms END) AS ms
         FROM (SELECT DISTINCT project, task, hash, def FROM runs WHERE id >= ? AND cache_hit = 1) r
         JOIN entries e ON e.hash = r.hash
         GROUP BY r.project, r.task${this.byDef}`,
      )
      .all(floor) as Hit[]
    // A hit's CPU is its producer's use, not need: the entry keeps no
    // share, so a crowded producer's reads low. Only a task with no need
    // from a run here or the default branch's import takes it: main's
    // blob carried each hit shard's crowded use forward, and the next run
    // packed them as tight (main 357d3aa, 2026-10-23).
    const hitCpu = new Map<string, number>()
    for (const row of hits) {
      const key = `${row.project}#${row.task}`
      if (
        !wanted.has(key) ||
        !this.current(key, row.def) ||
        (row.rss === null && row.cpu === null && row.ms === null)
      )
        continue
      if (row.cpu !== null) hitCpu.set(key, row.cpu)
      const had = out.get(key)
      const rss = Math.max(had?.maxPeakRssBytes ?? -Infinity, row.rss ?? -Infinity)
      out.set(key, {
        ...had,
        // A task this store only restored is timed by its producer: one a
        // branch's run made, main restored and never timed, and every
        // later run planned it at a guess (PR #4339's docs chain: 90 s
        // guessed, 45 s run, 2026-10-24).
        p50DurationMs: p50s.get(key) ?? row.ms ?? undefined,
        ...(rss !== -Infinity ? { maxPeakRssBytes: rss } : {}),
      })
    }
    // A failure counts: a task killed for memory filled its machine too.
    type Saturated = {
      project: string
      task: string
      def?: string | null
      cores: number | null
      memory: number | null
    }
    const saturated = this.db
      .query(
        `SELECT r.project, r.task${this.byDef},
           MAX(CASE WHEN r.fill >= ${SATURATED} THEN r.cores END) AS cores,
           MAX(r.memory) AS memory
         FROM (SELECT r.project, r.task${this.byDef}, r.placement_cores AS cores,
                 AVG(${NEED_SQL} / r.placement_cores) AS fill,
                 MAX(CASE WHEN r.peak_rss_bytes >= ${SATURATED} * r.placement_memory
                          THEN r.placement_memory END) AS memory
               FROM runs r
               WHERE r.id >= ? AND r.placement_cores IS NOT NULL AND r.duration_ms > 0
                 AND r.status IN ('success', 'failed') AND (r.cache_hit IS NULL OR r.cache_hit = 0)
               GROUP BY r.project, r.task${this.byDef}, r.placement_cores) r
         GROUP BY r.project, r.task${this.byDef}`,
      )
      .all(floor) as Saturated[]
    for (const row of saturated) {
      const key = `${row.project}#${row.task}`
      if (
        !wanted.has(key) ||
        !this.current(key, row.def) ||
        (row.cores === null && row.memory === null)
      )
        continue
      out.set(key, {
        ...(out.get(key) ?? { p50DurationMs: p50s.get(key) }),
        ...(row.cores !== null ? { saturatedCores: row.cores } : {}),
        ...(row.memory !== null ? { saturatedMemoryBytes: row.memory } : {}),
      })
    }
    // A forecast reads past the window: a task with none in it still has one.
    for (const [key, p50] of p50s) if (!out.has(key)) out.set(key, { p50DurationMs: p50 })
    this.remoteNeeds(wanted, out)
    for (const [key, cpu] of hitCpu) {
      const had = out.get(key)!
      if (had.maxCpuParallelism === undefined) out.set(key, { ...had, maxCpuParallelism: cpu })
    }
    return out
  }

  /**
   * A task never measured here takes its need from the newest imported
   * row that has one (`importTimings`): a fresh CI machine packs by what
   * the default branch measured. One probe skips a store with none.
   */
  private remoteNeeds(wanted: ReadonlySet<string>, out: Map<string, TaskResources>): void {
    const pending = [...wanted].filter((id) => out.get(id)?.maxCpuParallelism === undefined)
    if (pending.length === 0) return
    if (
      this.db
        .query(
          `SELECT 1 FROM task_durations WHERE source = 'remote' AND cpu_parallelism IS NOT NULL LIMIT 1`,
        )
        .get() === null
    )
      return
    const rows = this.db
      .query(
        `SELECT j.key AS i, d.cpu_parallelism AS cpu, d.peak_rss_bytes AS rss,
           d.saturated_cores AS sc, d.saturated_memory_bytes AS sm
         FROM json_each(?) AS j
         JOIN task_durations d ON d.id = (
           SELECT id FROM task_durations
           WHERE project = j.value ->> 0 AND task = j.value ->> 1 AND source = 'remote'
             AND cpu_parallelism IS NOT NULL ${this.durationDef}
           ORDER BY id DESC LIMIT 1)`,
      )
      .all(JSON.stringify(pending.map((id) => this.keyOf(id)))) as {
      i: number
      cpu: number
      rss: number | null
      sc: number | null
      sm: number | null
    }[]
    for (const r of rows) {
      const id = pending[r.i]!
      const had = out.get(id)
      out.set(id, {
        p50DurationMs: had?.p50DurationMs,
        maxCpuParallelism: r.cpu,
        ...(r.rss !== null ? { maxPeakRssBytes: r.rss } : {}),
        // A saturation measured here wins.
        ...(r.sc !== null ? { saturatedCores: r.sc } : {}),
        ...(r.sm !== null ? { saturatedMemoryBytes: r.sm } : {}),
        ...(had?.saturatedCores !== undefined ? { saturatedCores: had.saturatedCores } : {}),
        ...(had?.saturatedMemoryBytes !== undefined
          ? { saturatedMemoryBytes: had.saturatedMemoryBytes }
          : {}),
      })
    }
  }

  /** The first `runs` id of the newest `recent` invocations (see `loadFor`). */
  private floor(): number {
    // The first row of each invocation in the window, an index probe each:
    // a run of only a group records a header and no row (X-50), and at the
    // oldest slot it gave no first row, so the window read the whole table.
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n, MIN(first) AS id,
           (SELECT COALESCE(MAX(id), 0) + 1 FROM runs) AS past
         FROM (SELECT (SELECT MIN(id) FROM runs WHERE run_id = i.run_id) AS first
               FROM (SELECT run_id FROM invocations ORDER BY rowid DESC LIMIT ?) i)`,
      )
      .get(this.recent) as { n: number; id: number | null; past: number }
    // Fewer invocations than the window (or none): the whole table is the window.
    if (row.n < this.recent) return 0
    // A window of only empty invocations holds no row.
    return row.id ?? row.past
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
