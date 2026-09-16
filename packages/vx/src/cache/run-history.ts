// The run history: one `runs` row per task outcome and one `invocations`
// header per `vx run`, written together, plus their 30-day retention.
// What `vx why`, `vx last`, `stats` and the history reader read. Owns
// its statements over the store's handle; `Cache` delegates.

import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { InvocationRecord, RunRecord } from './layer.js'

export class RunHistory {
  private readonly insertRun: ReturnType<Database['prepare']>
  private readonly insertInvocation: ReturnType<Database['prepare']>

  constructor(private readonly db: Database) {
    this.insertRun = this.db.prepare(`
      INSERT INTO runs(
        hash, project, task, status, exit_code, duration_ms, forward_args,
        started_at, ended_at,
        run_id, cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns,
        cache_hit, attempts, cached,
        blocked_by, timed_out, sandbox_violations, not_ready
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?)
    `)
    this.insertInvocation = this.db.prepare(`
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
    `)
  }

  recordRun(run: RunRecord): void {
    this.insertRun.run(...bindRun(run))
  }

  recordRuns(runs: readonly RunRecord[]): void {
    if (runs.length === 0) return
    if (runs.length === 1) {
      this.insertRun.run(...bindRun(runs[0]!))
      return
    }
    // `bun:sqlite`'s `transaction()` returns a callable that wraps the
    // body in BEGIN/COMMIT, fsyncing once at the end. For a 200-task
    // run that's one fsync instead of 200.
    const insert = this.insertRun
    const tx = this.db.transaction((batch: readonly RunRecord[]) => {
      for (const r of batch) insert.run(...bindRun(r))
    })
    tx(runs)
  }

  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void {
    // Whole run records atomically — one transaction, one fsync: the
    // per-task `runs` rows and the one `invocations` header. The
    // input-fingerprint rows do NOT live here: they're written inside
    // the entry-save transaction (`save`/`ingest`) so a warm
    // all-cache-hit run — which writes no `runs`-vs-`entry_inputs`
    // mismatch — pays nothing for the moat it isn't refreshing.
    const insertRun = this.insertRun
    const insertInvocation = this.insertInvocation
    this.db.transaction(() => {
      for (const r of bundle.runs) insertRun.run(...bindRun(r))
      insertInvocation.run(...bindInvocation(bundle.invocation))
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
 * `insertRun` prepared statement (17 columns). Shared between the
 * single and batched record paths.
 */
function bindRun(run: RunRecord): SQLQueryBindings[] {
  return [
    // The ONE place the no-key sentinel is applied, so the column's
    // NOT NULL invariant can't be violated from a call site.
    run.hash ?? '',
    run.project,
    run.task,
    run.status,
    run.exitCode,
    run.durationMs,
    run.forwardArgs ? JSON.stringify(run.forwardArgs) : null,
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
