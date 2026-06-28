// The cloud-owned analytics store. A hosted vx-cloud does NOT read a
// developer's private cache.db; it ingests the canonical RunSummaryRecord
// (pushed by the cloud telemetry sink) into its OWN store and serves the
// dashboard from there.
//
// The store IS a core Cache pointed at a cloud-owned directory: core's Cache
// already builds the exact runs + invocations schema and `recordRunBundle`
// writes both atomically, so every analytics query in metrics.ts runs
// UNCHANGED against this store (only the DB handle differs from the local
// cache.db). The artifact/entries tables exist but stay empty — cache-entry
// inventory is a local concern (the hosted dashboard shows run/task analytics
// only; see docs/design/observability-architecture-2026-06.md §6 option c).

import { Cache, type InvocationRecord, type RunRecord, type RunSummaryRecord } from '@vzn/vx'

export class IngestStore {
  private readonly cache: Cache

  constructor(dir: string) {
    this.cache = new Cache(dir)
  }

  /** The DB handle the metrics queries read from. */
  db(): ReturnType<Cache['dbHandle']> {
    return this.cache.dbHandle()
  }

  /**
   * Persist one pushed run. Idempotent: a re-delivered summary (same runId)
   * is ignored — returns false. The per-task `runs` rows have no unique key,
   * so we gate on the invocation header existing rather than relying on the
   * insert. Returns true when the run was newly stored.
   */
  ingest(summary: RunSummaryRecord): boolean {
    const exists = this.db()
      .prepare('SELECT 1 FROM invocations WHERE run_id = ?')
      .get(summary.run.runId)
    if (exists) return false

    const runs = summary.tasks
      .filter((t) => t.status !== 'aborted')
      .map((t): RunRecord => {
        const startedAt =
          t.wallclockStartNs !== undefined
            ? summary.startedAt + Math.round(Number(t.wallclockStartNs) / 1e6)
            : summary.startedAt
        const endedAt =
          t.wallclockEndNs !== undefined
            ? summary.startedAt + Math.round(Number(t.wallclockEndNs) / 1e6)
            : summary.endedAt
        return {
          hash: t.hash ?? '',
          project: t.project,
          task: t.task,
          status: t.status as RunRecord['status'],
          exitCode: t.exitCode,
          durationMs: t.durationMs,
          startedAt,
          endedAt,
          runId: summary.run.runId,
          ...(t.cpuMs !== undefined ? { cpuMs: t.cpuMs } : {}),
          ...(t.peakRssBytes !== undefined ? { peakRssBytes: t.peakRssBytes } : {}),
          ...(t.wallclockStartNs !== undefined
            ? { wallclockStartNs: BigInt(t.wallclockStartNs) }
            : {}),
          ...(t.wallclockEndNs !== undefined ? { wallclockEndNs: BigInt(t.wallclockEndNs) } : {}),
          cacheHit: t.cacheSource === 'local' || t.cacheSource === 'remote',
        }
      })

    const r = summary.run
    const invocation: InvocationRecord = {
      runId: r.runId,
      command: r.command,
      requestedTasks: JSON.stringify(r.requestedTasks),
      cachePolicy: r.cachePolicy,
      concurrency: r.concurrency,
      flow: r.flow,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      totalDurationMs: summary.totalDurationMs,
      taskCount: summary.taskCount,
      failedCount: summary.failedCount,
      hitCount: summary.hitCount,
      hitLocalCount: summary.hitLocalCount,
      hitRemoteCount: summary.hitRemoteCount,
      exitOk: summary.exitOk,
      commitSha: r.commitSha,
      branch: r.branch,
      dirty: r.dirty,
      ci: r.ci,
      ciProvider: r.ciProvider,
      host: r.host,
      os: r.os,
      arch: r.arch,
      vxVersion: r.vxVersion,
      tags: JSON.stringify(r.tags),
    }
    this.cache.recordRunBundle({ runs, invocation })
    return true
  }

  close(): void {
    this.cache.close()
  }
}
