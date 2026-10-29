// `--dry` asks the history for p50s alone (`p50sFor`), one query over the
// window's executed successes instead of `loadFor`'s rates and resource
// joins; vx-history asks for p50s and resource maxima
// (`resourcesFor`). These rows hold each to `loadFor`'s answer for every task.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { indexDb, Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'
import { LocalHistoryProvider, type TaskResources } from '../src/history/index.js'

const STATUSES: RunRecord['status'][] = ['success', 'cache-hit', 'failed', 'skipped', 'success']

function run(i: number, runId: string, task: string): RunRecord {
  const status = STATUSES[(i * 7 + task.length) % STATUSES.length]!
  return {
    hash: `h${i}-${task}`,
    project: 'p',
    task,
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: (i * 37) % 101,
    startedAt: 1_000 + i,
    endedAt: 2_000 + i,
    runId,
    wallclockStartNs: 0n,
    wallclockEndNs: 1n,
    cacheHit: status === 'cache-hit' || (status === 'success' && i % 4 === 0),
    ...(i % 3 === 0 ? { attempts: 2 } : {}),
    ...(i % 5 !== 0 ? { peakRssBytes: ((i * 13) % 17) * 1_000 } : {}),
    ...(i % 2 === 0 ? { cpuMs: (i * 11) % 29 } : {}),
  }
}

function invocation(runId: string, startedAt: number): InvocationRecord {
  return {
    runId,
    command: 'vx run',
    requestedTasks: '[]',
    cachePolicy: 'local:rw,remote:',
    concurrency: 1,
    flow: null,
    startedAt,
    endedAt: startedAt + 1,
    totalDurationMs: 1,
    taskCount: 0,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    upToDateCount: 0,
    restoredLocalCount: 0,
    restoredRemoteCount: 0,
    exitOk: true,
    commitSha: null,
    branch: null,
    dirty: null,
    ci: false,
    ciProvider: null,
    host: null,
    os: null,
    arch: null,
    vxVersion: '0.0.0',
  }
}

const TASKS = ['a', 'bb', 'ccc', 'dddd', 'only-hits', 'never']

let dir: string
let cache: Cache
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vx-p50s-'))
  cache = new Cache(path.join(dir, 'cache'))
  for (let i = 0; i < 30; i++) {
    const runId = `inv-${i}`
    const runs = TASKS.slice(0, 4).map((t) => run(i, runId, t))
    runs.push({ ...run(i, runId, 'only-hits'), status: 'cache-hit', cacheHit: true })
    cache.recordRunBundle({ runs, invocation: invocation(runId, 1_000 + i) })
  }
  // What each hit's entry says its producing execution used; some say nothing.
  const entry = indexDb(cache).query(
    `INSERT OR IGNORE INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes,
         created_at, accessed_at, cpu_ms, peak_rss_bytes) VALUES (?, 'p', ?, 'x', 0, ?, 1, 1, 1, ?, ?)`,
  )
  for (let i = 0; i < 30; i++) {
    for (const t of TASKS.slice(0, 5)) {
      if (i % 6 === 5) continue
      entry.run(
        `h${i}-${t}`,
        t,
        (i * 19) % 41,
        i % 4 === 0 ? null : (i * 3) % 23,
        i % 3 === 0 ? null : ((i * 7) % 31) * 1_000,
      )
    }
  }
})
afterEach(() => {
  cache.close()
  rmSync(dir, { recursive: true, force: true })
})

it('answers the p50 loadFor answers for each task, inside and across the window', async () => {
  const ids = TASKS.map((t) => `p#${t}`)
  for (const recent of [1, 7, 30, 50]) {
    const history = new LocalHistoryProvider(indexDb(cache), recent)
    const full = await history.loadFor(ids)
    const p50s = await history.p50sFor(ids)
    const expected = ids.flatMap((id): Array<[string, number]> => {
      const p50 = full.get(id)?.p50DurationMs
      return p50 === undefined ? [] : [[id, p50]]
    })
    expect([recent, [...p50s]]).toEqual([recent, expected])
    // CONTROL: the fixture has tasks with a p50 and tasks without one.
    expect(expected.length).toBeGreaterThan(0)
    expect(expected.length).toBeLessThan(ids.length)
  }
  // Only what was asked for.
  expect([...(await new LocalHistoryProvider(indexDb(cache)).p50sFor(['p#a']))].length).toBe(1)
})

it('answers the p50 and resource maxima loadFor answers for each task', async () => {
  const ids = TASKS.map((t) => `p#${t}`)
  for (const recent of [1, 7, 30, 50]) {
    const history = new LocalHistoryProvider(indexDb(cache), recent)
    const full = await history.loadFor(ids)
    const got = await history.resourcesFor(ids)
    // The forecast reads past the window (p50sFor); the maxima stay in it.
    const p50s = await history.p50sFor(ids)
    // A task with no forecast is timed by its hits' producers, at most.
    const produced = (id: string): number | undefined =>
      p50s.has(id) ? p50s.get(id) : got.get(id)?.p50DurationMs
    const expected = ids.flatMap((id): Array<[string, TaskResources]> => {
      const h = full.get(id)
      if (h === undefined) return p50s.has(id) ? [[id, { p50DurationMs: p50s.get(id) }]] : []
      const r: TaskResources = {
        p50DurationMs: produced(id),
        ...(h.maxPeakRssBytes !== undefined ? { maxPeakRssBytes: h.maxPeakRssBytes } : {}),
        ...(h.maxCpuParallelism !== undefined ? { maxCpuParallelism: h.maxCpuParallelism } : {}),
      }
      return r.p50DurationMs === undefined && Object.keys(r).length === 1 ? [] : [[id, r]]
    })
    expect([recent, [...got]]).toEqual([recent, expected])
    // CONTROL: a hit-only task carries its entry's numbers, its time the
    // longest producer's.
    if (recent >= 7) {
      const longest = indexDb(cache)
        .query(
          `SELECT MAX(e.duration_ms) AS ms FROM entries e WHERE e.task = 'only-hits' AND e.hash IN (
             SELECT hash FROM runs WHERE task = 'only-hits' ORDER BY id DESC LIMIT ?)`,
        )
        .get(recent) as { ms: number }
      expect(got.get('p#only-hits')?.p50DurationMs).toBe(longest.ms)
      expect(got.get('p#only-hits')?.maxPeakRssBytes).toBeGreaterThan(0)
    }
  }
})

it('names the biggest machine a task filled, by its cores or its memory', async () => {
  const base = (task: string, over: Partial<RunRecord>): RunRecord => ({
    ...run(0, 'sat', task),
    status: 'success',
    exitCode: 0,
    cacheHit: false,
    durationMs: 1_000,
    ...over,
  })
  cache.recordRunBundle({
    runs: [
      // 1.9 of 2 cores for its whole run: filled; on 8 it used 2: did not.
      base('cpu', {
        placement: 'small#1',
        placementCores: 2,
        placementMemoryBytes: 8e9,
        cpuMs: 1_900,
      }),
      base('cpu', {
        placement: 'big#1',
        placementCores: 8,
        placementMemoryBytes: 32e9,
        cpuMs: 2_000,
      }),
      // Killed at its machine's memory: a failure counts.
      base('mem', {
        status: 'failed',
        exitCode: 137,
        placement: 'small#2',
        placementCores: 2,
        placementMemoryBytes: 8e9,
        cpuMs: 100,
        peakRssBytes: 7.9e9,
      }),
      // Every core at its sampled peak, a quarter on average: not filled.
      base('burst', {
        placement: 'small#1',
        placementCores: 2,
        placementMemoryBytes: 8e9,
        cpuMs: 500,
        peakCores: 2,
      }),
      base('roomy', {
        placement: 'small#1',
        placementCores: 2,
        placementMemoryBytes: 8e9,
        cpuMs: 500,
      }),
    ],
    invocation: invocation('sat', 5_000),
  })
  const r = await new LocalHistoryProvider(indexDb(cache)).resourcesFor([
    'p#cpu',
    'p#mem',
    'p#roomy',
    'p#burst',
  ])
  expect(r.get('p#cpu')?.saturatedCores).toBe(2)
  expect(r.get('p#cpu')?.saturatedMemoryBytes).toBeUndefined()
  expect(r.get('p#mem')?.saturatedMemoryBytes).toBe(8e9)
  expect(r.get('p#mem')?.saturatedCores).toBeUndefined()
  expect(r.get('p#roomy')?.saturatedCores).toBeUndefined()
  expect(r.get('p#burst')?.saturatedCores).toBeUndefined()
})

// Main b5b83bb (2026-10-24): one crowded run read 2.84 cores for a build
// that uses 1.3 to 1.9; the most over the window booked it a whole 3-core
// Mac, and the tasks beside it waited 45 s.
it('learns the mean need over the window, filling a machine only on average', async () => {
  const at = (i: number, cpuMs: number, cpuShare?: number): RunRecord => ({
    ...run(i, `mean${i}`, 'build'),
    status: 'success',
    exitCode: 0,
    cacheHit: false,
    durationMs: 10_000,
    placement: 'mac#1',
    placementCores: 3,
    placementMemoryBytes: 7e9,
    cpuMs,
    ...(cpuShare === undefined ? {} : { cpuShare }),
  })
  for (const [i, r] of [at(0, 16_000), at(1, 19_000, 0.67), at(2, 19_000)].entries())
    cache.recordRunBundle({ runs: [r], invocation: invocation(`mean${i}`, 5_000 + i) })
  const r = await new LocalHistoryProvider(indexDb(cache)).resourcesFor(['p#build'])
  expect(r.get('p#build')?.maxCpuParallelism).toBeCloseTo((1.6 + 1.9 / 0.67 + 1.9) / 3, 2)
  expect(r.get('p#build')?.saturatedCores).toBeUndefined()
})

// Main c27c238 (2026-10-23): nine test shards on a 4-core worker each used
// 0.36 cores of the 1.1 they take alone; history learned 0.36, the next run
// packed them as tight, and their 5 s tests timed out. A run's CPU is
// divided by the share of a core its threads got there.
it('learns a crowded run’s need, not its share, and never past its machine', async () => {
  const base = (task: string, over: Partial<RunRecord>): RunRecord => ({
    ...run(0, 'crowd', task),
    status: 'success',
    exitCode: 0,
    cacheHit: false,
    durationMs: 100_000,
    placement: 'small#16',
    placementCores: 4,
    placementMemoryBytes: 16e9,
    ...over,
  })
  cache.recordRunBundle({
    runs: [
      base('shard', { cpuMs: 36_000, cpuShare: 0.33 }),
      base('free', { cpuMs: 36_000 }),
      base('misread', { cpuMs: 36_000, cpuShare: 0.05 }),
    ],
    invocation: invocation('crowd', 5_000),
  })
  const r = await new LocalHistoryProvider(indexDb(cache)).resourcesFor([
    'p#shard',
    'p#free',
    'p#misread',
  ])
  expect(r.get('p#shard')?.maxCpuParallelism).toBeCloseTo(1.09, 2)
  expect(r.get('p#free')?.maxCpuParallelism).toBeCloseTo(0.36, 2)
  // 7.2 cores wanted on 4: its machine, which it filled.
  expect(r.get('p#misread')?.maxCpuParallelism).toBe(4)
  expect(r.get('p#misread')?.saturatedCores).toBe(4)
})
