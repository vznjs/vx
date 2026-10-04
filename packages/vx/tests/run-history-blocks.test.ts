// A run's `runs` rows are written 40 to an INSERT, and each distinct
// forward-args list digested once per bundle. These rows hold the rows the
// blocks write to the ones a row-at-a-time write leaves, column by column.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import type { InvocationRecord, RunRecord } from '../src/cache/index.js'

const run = (i: number, runId: string): RunRecord => {
  const r: RunRecord = {
    hash: `h${i}`,
    project: `p${i % 7}`,
    task: 'build',
    status: i % 5 === 0 ? 'failed' : 'cache-hit',
    exitCode: i % 5 === 0 ? 1 : 0,
    durationMs: i,
    startedAt: 1_000 + i,
    endedAt: 2_000 + i,
    runId,
    cpuMs: i / 2,
    wallclockStartNs: BigInt(i) * 1_000n,
    wallclockEndNs: BigInt(i) * 2_000n,
    cacheHit: i % 5 !== 0,
    cached: i % 2 === 0,
  }
  if (i % 3 === 1) r.forwardArgs = []
  if (i % 3 === 2) r.forwardArgs = ['--token=x']
  if (i % 4 === 0) r.attempts = 2
  if (i % 6 === 0) {
    r.blockedBy = 'x#y'
    r.timedOut = true
    r.sandboxViolations = 3
    r.notReady = 'timeout'
  }
  return r
}

const invocation = (runId: string): InvocationRecord => ({
  runId,
  command: 'vx run build',
  requestedTasks: '["build"]',
  cachePolicy: 'lR,lW',
  concurrency: 4,
  flow: null,
  startedAt: 1_000,
  endedAt: 3_000,
  totalDurationMs: 2_000,
  taskCount: 85,
  failedCount: 17,
  hitCount: 68,
  hitLocalCount: 68,
  hitRemoteCount: 0,
  upToDateCount: 0,
  restoredLocalCount: 0,
  restoredRemoteCount: 0,
  exitOk: false,
  commitSha: null,
  branch: null,
  dirty: null,
  ci: false,
  ciProvider: null,
  host: null,
  os: null,
  arch: null,
  vxVersion: '0.0.0',
  tags: '{}',
})

describe('a run bundle of 85 rows (two full blocks and five)', () => {
  let root: string
  let cache: Cache
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-run-blocks-'))
    cache = new Cache(path.join(root, 'cache'))
  })
  afterEach(async () => {
    cache.close()
    await rm(root, { recursive: true, force: true })
  })

  it('writes in order the rows one at a time would', () => {
    const n = 85
    cache.recordRunBundle({
      runs: Array.from({ length: n }, (_, i) => run(i, 'bundle')),
      invocation: invocation('bundle'),
    })
    for (let i = 0; i < n; i++) cache.recordRun(run(i, 'single'))
    const rows = (runId: string): unknown[] =>
      (
        cache
          .dbHandle()
          .query('SELECT * FROM runs WHERE run_id = ? ORDER BY id')
          .all(runId) as Array<Record<string, unknown>>
      ).map(({ id: _id, run_id: _r, ...rest }) => rest)
    const bundled = rows('bundle')
    expect(bundled.map((r) => (r as { hash: string }).hash)).toEqual(
      Array.from({ length: n }, (_, i) => `h${i}`),
    )
    expect(bundled).toEqual(rows('single'))
  })
})
