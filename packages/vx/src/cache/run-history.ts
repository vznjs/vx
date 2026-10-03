// The run history: one `runs` row per task outcome and one `invocations`
// header per `vx run`, written together, plus their 30-day retention.
// What `vx why`, `vx last`, `stats` and the history reader read. Owns
// its statements over the store's handle; `Cache` delegates.

import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { lazyStatement } from './schema.js'
import type { InvocationRecord, RunRecord } from './layer.js'

const INSERT_RUNS = `
      INSERT INTO runs(
        hash, project, task, status, exit_code, duration_ms, forward_args,
        started_at, ended_at,
        run_id, cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns,
        cache_hit, attempts, cached,
        blocked_by, timed_out, sandbox_violations, not_ready
      )
      VALUES `
/** One `runs` row's placeholders: the 21 columns `bindRun` fills. */
const RUN_TUPLE = `(${Array(21).fill('?').join(', ')})`

/** An INSERT of `n` `runs` rows. */
function insertRunsSql(n: number): string {
  return INSERT_RUNS + Array(n).fill(RUN_TUPLE).join(', ')
}

/**
 * Rows per INSERT: 40 × 21 variables stays under 999, the oldest default
 * ceiling. A statement per row was 8.7 ms of 1,000 rows, 40 at a time 6.4
 * (2026-10-03).
 */
const RUNS_PER_INSERT = 40

export class RunHistory {
  private readonly insertRun: ReturnType<Database['prepare']>
  private readonly insertInvocation: ReturnType<Database['prepare']>

  constructor(
    private readonly db: Database,
    /** The store's salted value digest (L-4). */
    private readonly digestValue: (value: string) => string,
  ) {
    this.insertRun = lazyStatement(this.db, insertRunsSql(1))
    this.insertInvocation = lazyStatement(
      this.db,
      `
      INSERT INTO invocations(
        run_id, command, requested_tasks, cache_policy, concurrency, flow,
        started_at, ended_at, total_duration_ms,
        task_count, failed_count, hit_count, hit_local_count, hit_remote_count,
        exit_ok,
        commit_sha, branch, dirty, ci, ci_provider,
        host, os, arch, vx_version, tags
      )
      VALUES (?, ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?,  ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `,
    )
  }

  recordRun(run: RunRecord): void {
    this.insertRun.run(...bindRun(run, this.digestValue))
  }

  recordRuns(runs: readonly RunRecord[]): void {
    if (runs.length === 0) return
    if (runs.length === 1) {
      this.insertRun.run(...bindRun(runs[0]!, this.digestValue))
      return
    }
    // `bun:sqlite`'s `transaction()` returns a callable that wraps the
    // body in BEGIN/COMMIT, fsyncing once at the end. For a 200-task
    // run that's one fsync instead of 200.
    this.db.transaction(() => this.insertRuns(runs))()
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
      for (const r of block) params.push(...bindRun(r, digest))
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
    this.db.transaction(() => {
      this.insertRuns(bundle.runs)
      this.insertInvocation.run(...bindInvocation(bundle.invocation))
    })()
  }

  /**
   * Retention: the runs table grows by one row per executed task per
   * invocation — a 2000-task repo accretes ~20k rows in days. 30 days
   * covers `vx stats` (24 h windows) and CI-side consumers. The
   * `invocations` header is pruned on the SAME window, or a header would
   * outlive its rows and `vx last` would list a run whose detail is gone.
   */
  pruneOlderThan(cutoff: number): void {
    this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM invocations WHERE started_at < ?').run(cutoff)
  }
}

/**
 * Bind a RunRecord to the positional parameters expected by the
 * `insertRun` prepared statement (21 columns). Shared between the
 * single and batched record paths.
 */
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
  ]
}

/**
 * Bind an InvocationRecord to the positional parameters of the
 * `insertInvocation` prepared statement (25 columns). Booleans map to
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
    inv.tags,
  ]
}
