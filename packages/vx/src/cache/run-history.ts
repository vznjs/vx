// The run history: one `runs` row per task outcome and one `invocations`
// header per `vx run`, written together, plus their 30-day retention.
// What `vx why`, `vx last`, `stats` and the history reader read. Owns
// its statements over the store's handle; `Cache` delegates.

import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { lazyStatement } from './schema.js'
import type { InvocationRecord, RunRecord } from './layer.js'
import { isMeasure } from '../util/index.js'

/** The `runs` columns `bindRun` fills, in its order. */
const RUN_COLUMNS = [
  'hash',
  'project',
  'task',
  'status',
  'exit_code',
  'duration_ms',
  'forward_args',
  'started_at',
  'ended_at',
  'run_id',
  'cpu_ms',
  'peak_rss_bytes',
  'wallclock_start_ns',
  'wallclock_end_ns',
  'cache_hit',
  'attempts',
  'cached',
  'blocked_by',
  'timed_out',
  'sandbox_violations',
  'not_ready',
  'restored',
  'remote_error',
  'peak_cores',
  'avg_rss_bytes',
  'placement',
  'placement_cores',
  'placement_memory',
  'keyless_by',
  'def',
  'cpu_share',
  'queued_ms',
  'output_bytes',
  'blocks',
  'flaky_passes',
  'flaky_failures',
]

const INSERT_RUNS = `INSERT INTO runs(${RUN_COLUMNS.join(', ')}) VALUES `
const RUN_TUPLE = `(${RUN_COLUMNS.map(() => '?').join(', ')})`

/** An INSERT of `n` `runs` rows. */
function insertRunsSql(n: number): string {
  return INSERT_RUNS + Array(n).fill(RUN_TUPLE).join(', ')
}

/**
 * Rows per INSERT: as many as stay within 999 bound variables, the oldest
 * default ceiling, read off the column count (33 rows were sized for 30
 * columns and bound 1,023 at 31). A statement per row was 8.7 ms of 1,000
 * rows, 40 at a time 6.4 (2026-10-03).
 */
const RUNS_PER_INSERT = Math.floor(999 / RUN_COLUMNS.length)

/** Rows per `task_durations` INSERT: 7 variables each, under 999. */
const DURATIONS_PER_INSERT = 140

/** Rows per `task_outcomes` INSERT: 6 variables each, under 999. */
const OUTCOMES_PER_INSERT = 160

/**
 * Whether a run says anything of its key, so the flaky record may keep it:
 * keyed, cached, and not run behind a failure (its bytes were not the key's).
 */
const keyed = (r: RunRecord): boolean =>
  r.hash !== undefined && r.hash !== '' && r.cached !== false && r.blockedBy == null

/** A hit, as the orchestrator marks one (`isCacheHit`, run-records.ts). */
const isHit = (r: RunRecord): boolean => r.cacheHit === true

/**
 * Of a JSON array of hashes, those the record holds a pass of: one index
 * probe each (0.6 ms for 1,000; a join reading every row of each key was
 * 5.7 ms at 20 runs of history). A hit's row is kept only when its key has
 * none: a hit replays a pass, and the first is what a later failure
 * relapses from (an entry adopted from its artifact, or older than the
 * record, has no executed row). By hash alone, as the entry it replays is.
 */
const PASSED_HASHES = `
      SELECT j.value AS hash FROM json_each(?) AS j
      WHERE EXISTS (SELECT 1 FROM task_outcomes AS o WHERE o.hash = j.value AND o.status <> 'failed')`

/** A local run's `task_durations.source`: its branch, `''` when it had none. */
export const branchSource = (branch: string | null): string => `branch:${branch ?? ''}`

/**
 * How long a run would have taken alone: on a crowded worker
 * (`cpuShare` < 1) each runnable thread waited for a core. A task that
 * kept `n` cores busy lost its CPU's wait spread over them, under one
 * core all of it. vx-dte#test (20 s CPU in 75 s) took 81-102 s beside
 * test shards and the plan, reading those, said 118 s for a 92 s run
 * (main fd5c72e, 2026-10-23).
 */
function aloneMs(r: Pick<RunRecord, 'durationMs' | 'cpuMs' | 'cpuShare'>): number {
  const { durationMs: d, cpuMs: c, cpuShare: s } = r
  if (c === undefined || s === undefined || !(s > 0 && s < 1) || !(d > 0)) return d
  return Math.round(d - (c / s - c) / Math.max(1, c / (d * s)))
}

export class RunHistory {
  private readonly insertInvocation: ReturnType<Database['prepare']>

  constructor(
    private readonly db: Database,
    /** The store's salted value digest (L-4). */
    private readonly digestValue: (value: string) => string,
  ) {
    this.insertInvocation = lazyStatement(
      this.db,
      `
      INSERT INTO invocations(
        run_id, command, requested_tasks, cache_policy, concurrency, flow,
        started_at, ended_at, total_duration_ms,
        task_count, failed_count, hit_count, hit_local_count, hit_remote_count,
        up_to_date_count, restored_local_count, restored_remote_count,
        exit_ok,
        commit_sha, branch, dirty, ci, ci_provider,
        host, os, arch, vx_version
      )
      VALUES (?, ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?,  ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `,
    )
  }

  recordRun(run: RunRecord): void {
    this.recordRuns([run])
  }

  recordRuns(runs: readonly RunRecord[]): void {
    if (runs.length === 0) return
    // One transaction, one fsync: for a 200-task run, one instead of 200.
    // IMMEDIATE, as `recordRunBundle` explains.
    this.db
      .transaction(() => {
        this.insertRuns(runs)
        this.insertDurations(runs, branchSource(null), null)
        this.insertOutcomes(runs)
      })
      .immediate()
  }

  /** One `task_durations` row per executed success, as if run alone: what a forecast reads. */
  private insertDurations(runs: readonly RunRecord[], source: string, sha: string | null): void {
    const done = runs.filter(
      (r) => r.status === 'success' && r.cacheHit !== true && isMeasure(aloneMs(r)),
    )
    for (let i = 0; i < done.length; i += DURATIONS_PER_INSERT) {
      const block = done.slice(i, i + DURATIONS_PER_INSERT)
      const params: SQLQueryBindings[] = []
      for (const r of block)
        params.push(r.project, r.task, source, sha, aloneMs(r), r.endedAt, r.def ?? null)
      this.db
        .query(
          `INSERT INTO task_durations(project, task, source, sha, duration_ms, recorded_at, def) VALUES ${Array(block.length).fill('(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        )
        .run(...params)
    }
  }

  /**
   * The flaky record's rows: every executed outcome, and a key's first hit,
   * in the order given (a batch may hold one key's history).
   */
  private insertOutcomes(runs: readonly RunRecord[]): void {
    const rows = runs.filter(
      (r) => keyed(r) && (isHit(r) || r.status === 'success' || r.status === 'failed'),
    )
    const hits = rows.filter(isHit)
    let passed: Set<string> | undefined
    if (hits.length > 0) {
      const found = this.db.query(PASSED_HASHES).all(JSON.stringify(hits.map((r) => r.hash))) as {
        hash: string
      }[]
      passed = new Set(found.map((f) => f.hash))
    }
    const kept: RunRecord[] = []
    for (const r of rows) {
      if (isHit(r)) {
        if (passed!.has(r.hash!)) continue
        passed!.add(r.hash!)
      } else if (r.status === 'success') {
        passed?.add(r.hash!)
      }
      kept.push(r)
    }
    for (let i = 0; i < kept.length; i += OUTCOMES_PER_INSERT) {
      const block = kept.slice(i, i + OUTCOMES_PER_INSERT)
      const params: SQLQueryBindings[] = []
      for (const r of block)
        params.push(r.project, r.task, r.hash!, r.status, r.attempts ?? null, r.startedAt)
      this.db
        .query(
          `INSERT INTO task_outcomes(project, task, hash, status, attempts, recorded_at) VALUES ${Array(block.length).fill('(?, ?, ?, ?, ?, ?)').join(', ')}`,
        )
        .run(...params)
    }
  }

  /** `runs` as few INSERTs; each distinct forward-args list digested once. */
  private insertRuns(runs: readonly RunRecord[]): void {
    const digests = new Map<string, string>()
    const digest = (value: string): string => {
      let d = digests.get(value)
      if (d === undefined) digests.set(value, (d = this.digestValue(value)))
      return d
    }
    for (let i = 0; i < runs.length; i += RUNS_PER_INSERT) {
      const block = runs.slice(i, i + RUNS_PER_INSERT)
      const params: SQLQueryBindings[] = []
      for (const r of block) for (const v of bindRun(r, digest)) params.push(v)
      // `query` caches by text: one statement for every full block.
      this.db.query(insertRunsSql(block.length)).run(...params)
    }
  }

  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void {
    // Whole run records atomically — one transaction, one fsync: the
    // per-task `runs` rows and the one `invocations` header. The
    // input-fingerprint rows do NOT live here: they're written inside
    // the entry-save transaction (`save`/`ingest`) so a warm
    // all-cache-hit run — which writes no `runs`-vs-`entry_inputs`
    // mismatch — pays nothing for the moat it isn't refreshing.
    //
    // IMMEDIATE: the write lock is taken at BEGIN, where the busy timeout
    // waits for it. A run's rows digest their forward args under a salt
    // the body READS first (`[]` from every CLI run), and a deferred
    // transaction that read before it wrote could not wait: 13 of 48 runs
    // on one shared cache dir lost their history to `database is locked`
    // in 2–60 ms (BUSY_SNAPSHOT, a retry passing at once).
    this.db
      .transaction(() => {
        this.insertRuns(bundle.runs)
        this.insertInvocation.run(...bindInvocation(bundle.invocation))
        this.insertDurations(
          bundle.runs,
          branchSource(bundle.invocation.branch),
          bundle.invocation.commitSha,
        )
        this.insertOutcomes(bundle.runs)
      })
      .immediate()
  }

  /**
   * The remote failures a run's uploads met after its rows were written:
   * the uploads drain once the history is in (run.ts).
   */
  recordRemoteErrors(
    runId: string,
    errors: readonly (readonly [hash: string, text: string])[],
  ): void {
    const update = this.db.prepare('UPDATE runs SET remote_error = ? WHERE run_id = ? AND hash = ?')
    this.db
      .transaction(() => {
        for (const [hash, text] of errors) update.run(text, runId, hash)
      })
      .immediate()
  }

  /**
   * Retention: the runs table grows by one row per executed task per
   * invocation — a 2000-task repo accretes ~20k rows in days. 30 days
   * covers `vx info` (24 h windows) and CI-side consumers. The
   * `invocations` header is pruned on the SAME window, or a header would
   * outlive its rows and `vx last` would list a run whose detail is gone.
   */
  pruneOlderThan(cutoff: number): void {
    this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM invocations WHERE started_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM task_durations WHERE recorded_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM task_outcomes WHERE recorded_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM plugin_blobs WHERE at < ?').run(cutoff)
    this.db.prepare('DELETE FROM remote_hits WHERE seen_at < ?').run(cutoff)
  }
}

/** Bind a RunRecord to one `RUN_TUPLE`'s positional parameters, in `RUN_COLUMNS` order. */
function bindRun(run: RunRecord, digestValue: (v: string) => string): SQLQueryBindings[] {
  return [
    // The ONE place the no-key sentinel is applied, so the column's
    // NOT NULL invariant can't be violated from a call site.
    run.hash ?? '',
    run.project,
    run.task,
    run.status,
    run.exitCode,
    run.durationMs,
    // A digest, as entry_inputs keeps: args after `--` carry tokens
    // (`--token=…`), and cache.db holds no plaintext secret at rest; nothing
    // reads the column but for whether the args changed (item 1091).
    run.forwardArgs ? digestValue(JSON.stringify(run.forwardArgs)) : null,
    run.startedAt,
    run.endedAt,
    run.runId ?? null,
    run.cpuMs ?? null,
    run.peakRssBytes ?? null,
    run.wallclockStartNs !== undefined ? run.wallclockStartNs : null,
    run.wallclockEndNs !== undefined ? run.wallclockEndNs : null,
    run.cacheHit === undefined ? null : run.cacheHit ? 1 : 0,
    run.attempts ?? null,
    run.cached === undefined ? null : run.cached ? 1 : 0,
    run.blockedBy ?? null,
    run.timedOut === true ? 1 : null,
    run.sandboxViolations ?? null,
    run.notReady ?? null,
    run.restored === undefined ? null : run.restored ? 1 : 0,
    run.remoteError ?? null,
    run.peakCores ?? null,
    run.avgRssBytes ?? null,
    run.placement ?? null,
    run.placementCores ?? null,
    run.placementMemoryBytes ?? null,
    run.keylessBy ?? null,
    run.def ?? null,
    run.cpuShare ?? null,
    run.queuedMs ?? null,
    run.outputBytes ?? null,
    run.blocks ?? null,
    run.flakyPasses ?? null,
    run.flakyFailures ?? null,
  ]
}

/**
 * Bind an InvocationRecord to the positional parameters of the
 * `insertInvocation` prepared statement (28 columns). Booleans map to
 * 0/1; null-or-bool columns (`dirty`) keep null distinct from 0.
 */
function bindInvocation(inv: InvocationRecord): SQLQueryBindings[] {
  return [
    inv.runId,
    inv.command,
    inv.requestedTasks,
    inv.cachePolicy,
    inv.concurrency,
    inv.flow,
    inv.startedAt,
    inv.endedAt,
    inv.totalDurationMs,
    inv.taskCount,
    inv.failedCount,
    inv.hitCount,
    inv.hitLocalCount,
    inv.hitRemoteCount,
    inv.upToDateCount,
    inv.restoredLocalCount,
    inv.restoredRemoteCount,
    inv.exitOk ? 1 : 0,
    inv.commitSha,
    inv.branch,
    inv.dirty === null ? null : inv.dirty ? 1 : 0,
    inv.ci ? 1 : 0,
    inv.ciProvider,
    inv.host,
    inv.os,
    inv.arch,
    inv.vxVersion,
  ]
}
