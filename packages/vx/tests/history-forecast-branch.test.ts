// A duration forecast is the median of a task's last five timings on this
// run's branch, else on any branch, else none (2026-10-14). The
// timings live in the shared store, so every worktree of a repo reads them.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { indexDb, Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'
import { LocalHistoryProvider } from '../src/history/index.js'

let dir: string
/** The shared store: `~/.vx/<id>/cache`, each level owner-only. */
let store: string
let cache: Cache
let seq = 0
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vx-forecast-'))
  mkdirSync(path.join(dir, 'home'))
  store = path.join(dir, 'home', '.vx', 'id', 'cache')
  cache = new Cache(path.join(dir, 'cache'), undefined, undefined, undefined, 'open', store)
})
afterEach(() => {
  cache.close()
  rmSync(dir, { recursive: true, force: true })
})

/** One invocation on `branch` executing `task` for `ms` (a hit when `hit`). */
function record(
  branch: string | null,
  task: string,
  ms: number,
  hit = false,
  crowd: Pick<RunRecord, 'cpuMs' | 'cpuShare'> = {},
): void {
  const runId = `inv-${++seq}`
  const run: RunRecord = {
    hash: `h${seq}`,
    project: 'p',
    task,
    status: hit ? 'cache-hit' : 'success',
    exitCode: 0,
    durationMs: ms,
    startedAt: seq,
    endedAt: seq + 1,
    runId,
    wallclockStartNs: 0n,
    wallclockEndNs: 1n,
    cacheHit: hit,
    ...crowd,
  }
  const invocation: InvocationRecord = {
    runId,
    command: 'vx run',
    requestedTasks: '[]',
    cachePolicy: 'local:rw,remote:',
    concurrency: 1,
    flow: null,
    startedAt: seq,
    endedAt: seq + 1,
    totalDurationMs: 1,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    upToDateCount: 0,
    restoredLocalCount: 0,
    restoredRemoteCount: 0,
    exitOk: true,
    commitSha: null,
    branch,
    dirty: null,
    ci: false,
    ciProvider: null,
    host: null,
    os: null,
    arch: null,
    vxVersion: '0.0.0',
  }
  cache.recordRunBundle({ runs: [run], invocation })
}

const forecast = async (
  branch: string | null | undefined,
  c: Cache = cache,
): Promise<number | undefined> => {
  const provider = new LocalHistoryProvider(indexDb(c), undefined, branch)
  const p50 = (await provider.p50sFor(['p#t'])).get('p#t')
  // Every reader forecasts alike; loadFor answers only a task with runs in its window.
  expect((await provider.resourcesFor(['p#t'])).get('p#t')?.p50DurationMs).toBe(p50)
  const row = (await provider.loadFor(['p#t'])).get('p#t')
  if (row !== undefined) expect(row.p50DurationMs).toBe(p50)
  return p50
}

it("reads the last five executed successes on this run's branch", async () => {
  for (const ms of [900, 100, 200, 300, 400, 500]) record('feature', 't', ms)
  record('feature', 't', 1, true)
  for (let i = 0; i < 10; i++) record('main', 't', 60_000)
  // The newest five on feature are 100..500; the 900 is older and the hit ran nothing.
  expect(await forecast('feature')).toBe(300)
})

it('forecasts a run on a crowded worker as the time it would take alone', async () => {
  // Under one core (20 s CPU in 75 s at a 0.8 share), it lost only its own
  // CPU's wait: 20 s / 0.8 - 20 s. vx-dte#test beside test shards, main fd5c72e.
  record('main', 't', 75_000, false, { cpuMs: 20_000, cpuShare: 0.8 })
  expect(await forecast('main')).toBe(70_000)
})

it('a crowded run over one core loses its wait spread over the cores it kept busy', async () => {
  // 30 s CPU in 40 s at 0.6: 1.25 cores alone, so 20 s of wait over 1.25.
  record('main', 't', 40_000, false, { cpuMs: 30_000, cpuShare: 0.6 })
  expect(await forecast('main')).toBe(24_000)
})

it('a run with no crowding, or no share measured, keeps its wall time', async () => {
  record('main', 't', 50_000, false, { cpuMs: 20_000, cpuShare: 1 })
  record('main', 'u', 50_000, false, { cpuMs: 20_000 })
  expect(await forecast('main')).toBe(50_000)
})

it('falls back to the last five on any branch when this branch never ran the task', async () => {
  for (const ms of [10, 20, 30]) record('main', 't', ms)
  for (const ms of [40, 50, 60]) record('other', 't', ms)
  expect(await forecast('feature')).toBe(40)
  expect(await forecast(undefined)).toBe(40)
})

it('forecasts nothing for a task no branch ran', async () => {
  record('main', 'other-task', 1_000)
  expect(await forecast('feature')).toBeUndefined()
})

it('a run with no branch (detached, or no git) reads the timings recorded with none first', async () => {
  for (const ms of [7, 8, 9]) record(null, 't', ms)
  record('feature', 't', 1_000)
  expect(await forecast(null)).toBe(8)
})

it('reads timings older than the runs window: the five are exact, not the newest invocations', async () => {
  for (const ms of [1, 2, 3]) record('feature', 't', ms)
  for (let i = 0; i < 60; i++) record('feature', 'busy', 5)
  expect(await forecast('feature')).toBe(2)
})

it("another worktree's timings forecast a new worktree's first run", async () => {
  for (const ms of [11, 12, 13]) record('feature', 't', ms)
  const fresh = new Cache(
    path.join(dir, 'other-worktree'),
    undefined,
    undefined,
    undefined,
    'open',
    store,
  )
  try {
    expect(await forecast('feature', fresh)).toBe(12)
  } finally {
    fresh.close()
  }
})

it('worktrees recording in parallel on one store lose no timing, never fail busy, and a forecast never waits', async () => {
  cache.close()
  const WORKERS = 6
  const RUNS = 25
  const script = path.join(dir, 'writer.ts')
  await Bun.write(
    script,
    `import { Cache } from ${JSON.stringify(path.join(import.meta.dir, '../src/cache/index.js'))}
const [cacheDir, store, w, runs] = process.argv.slice(2)
const cache = new Cache(cacheDir, undefined, undefined, undefined, 'open', store)
// Now-ish times: the history's 30-day retention runs at close.
const at = Date.now()
for (let i = 0; i < Number(runs); i++) {
  const runId = 'w' + w + '-' + i
  const run = { hash: runId, project: 'p', task: 't', status: 'success', exitCode: 0, durationMs: 1, startedAt: at + i, endedAt: at + i + 1, runId, wallclockStartNs: 0n, wallclockEndNs: 1n }
  cache.recordRunBundle({ runs: [run], invocation: { runId, command: 'vx run', requestedTasks: '[]', cachePolicy: 'local:rw,remote:', concurrency: 1, flow: null, startedAt: at + i, endedAt: at + i + 1, totalDurationMs: 1, taskCount: 1, failedCount: 0, hitCount: 0, hitLocalCount: 0, hitRemoteCount: 0, upToDateCount: 0, restoredLocalCount: 0, restoredRemoteCount: 0, exitOk: true, commitSha: null, branch: 'b' + w, dirty: null, ci: false, ciProvider: null, host: null, os: null, arch: null, vxVersion: '0', tags: '{}' } })
}
cache.close()
`,
  )
  // Each worktree's index exists before the race: the first open creates the store.
  for (let w = 0; w < WORKERS; w++)
    new Cache(path.join(dir, `wt${w}`), undefined, undefined, undefined, 'open', store).close()
  const procs = Array.from({ length: WORKERS }, (_, w) =>
    Bun.spawn(['bun', script, path.join(dir, `wt${w}`), store, String(w), String(RUNS)], {
      stderr: 'pipe',
    }),
  )
  const codes = await Promise.all(procs.map((p) => p.exited))
  const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()))
  expect(errors.filter((e) => e.length > 0)).toEqual([])
  expect(codes).toEqual(Array(WORKERS).fill(0))
  const db = new Database(path.join(store, 'store.db'))
  try {
    const rows = db
      .query('SELECT source, COUNT(*) AS n FROM task_durations GROUP BY source ORDER BY source')
      .all()
    expect(rows).toEqual(
      Array.from({ length: WORKERS }, (_, w) => ({ source: `branch:b${w}`, n: RUNS })),
    )
  } finally {
    db.close()
  }
  // A writer holding the store's write lock: the forecast reads past it at once.
  const holder = new Database(path.join(store, 'store.db'))
  holder.exec('BEGIN IMMEDIATE')
  holder.exec(
    "INSERT INTO task_durations(project, task, source, sha, duration_ms, recorded_at) VALUES ('p', 't', 'branch:b0', NULL, 1, 0)",
  )
  cache = new Cache(
    path.join(dir, 'wt0'),
    { read: true, write: false },
    undefined,
    undefined,
    'open',
    store,
  )
  try {
    const started = performance.now()
    expect(await forecast('b0')).toBe(1)
    expect(performance.now() - started).toBeLessThan(1_000)
  } finally {
    holder.exec('ROLLBACK')
    holder.close()
  }
}, 60_000)

it("reads the default branch's imported timing between this branch and any branch", async () => {
  for (const ms of [40, 50, 60]) record('other', 't', ms)
  const provider = new LocalHistoryProvider(indexDb(cache), undefined, 'feature')
  await provider.p50sFor(['p#t'])
  expect(provider.lackedBranchHistory).toBe(true)
  expect(provider.hasImported('abc')).toBe(false)
  provider.importTimings('abc', new Map([['p#t', 7]]))
  expect(provider.hasImported('abc')).toBe(true)
  expect(await forecast('feature')).toBe(7)
  for (const ms of [1, 2, 3]) record('feature', 't', ms)
  await provider.p50sFor(['p#t'])
  expect(provider.lackedBranchHistory).toBe(false)
  expect(await forecast('feature')).toBe(2)
})

it('a repeat import of one commit adds no row, from any worktree', async () => {
  const provider = new LocalHistoryProvider(indexDb(cache), undefined, 'feature')
  provider.importTimings('abc', new Map([['p#t', 7]]))
  const other = new Cache(path.join(dir, 'cache-2'), undefined, undefined, undefined, 'open', store)
  try {
    new LocalHistoryProvider(indexDb(other), undefined, 'x').importTimings(
      'abc',
      new Map([['p#t', 9]]),
    )
    const n = indexDb(cache)
      .query("SELECT COUNT(*) AS n FROM task_durations WHERE source = 'remote'")
      .get() as { n: number }
    expect(n.n).toBe(1)
    expect(await forecast('feature')).toBe(7)
  } finally {
    other.close()
  }
})

// A server's `1e400` parsed as Infinity, stored, and every later run's
// schedule failed on a NaN weight: the row is INSERT OR IGNORE, so forever.
it('keeps no non-finite or negative timing or need', async () => {
  const provider = new LocalHistoryProvider(indexDb(cache), undefined, 'feature')
  provider.importTimings(
    'abc',
    new Map([
      ['p#t', Infinity],
      ['p#u', -1],
      ['p#v', 5],
      ['p#w', 6],
    ]),
    new Map([
      ['p#v', { p50DurationMs: 5, maxCpuParallelism: -3, maxPeakRssBytes: Infinity }],
      ['p#w', { p50DurationMs: 6, maxCpuParallelism: 2 }],
    ]),
  )
  record('feature', 'x', Infinity)
  record('feature', 'y', -2)
  const ids = ['p#t', 'p#u', 'p#v', 'p#w', 'p#x', 'p#y']
  expect(await provider.p50sFor(ids)).toEqual(new Map([['p#w', 6]]))
  expect(await provider.resourcesFor(ids.slice(0, 4))).toEqual(
    new Map([['p#w', { p50DurationMs: 6, maxCpuParallelism: 2 }]]),
  )
})

// A fresh CI machine has no run of a task: its need is the default
// branch's, imported with the timings, so `vx-dte` packs it.
it("a task never run here takes its need from the default branch's import", async () => {
  const provider = new LocalHistoryProvider(indexDb(cache), undefined, 'feature')
  expect(await provider.resourcesFor(['p#t'])).toEqual(new Map())
  provider.importTimings(
    'abc',
    new Map([
      ['p#t', 7],
      ['p#u', 9],
    ]),
    new Map([
      [
        'p#t',
        { p50DurationMs: 7, maxCpuParallelism: 2.5, maxPeakRssBytes: 1e9, saturatedCores: 4 },
      ],
    ]),
  )
  const got = await provider.resourcesFor(['p#t', 'p#u'])
  expect(got.get('p#t')).toEqual({
    p50DurationMs: 7,
    maxCpuParallelism: 2.5,
    maxPeakRssBytes: 1e9,
    saturatedCores: 4,
  })
  expect(got.get('p#u')).toEqual({ p50DurationMs: 9 })
})

// A hit's entry keeps its producer's CPU over its time, not its share: a
// crowded producer's reads low. Main's blob carried that forward for each
// shard that hit, and the next run packed them as tight (357d3aa).
it("a hit's producer use gives way to the default branch's measured need", async () => {
  const provider = new LocalHistoryProvider(indexDb(cache), undefined, 'feature')
  record('feature', 't', 1, true)
  indexDb(cache)
    .query(
      `INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, cpu_ms, size_bytes, created_at, accessed_at)
       VALUES ('h${seq}', 'p', 't', 'x', 0, 10000, 3000, 0, 0, 0)`,
    )
    .run()
  expect((await provider.resourcesFor(['p#t'])).get('p#t')?.maxCpuParallelism).toBe(0.3)
  provider.importTimings(
    'abc',
    new Map([['p#t', 7]]),
    new Map([['p#t', { p50DurationMs: 7, maxCpuParallelism: 1.2 }]]),
  )
  expect((await provider.resourcesFor(['p#t'])).get('p#t')?.maxCpuParallelism).toBe(1.2)
})
