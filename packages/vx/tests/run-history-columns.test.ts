// Every field of a run's record lands in its own column, and comes back.
// The history is written by position (`bindRun`, `bindInvocation`), so a
// swapped or dropped binding stores a plausible value in the wrong place and
// nothing fails: a sweep of run-history.ts swapped the wall-clock pair and
// `host`/`os`, dropped `forward_args`, stored a false `cached` as NULL and
// dropped `ON CONFLICT` — and the suite passed all five (item 767). Each
// field here carries a value no other field has, so any of those reads back
// wrong.
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'

// Now-relative: `close()` prunes history older than 30 days (retention).
const T = Date.now()

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-run-history-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const runA: RunRecord = {
  hash: 'aaaaaaaaaaaaaaaa',
  project: 'proj',
  task: 'build',
  status: 'failed',
  exitCode: 3,
  durationMs: 11,
  forwardArgs: ['--mode', 'ci'],
  startedAt: T + 1,
  endedAt: T + 2,
  runId: 'run-1',
  cpuMs: 13,
  peakRssBytes: 17,
  wallclockStartNs: 19n,
  wallclockEndNs: 23n,
  cacheHit: true,
  attempts: 2,
  cached: true,
  blockedBy: 'up#build',
  timedOut: true,
  sandboxViolations: 29,
  notReady: 'timeout',
}

const runB: RunRecord = {
  hash: 'bbbbbbbbbbbbbbbb',
  project: 'proj',
  task: 'test',
  status: 'success',
  exitCode: 0,
  durationMs: 31,
  startedAt: T + 3,
  endedAt: T + 4,
  runId: 'run-1',
  cacheHit: false,
  cached: false,
}

const invocation: InvocationRecord = {
  runId: 'run-1',
  command: 'vx run build',
  requestedTasks: 'build',
  cachePolicy: 'full',
  concurrency: 4,
  flow: 'broad',
  startedAt: T + 1,
  endedAt: T + 4,
  totalDurationMs: 3_000,
  taskCount: 2,
  failedCount: 1,
  hitCount: 5,
  hitLocalCount: 6,
  hitRemoteCount: 7,
  exitOk: false,
  commitSha: 'c0ffee',
  branch: 'main',
  dirty: false,
  ci: true,
  ciProvider: 'github',
  host: 'the-host',
  os: 'the-os',
  arch: 'the-arch',
  vxVersion: '9.9.9',
  tags: '{"k":"v"}',
}

describe('the run history stores each field in its own column', () => {
  it('a run bundle reads back field by field', () => {
    const cache = new Cache(path.join(dir, 'cache'))
    cache.recordRunBundle({ runs: [runA, runB], invocation })
    // A bundle written again under the same run id keeps the first header.
    cache.recordRunBundle({ runs: [], invocation: { ...invocation, command: 'again' } })
    cache.close()

    const db = new Database(path.join(dir, 'cache', 'cache.db'), { readonly: true })
    try {
      const runs = db
        .query(
          `SELECT hash, project, task, status, exit_code, duration_ms, forward_args,
                  started_at, ended_at, run_id, cpu_ms, peak_rss_bytes,
                  wallclock_start_ns, wallclock_end_ns, cache_hit, attempts, cached,
                  blocked_by, timed_out, sandbox_violations, not_ready
           FROM runs ORDER BY started_at`,
        )
        .all()
      expect(runs).toEqual([
        {
          hash: 'aaaaaaaaaaaaaaaa',
          project: 'proj',
          task: 'build',
          status: 'failed',
          exit_code: 3,
          duration_ms: 11,
          forward_args: '["--mode","ci"]',
          started_at: T + 1,
          ended_at: T + 2,
          run_id: 'run-1',
          cpu_ms: 13,
          peak_rss_bytes: 17,
          wallclock_start_ns: 19,
          wallclock_end_ns: 23,
          cache_hit: 1,
          attempts: 2,
          cached: 1,
          blocked_by: 'up#build',
          timed_out: 1,
          sandbox_violations: 29,
          not_ready: 'timeout',
        },
        {
          hash: 'bbbbbbbbbbbbbbbb',
          project: 'proj',
          task: 'test',
          status: 'success',
          exit_code: 0,
          duration_ms: 31,
          forward_args: null,
          started_at: T + 3,
          ended_at: T + 4,
          run_id: 'run-1',
          cpu_ms: null,
          peak_rss_bytes: null,
          wallclock_start_ns: null,
          wallclock_end_ns: null,
          // false is 0, not NULL: NULL is a row written before the column.
          cache_hit: 0,
          attempts: null,
          cached: 0,
          blocked_by: null,
          timed_out: null,
          sandbox_violations: null,
          not_ready: null,
        },
      ])
      const invocations = db
        .query(
          `SELECT run_id, command, requested_tasks, cache_policy, concurrency, flow,
                  started_at, ended_at, total_duration_ms, task_count, failed_count,
                  hit_count, hit_local_count, hit_remote_count, exit_ok, commit_sha,
                  branch, dirty, ci, ci_provider, host, os, arch, vx_version, tags
           FROM invocations`,
        )
        .all()
      expect(invocations).toEqual([
        {
          run_id: 'run-1',
          command: 'vx run build',
          requested_tasks: 'build',
          cache_policy: 'full',
          concurrency: 4,
          flow: 'broad',
          started_at: T + 1,
          ended_at: T + 4,
          total_duration_ms: 3_000,
          task_count: 2,
          failed_count: 1,
          hit_count: 5,
          hit_local_count: 6,
          hit_remote_count: 7,
          exit_ok: 0,
          commit_sha: 'c0ffee',
          branch: 'main',
          dirty: 0,
          ci: 1,
          ci_provider: 'github',
          host: 'the-host',
          os: 'the-os',
          arch: 'the-arch',
          vx_version: '9.9.9',
          tags: '{"k":"v"}',
        },
      ])
    } finally {
      db.close()
    }
  })
})
