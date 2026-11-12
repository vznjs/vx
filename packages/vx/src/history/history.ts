// HistoryTable and HistoryProvider: run history the `schedule` plugin
// (`@vzn/vx-history`) and `--dry`'s prediction read. One SQL statement per call
// pulls the last N executed rows per (project, task) from a rowid-bounded slice
// of `runs`; the result is a read-only snapshot for the run, loaded once.
//
// `LocalHistoryProvider` reads cache.db directly; the interface is the seam for
// any other.

import type { Database } from 'bun:sqlite'
import { branchSource } from './run-history.js'
import { type Cache, indexDb } from '../cache/index.js'
import { EXECUTED_RUNS_SQL } from '../index-db/index.js'
import { isMeasure, splitTaskId } from '../util/index.js'
import { failureModeOf, mixedOutcomeKeysSql, type FailureMode } from './failure-mode.js'
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
 * The cores a run kept busy, as need: CPU over time, divided by the share of a
 * core its threads got (`cpu_share`). On a crowded worker a task used only its
 * fair share (nine shards on four cores used 0.36 of the 1.1 each takes alone),
 * and learning that packed the next run as tight. Never past the machine.
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
   * The largest peak RSS of any successful execution in the window; undefined
   * when none reported (hits never do). The floor a learned memory reservation
   * packs on.
   */
  maxPeakRssBytes?: number
  /**
   * The average CPU parallelism the window's successful executions needed: CPU
   * over wall over core share (2.0 is two busy cores). An average, not the max:
   * one crowded run read 2.84 cores for a 1.3-1.9 build and booked a whole
   * machine. Undefined when no row has both.
   */
  maxCpuParallelism?: number
  /**
   * The most cores and memory of a machine an executor ran it on
   * (`ExecuteResult.machine`) that it used all of: 90% of cores over its whole
   * run, averaged over runs on that size, or 90% of memory in any one. A burst
   * is not that: booking a machine for it left CI agents half idle. Set by
   * `resourcesFor`.
   */
  saturatedCores?: number
  saturatedMemoryBytes?: number
  /**
   * A slow run's duration: the slowest of the runs `p50DurationMs` reads, or a
   * history server's. Deadlines need how slow a task gets, which the median
   * hides. Set by `resourcesFor`.
   */
  slowDurationMs?: number
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
  | 'slowDurationMs'
>

export interface HistoryProvider {
  loadFor(taskIds: readonly string[]): Promise<HistoryTable>
  /**
   * Only `p50DurationMs` of each task, for readers needing nothing else
   * (`--dry`). Optional: without it they use `loadFor`.
   */
  p50sFor?(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
}

/** A no-op provider — every lookup returns an empty table. */
export class EmptyHistoryProvider implements HistoryProvider {
  async loadFor(_taskIds: readonly string[]): Promise<HistoryTable> {
    return new Map()
  }
}

/** One local cache's run history, read and written by core (`localHistory`): plain rows out, no handle. */
export interface LocalHistory extends HistoryProvider {
  /** Each task's measured need (`p50DurationMs`, peak cores and memory). */
  resourcesFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, TaskResources>>
  /** Only each task's `p50DurationMs` as `resourcesFor` answers it, read without the rest. */
  durationsFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
  /** Each plugin measure's (`PluginSetupContext.measure`) forecast; ids with none are left out. */
  measuresFor(ids: readonly string[]): ReadonlyMap<string, MeasureForecast>
  /** Whether timings of commit `sha` were imported. */
  hasImported(sha: string): boolean
  /** Keep commit `sha`'s timings (task id → ms) and needs as forecast rows. */
  importTimings(
    sha: string,
    timings: ReadonlyMap<string, number>,
    needs?: ReadonlyMap<string, TaskResources>,
    defs?: ReadonlyMap<string, string>,
  ): void
}

/** A plugin measure as history forecasts it: the median of its newest timings and of their cores. */
export interface MeasureForecast {
  readonly durationMs: number
  readonly cores?: number
}

export interface LocalHistoryOptions {
  /** The newest invocations a read sees (default 50). */
  readonly recent?: number | undefined
  /** The run's branch (`currentBranch`); undefined: a read sees every branch's timings. */
  readonly branch?: string | null | undefined
  /** Each task's definition (`taskDefinitions`): given, a task reads only rows of it as it is now. */
  readonly defs?: ReadonlyMap<string, string> | undefined
}

/**
 * The run history in `cache`'s index. A plugin reads history only through this:
 * core owns every read and write of cache.db.
 */
export function localHistory(cache: Cache, options: LocalHistoryOptions = {}): LocalHistory {
  return new LocalHistoryProvider(indexDb(cache), options.recent, options.branch, options.defs)
}

/** Reads from the orchestrator's local SQLite cache.db. */
export class LocalHistoryProvider implements LocalHistory {
  constructor(
    private readonly db: Database,
    readonly recent: number = DEFAULT_RECENT,
    /** The run's branch (`currentBranch`); undefined: a forecast reads every branch's timings. */
    private readonly branch?: string | null,
    /**
     * Each task's definition (`taskDefinitions`): given, a task reads only rows
     * of its current definition, and a task not in it none. A row with no
     * definition (shared before definitions were kept) is read, or a PR's run
     * had nothing measured.
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
   * The window is the last `recent` invocations, read as one rowid slice.
   * `runs` has no (project, task) index: it cost every run a B-tree write per
   * task (1,000 hits: record stage 57-79 ms against 14-19) and saved nothing
   * here. Rows append in time order, one block per invocation, so the newest
   * `recent` invocations are `id >=` the first row of the newest `recent`
   * headers: a primary-key range, no sort, at most one row per pair per
   * invocation. A hint for ordering and prediction; `vx why` and `vx last` read
   * by `run_id`, exactly.
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

    // `skipped` rows are excluded: never executed, they belong in no rate or
    // duration. Percentiles cover executed successes; rates count every
    // executed row.
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
      FROM main.runs r
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
    // Every pair in the bounded slice is grouped and the asked ones picked
    // here: a per-row IN probe cost more.
    const rows = (this.db.query(sql).all(floor) as Row[]).filter((r) => {
      const id = `${r.project}#${r.task}`
      return (wanted === null || wanted.has(id)) && this.current(id, r.def)
    })

    // Flakiness needs per-key outcomes the aggregate folded away: one more
    // pass, only for pairs whose verdict depends on it (failed, no retry
    // already proving it). A green history never pays.
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
   * The forecasts alone: `loadFor`'s rates and maxima read every row and join
   * each hit to its entry (38 ms at 27,000 rows against 4).
   */
  async p50sFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return this.p50sNow(taskIds)
  }

  /** `p50sFor`, at once: a row drawn now reads it (the rows' `usual`). */
  p50sNow(taskIds: readonly string[]): ReadonlyMap<string, number> {
    if (taskIds.length === 0) return new Map()
    return this.forecasts(new Set(taskIds))
  }

  /**
   * Whether the last forecast read found a task with no timing on this branch
   * (any branch when the provider has none): what a default-branch import is
   * for. Learned by the read, so free to ask.
   */
  lackedBranchHistory = false

  /** Each task's slow duration as the last forecast read found it (`slowDurationMs`). */
  private slows = new Map<string, number>()
  /** A history server's slow durations, as the last `importTimings` of this process carried them. */
  private importedSlows = new Map<string, number>()

  /**
   * Each plugin measure's forecast, tiered like a task's duration: median of
   * its newest `FORECAST_RUNS` rows on this branch, else its newest imported
   * row, else the median anywhere; cores the median of rows that have one. Few
   * rows and no run row, so a probe each.
   */
  measuresFor(ids: readonly string[]): ReadonlyMap<string, MeasureForecast> {
    const out = new Map<string, MeasureForecast>()
    if (ids.length === 0) return out
    const tiers: { where: string; params: string[]; limit: number }[] = []
    if (this.branch !== undefined)
      tiers.push({ where: 'source = ?', params: [branchSource(this.branch)], limit: FORECAST_RUNS })
    tiers.push({ where: `source = 'remote'`, params: [], limit: 1 })
    tiers.push({ where: `source LIKE 'branch:%'`, params: [], limit: FORECAST_RUNS })
    for (const id of ids) {
      const [project, task, def] = this.keyOf(id)
      for (const tier of tiers) {
        const rows = this.db
          .query(
            `SELECT duration_ms AS ms, cpu_parallelism AS cores FROM task_durations
             WHERE project = ? AND task = ? AND ${tier.where}
               ${def === undefined ? '' : 'AND (def IS NULL OR def = ?)'}
             ORDER BY id DESC LIMIT ${tier.limit}`,
          )
          .all(project!, task!, ...tier.params, ...(def === undefined ? [] : [def])) as {
          ms: number
          cores: number | null
        }[]
        if (rows.length === 0) continue
        const median = (xs: number[]): number =>
          pickPercentile(
            xs.sort((x, y) => x - y),
            0.5,
          )
        const cores = rows.flatMap((r) => (r.cores === null ? [] : [r.cores]))
        out.set(id, {
          durationMs: median(rows.map((r) => r.ms)),
          ...(cores.length === 0 ? {} : { cores: median(cores) }),
        })
        break
      }
    }
    return out
  }

  /** Whether timings of default-branch commit `sha` were imported. */
  hasImported(sha: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM task_durations WHERE source = 'remote' AND sha = ? LIMIT 1`)
        .get(sha) !== null
    )
  }

  /**
   * Keep default-branch commit `sha`'s timings as forecast rows, each with the
   * task's measured need from `needs` when present. One row per task, so a
   * repeat import adds nothing.
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
    this.importedSlows = new Map()
    for (const [id, n] of needs)
      if (n.slowDurationMs !== undefined && isMeasure(n.slowDurationMs))
        this.importedSlows.set(id, n.slowDurationMs)
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
   * Each task's forecast: median of its last `FORECAST_RUNS` timings on this
   * branch, else the default branch's newest import, else the median anywhere,
   * else none. From the shared store's `task_durations`, so every worktree
   * reads them and a new one forecasts on its first run. One statement per
   * tier, an index probe per task: exact however old the rows.
   */
  private forecasts(wanted: ReadonlySet<string>): Map<string, number> {
    const out = new Map<string, number>()
    this.lackedBranchHistory = false
    this.slows = new Map()
    if (wanted.size === 0) return out
    // A store that has timed nothing answers no tier: one probe, not one per
    // task (20 ms of 8,002 on a cold run).
    if (this.db.query('SELECT 1 FROM task_durations LIMIT 1').get() === null) {
      this.lackedBranchHistory = true
      return out
    }
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
      // One statement per tier over every asked task: an index probe each
      // inside SQLite (a query per task from here: 31-40 ms of 2,000 against
      // 5-8).
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
        this.slows.set(
          id,
          tier.where === `source = 'remote'`
            ? (this.importedSlows.get(id) ?? durations.at(-1)!)
            : durations.at(-1)!,
        )
        if (tier === own) ownAnswered++
      }
      pending = left
    }
    this.lackedBranchHistory = ownAnswered < wanted.size
    return out
  }

  /**
   * `loadFor`'s p50 and maxima over the same window, without its rates, which
   * group every row and join each hit (407 ms at 168,000 rows, most of a no-op
   * run's schedule stage). Here successes are grouped alone and hits joined
   * once per distinct key: 148 ms, same numbers.
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
         FROM main.runs r
         WHERE r.id >= ? AND r.status = 'success' AND (r.cache_hit IS NULL OR r.cache_hit = 0)
         GROUP BY r.project, r.task${this.byDef}`,
      )
      .all(floor) as Executed[]
    const p50s = this.forecasts(wanted)
    const slows = this.slows
    for (const row of executed) {
      const key = `${row.project}#${row.task}`
      if (!wanted.has(key) || !this.current(key, row.def)) continue
      out.set(key, {
        p50DurationMs: p50s.get(key),
        ...(row.rss !== null ? { maxPeakRssBytes: row.rss } : {}),
        ...(row.cpu !== null ? { maxCpuParallelism: row.cpu } : {}),
      })
    }
    const hits = this.producerRows(floor)
    // A hit's CPU is its producer's use, not need (the entry keeps no share),
    // so a crowded producer's reads low. Only a task with no need from a run
    // here or the import takes it.
    const hitCpu = new Map<string, number>()
    for (const row of hits) {
      const key = `${row.project}#${row.task}`
      if (!wanted.has(key) || !this.produced(key, row)) continue
      if (row.cpu !== null) hitCpu.set(key, row.cpu)
      const had = out.get(key)
      const rss = Math.max(had?.maxPeakRssBytes ?? -Infinity, row.rss ?? -Infinity)
      out.set(key, {
        ...had,
        // A task this store only restored is timed by its producer, or every
        // later run planned it at a guess (90 s guessed, 45 s run).
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
               FROM main.runs r
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
    for (const [key, slow] of slows) {
      const had = out.get(key)
      if (had !== undefined) out.set(key, { ...had, slowDurationMs: slow })
    }
    return out
  }

  /**
   * Only `p50DurationMs` of each task `resourcesFor` answers, for readers
   * needing nothing else: the grouped reads are skipped, and hits are read only
   * when some task has no forecast.
   */
  async durationsFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (taskIds.length === 0) return new Map()
    const wanted = new Set(taskIds)
    const out = this.forecasts(wanted)
    if (out.size === wanted.size) return out
    // As `resourcesFor` sets it: the last row of a task wins, a row of no time unsetting it.
    const produced = new Map<string, number | null>()
    for (const row of this.producerRows(this.floor())) {
      const key = `${row.project}#${row.task}`
      if (wanted.has(key) && !out.has(key) && this.produced(key, row)) produced.set(key, row.ms)
    }
    for (const [key, ms] of produced) if (ms !== null) out.set(key, ms)
    return out
  }

  /**
   * The window's restored tasks, by what their entries' producers used:
   * each distinct hit key joined to its entry once.
   */
  private producerRows(floor: number): ProducerRow[] {
    return this.db
      .query(
        `SELECT r.project, r.task${this.byDef}, MAX(e.peak_rss_bytes) AS rss,
           MAX(CASE WHEN e.cpu_ms IS NOT NULL AND e.duration_ms > 0
                    THEN e.cpu_ms * 1.0 / e.duration_ms END) AS cpu,
           MAX(CASE WHEN e.duration_ms > 0 THEN e.duration_ms END) AS ms
         FROM (SELECT DISTINCT project, task, hash, def FROM main.runs WHERE id >= ? AND cache_hit = 1) r
         JOIN entries e ON e.hash = r.hash
         GROUP BY r.project, r.task${this.byDef}`,
      )
      .all(floor) as ProducerRow[]
  }

  /** Whether a producer row is of the task as it is now and measured anything. */
  private produced(key: string, row: ProducerRow): boolean {
    return this.current(key, row.def) && (row.rss !== null || row.cpu !== null || row.ms !== null)
  }

  /**
   * A task never measured here takes its need from the newest imported row with
   * one, so a fresh CI machine packs by the default branch's measures. One
   * probe skips a store with none.
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

  /**
   * Of `taskIds`, each whose one timing was recorded at or after `since`: a
   * run's own, with no usual to compare. At most two rows per task off
   * `task_durations_task` (grouping every row cost `vx last` 1.5 s at 2M rows).
   */
  timedOnlySince(taskIds: readonly string[], since: number): string[] {
    if (taskIds.length === 0) return []
    const rows = this.db
      .query(
        `SELECT j.key AS i FROM json_each(?) AS j
         WHERE (SELECT MIN(recorded_at) FROM (
             SELECT recorded_at FROM task_durations
             WHERE project = j.value ->> 0 AND task = j.value ->> 1 ${this.durationDef}
             LIMIT 2) HAVING COUNT(*) = 1) >= ?`,
      )
      .all(JSON.stringify(taskIds.map((id) => this.keyOf(id))), since) as { i: number }[]
    return rows.map((r) => taskIds[r.i]!)
  }

  /**
   * Each task id the window names, sorted, for matching a mistyped id. A scan
   * of the whole table was 270 ms at 2M rows.
   */
  recentTaskIds(): string[] {
    const rows = this.db
      .query('SELECT DISTINCT project, task FROM main.runs WHERE id >= ? ORDER BY project, task')
      .all(this.floor()) as { project: string; task: string }[]
    return rows.map((r) => `${r.project}#${r.task}`)
  }

  /** The first `runs` id of the newest `recent` invocations (see `loadFor`). */
  private floor(): number {
    // The first row of each invocation in the window, a probe each: a
    // group-only run records a header and no row, and at the oldest slot the
    // window read the whole table.
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n, MIN(first) AS id,
           (SELECT COALESCE(MAX(id), 0) + 1 FROM main.runs) AS past
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
          'main.runs',
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

/** A restored task's producer use, from the window's hits (`producerRows`). */
interface ProducerRow {
  project: string
  task: string
  def?: string | null
  rss: number | null
  cpu: number | null
  ms: number | null
}

// A group holds at least one row, so every SUM is a number and `sorted` is
// never empty; q < 1 keeps the index inside it.
function pickPercentile(sorted: number[], q: number): number {
  return sorted[Math.floor(q * sorted.length)]!
}
