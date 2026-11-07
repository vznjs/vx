// What a run adds to cache.db: history is kept 30 days, so an all-hit run
// (watch, an editor, CI) grows the index by its `runs` rows and their
// indexes every time. A row stores its run's id as an integer (the run's
// row in `run_ids`); the 36-char text was a third of the bytes.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { indexDb, Cache } from '../src/cache/index.js'
import type { InvocationRecord, RunRecord } from '../src/cache/index.js'
import { ulid } from '../src/util/index.js'

const TASKS = 500
const hex = (s: string) => Bun.hash.xxHash64(s).toString(16).padStart(16, '0')

const hit = (i: number, runId: string, at: number): RunRecord => ({
  hash: hex(`key${i}`),
  project: `@bench/l2-${i % 100}`,
  task: ['build', 'lint', 'test', 'publish', 'typecheck'][i % 5]!,
  status: 'cache-hit',
  exitCode: 0,
  durationMs: 0,
  startedAt: at,
  endedAt: at,
  runId,
  wallclockStartNs: BigInt(40_000_000 + i * 1_000),
  wallclockEndNs: BigInt(40_000_000 + i * 1_000 + 900),
  cacheHit: true,
  cached: true,
  restored: false,
  def: hex(`def${i}`),
  queuedMs: 25,
  outputBytes: 0,
  blocks: 0,
})

const invocation = (runId: string, at: number): InvocationRecord => ({
  runId,
  command: 'vx run build lint test publish typecheck --all',
  requestedTasks: '["build","lint","test","publish","typecheck"]',
  cachePolicy: 'local:rw,remote:',
  concurrency: 4,
  flow: null,
  startedAt: at,
  endedAt: at + 150,
  totalDurationMs: 150,
  taskCount: TASKS,
  failedCount: 0,
  hitCount: TASKS,
  hitLocalCount: TASKS,
  hitRemoteCount: 0,
  upToDateCount: TASKS,
  restoredLocalCount: 0,
  restoredRemoteCount: 0,
  exitOk: true,
  commitSha: 'a'.repeat(40),
  branch: 'main',
  dirty: false,
  ci: false,
  ciProvider: null,
  host: 'host',
  os: 'linux',
  arch: 'x64',
  vxVersion: '0.0.0',
})

let root: string
let cache: Cache
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-run-bytes-'))
  cache = new Cache(path.join(root, 'cache'))
})
afterEach(async () => {
  cache.close()
  await rm(root, { recursive: true, force: true })
})

const used = (): number => {
  const db = indexDb(cache)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const n = (q: string) => Object.values(db.query(q).get() as object)[0] as number
  return (n('PRAGMA page_count') - n('PRAGMA freelist_count')) * n('PRAGMA page_size')
}

it('an all-hit run of 500 tasks adds at most 160 bytes a task to the index', () => {
  const record = (k: number) => {
    const runId = ulid()
    const at = 1_800_000_000_000 + k * 1_000
    cache.recordRunBundle({
      runs: Array.from({ length: TASKS }, (_, i) => hit(i, runId, at)),
      invocation: invocation(runId, at),
    })
  }
  // The first run makes each table's first pages.
  record(0)
  const before = used()
  const runs = 6
  for (let k = 1; k <= runs; k++) record(k)
  const perTask = (used() - before) / runs / TASKS
  expect(perTask).toBeLessThanOrEqual(160)
})
