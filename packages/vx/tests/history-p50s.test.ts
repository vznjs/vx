// `--dry` asks the history for p50s alone (`p50sFor`), one query over the
// window's executed successes instead of `loadFor`'s rates and resource
// joins; schedule-history asks for p50s and resource maxima
// (`resourcesFor`). These rows hold each to `loadFor`'s answer for every task.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'
import { LocalHistoryProvider, type TaskResources } from '../src/orchestrator/index.js'

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
    cachePolicy: 'lR,lW',
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
    tags: '{}',
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
  const entry = cache.dbHandle().query(
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
    const history = new LocalHistoryProvider(cache.dbHandle(), recent)
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
  expect([...(await new LocalHistoryProvider(cache.dbHandle()).p50sFor(['p#a']))].length).toBe(1)
})

it('answers the p50 and resource maxima loadFor answers for each task', async () => {
  const ids = TASKS.map((t) => `p#${t}`)
  for (const recent of [1, 7, 30, 50]) {
    const history = new LocalHistoryProvider(cache.dbHandle(), recent)
    const full = await history.loadFor(ids)
    const got = await history.resourcesFor(ids)
    const expected = ids.flatMap((id): Array<[string, TaskResources]> => {
      const h = full.get(id)
      if (h === undefined) return []
      const r: TaskResources = {
        p50DurationMs: h.p50DurationMs,
        ...(h.maxPeakRssBytes !== undefined ? { maxPeakRssBytes: h.maxPeakRssBytes } : {}),
        ...(h.maxCpuParallelism !== undefined ? { maxCpuParallelism: h.maxCpuParallelism } : {}),
      }
      return r.p50DurationMs === undefined && Object.keys(r).length === 1 ? [] : [[id, r]]
    })
    expect([recent, [...got]]).toEqual([recent, expected])
    // CONTROL: a hit-only task carries its entry's numbers and no p50.
    if (recent >= 7) {
      expect(got.get('p#only-hits')?.p50DurationMs).toBeUndefined()
      expect(got.get('p#only-hits')?.maxPeakRssBytes).toBeGreaterThan(0)
    }
  }
})
