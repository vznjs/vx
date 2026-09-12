import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'
import { EmptyHistoryProvider, LocalHistoryProvider } from '../src/orchestrator/index.js'

function mkRun(args: {
  hash: string
  project: string
  task: string
  status: RunRecord['status']
  cacheHit?: boolean
  durationMs: number
  startedAt: number
}): RunRecord {
  return {
    hash: args.hash,
    project: args.project,
    task: args.task,
    status: args.status,
    exitCode: args.status === 'success' ? 0 : 1,
    durationMs: args.durationMs,
    forwardArgs: [],
    startedAt: args.startedAt,
    endedAt: args.startedAt + args.durationMs,
    runId: 'r-' + args.startedAt,
    cpuMs: args.durationMs,
    peakRssBytes: 0,
    wallclockStartNs: BigInt(args.startedAt) * 1_000_000n,
    wallclockEndNs: BigInt(args.startedAt + args.durationMs) * 1_000_000n,
    cacheHit: args.cacheHit ?? false,
  }
}

/** A minimal invocation header; the window is counted in these. */
function mkInvocation(runId: string, startedAt: number): InvocationRecord {
  return {
    runId,
    command: 'vx run test',
    requestedTasks: JSON.stringify(['test']),
    cachePolicy: 'lR,lW',
    concurrency: 1,
    flow: null,
    startedAt,
    endedAt: startedAt + 10,
    totalDurationMs: 10,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
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

/** One invocation per row, so each row is its own slot in the window. */
function recordAsInvocations(cache: Cache, rows: readonly RunRecord[]): void {
  for (const row of rows) {
    cache.recordRunBundle({
      runs: [{ ...row, runId: `inv-${row.startedAt}` }],
      invocation: mkInvocation(`inv-${row.startedAt}`, row.startedAt),
    })
  }
}

describe('EmptyHistoryProvider', () => {
  it('returns an empty map for any input', async () => {
    const p = new EmptyHistoryProvider()
    expect((await p.loadFor(['a#b', 'c#d'])).size).toBe(0)
  })
})

describe('LocalHistoryProvider', () => {
  let cacheDir: string
  function makeCache(): Cache {
    cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-history-'))
    return new Cache(cacheDir)
  }

  it('aggregates success/failure/hit counts over recent runs', async () => {
    const cache = makeCache()
    try {
      // 5 successes (3 hits, 2 executed); 1 failed run.
      const rows = [
        mkRun({
          hash: 'h1',
          project: 'pkg',
          task: 'test',
          status: 'success',
          cacheHit: true,
          durationMs: 100,
          startedAt: 1000,
        }),
        mkRun({
          hash: 'h2',
          project: 'pkg',
          task: 'test',
          status: 'success',
          cacheHit: true,
          durationMs: 100,
          startedAt: 2000,
        }),
        mkRun({
          hash: 'h3',
          project: 'pkg',
          task: 'test',
          status: 'success',
          cacheHit: true,
          durationMs: 100,
          startedAt: 3000,
        }),
        mkRun({
          hash: 'h4',
          project: 'pkg',
          task: 'test',
          status: 'success',
          cacheHit: false,
          durationMs: 500,
          startedAt: 4000,
        }),
        mkRun({
          hash: 'h5',
          project: 'pkg',
          task: 'test',
          status: 'success',
          cacheHit: false,
          durationMs: 700,
          startedAt: 5000,
        }),
        mkRun({
          hash: 'h6',
          project: 'pkg',
          task: 'test',
          status: 'failed',
          cacheHit: false,
          durationMs: 200,
          startedAt: 6000,
        }),
      ]
      cache.recordRuns(rows)
      const provider = new LocalHistoryProvider((cache as unknown as { db: any }).db)
      const table = await provider.loadFor(['pkg#test'])
      const entry = table.get('pkg#test')
      expect(entry).toBeDefined()
      expect(entry!.runs).toBe(6)
      expect(entry!.successRate).toBeCloseTo(5 / 6, 5)
      expect(entry!.hitRate).toBeCloseTo(3 / 6, 5)
      // p50 + p99 use executed-success rows only: durations [500, 700]
      expect(entry!.p50DurationMs).toBeGreaterThan(0)
      expect(entry!.p99DurationMs).toBeGreaterThan(0)
      // Every run sits on its OWN cache key and none was retried, so the lone
      // failure is a legitimate break, not flakiness.
      expect(entry!.failureMode).toBe('stable')
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('reports a within-run retry as flaky even with zero failed rows', async () => {
    const cache = makeCache()
    try {
      const now = Date.now()
      cache.recordRuns([
        // The run went green, but only on attempt 2 — nondeterminism proven
        // by the retry, with no failed row anywhere to infer it from.
        {
          ...mkRun({
            hash: 'r1',
            project: 'pkg',
            task: 'test',
            status: 'success',
            durationMs: 10,
            startedAt: now - 1000,
          }),
          attempts: 2,
        },
      ])
      const db = (cache as unknown as { db: Database }).db
      const entry = (await new LocalHistoryProvider(db).loadFor(['pkg#test'])).get('pkg#test')
      expect(entry!.failureMode).not.toBe('stable')
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('computes per-task percentiles independently across MANY tasks (batched, no cross-contamination)', async () => {
    const cache = makeCache()
    try {
      // Two tasks with distinct executed-success duration sets, interleaved
      // with cache-hits + failures that must NOT enter the percentiles. If the
      // batched windowed query failed to PARTITION BY task, task B's big
      // durations would leak into A's percentiles (and vice versa).
      const rows: RunRecord[] = [
        // pkg#build executed-success: 100, 300, 200 → sorted [100,200,300]
        mkRun({
          hash: 'a1',
          project: 'pkg',
          task: 'build',
          status: 'success',
          durationMs: 100,
          startedAt: 1000,
        }),
        mkRun({
          hash: 'a2',
          project: 'pkg',
          task: 'build',
          status: 'success',
          durationMs: 300,
          startedAt: 2000,
        }),
        mkRun({
          hash: 'a3',
          project: 'pkg',
          task: 'build',
          status: 'success',
          durationMs: 200,
          startedAt: 3000,
        }),
        // excluded from build percentiles: a cache hit + a failure
        mkRun({
          hash: 'a4',
          project: 'pkg',
          task: 'build',
          status: 'success',
          cacheHit: true,
          durationMs: 5,
          startedAt: 3500,
        }),
        mkRun({
          hash: 'a5',
          project: 'pkg',
          task: 'build',
          status: 'failed',
          durationMs: 999,
          startedAt: 3600,
        }),
        // pkg#test executed-success: 1000, 2000 → sorted [1000,2000]
        mkRun({
          hash: 'b1',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 1000,
          startedAt: 1500,
        }),
        mkRun({
          hash: 'b2',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 2000,
          startedAt: 2500,
        }),
      ]
      cache.recordRuns(rows)
      const provider = new LocalHistoryProvider((cache as unknown as { db: any }).db)
      const table = await provider.loadFor(['pkg#build', 'pkg#test'])
      const build = table.get('pkg#build')!
      const test = table.get('pkg#test')!
      // pickPercentile(sorted, q) = sorted[min(len-1, floor(q*len))]
      expect(build.p50DurationMs).toBe(200) // [100,200,300][1]
      expect(build.p99DurationMs).toBe(300) // [100,200,300][2]
      expect(test.p50DurationMs).toBe(2000) // [1000,2000][1]
      expect(test.p99DurationMs).toBe(2000) // [1000,2000][1]
      // Counts include hits/failures; build: 5 rows (1 hit), 1 fail.
      expect(build.runs).toBe(5)
      expect(build.hitRate).toBeCloseTo(1 / 5, 5)
      expect(test.runs).toBe(2)
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('windows on the last `recent` INVOCATIONS, not the whole table', async () => {
    const cache = makeCache()
    try {
      // Five invocations, one row each; the oldest two carry the outliers
      // (a failure and a slow success) that a whole-table read would count.
      recordAsInvocations(cache, [
        mkRun({
          hash: 'a',
          project: 'pkg',
          task: 'test',
          status: 'failed',
          durationMs: 9000,
          startedAt: 1000,
        }),
        mkRun({
          hash: 'b',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 9000,
          startedAt: 2000,
        }),
        mkRun({
          hash: 'c',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 100,
          startedAt: 3000,
        }),
        mkRun({
          hash: 'd',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 100,
          startedAt: 4000,
        }),
        mkRun({
          hash: 'e',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 100,
          startedAt: 5000,
        }),
      ])
      const db = (cache as unknown as { db: Database }).db
      const windowed = (await new LocalHistoryProvider(db, 3).loadFor(['pkg#test'])).get(
        'pkg#test',
      )!
      expect(windowed.runs).toBe(3)
      expect(windowed.successRate).toBe(1)
      expect(windowed.p99DurationMs).toBe(100)
      // Control: a window wide enough to reach the outliers sees them.
      const wide = (await new LocalHistoryProvider(db, 5).loadFor(['pkg#test'])).get('pkg#test')!
      expect(wide.runs).toBe(5)
      expect(wide.successRate).toBeCloseTo(4 / 5, 5)
      expect(wide.p99DurationMs).toBe(9000)
      // The unit is the INVOCATION: two later runs that never touched the
      // task still take two of the three slots, leaving it one row — a
      // per-pair "last 3 rows" read would report three.
      recordAsInvocations(cache, [
        mkRun({
          hash: 'x',
          project: 'other',
          task: 'lint',
          status: 'success',
          durationMs: 1,
          startedAt: 6000,
        }),
        mkRun({
          hash: 'y',
          project: 'other',
          task: 'lint',
          status: 'success',
          durationMs: 1,
          startedAt: 7000,
        }),
      ])
      const crowded = (await new LocalHistoryProvider(db, 3).loadFor(['pkg#test'])).get('pkg#test')!
      expect(crowded.runs).toBe(1)
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('takes the flakiness signal from the same window as the rates', async () => {
    const cache = makeCache()
    try {
      // Key K failed and then passed — the definitional flake — but both rows
      // sit outside a 2-invocation window; inside it, one failure on its own
      // key is a legitimate break.
      recordAsInvocations(cache, [
        mkRun({
          hash: 'K',
          project: 'pkg',
          task: 'test',
          status: 'failed',
          durationMs: 10,
          startedAt: 1000,
        }),
        mkRun({
          hash: 'K',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 10,
          startedAt: 2000,
        }),
        mkRun({
          hash: 'L',
          project: 'pkg',
          task: 'test',
          status: 'failed',
          durationMs: 10,
          startedAt: 3000,
        }),
        mkRun({
          hash: 'M',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 10,
          startedAt: 4000,
        }),
      ])
      const db = (cache as unknown as { db: Database }).db
      expect(
        (await new LocalHistoryProvider(db, 2).loadFor(['pkg#test'])).get('pkg#test')!.failureMode,
      ).toBe('stable')
      // Control: the whole history sees K's mixed outcome.
      expect(
        (await new LocalHistoryProvider(db, 4).loadFor(['pkg#test'])).get('pkg#test')!.failureMode,
      ).not.toBe('stable')
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('answers for every requested pair in the slice and nothing else', async () => {
    const cache = makeCache()
    try {
      recordAsInvocations(cache, [
        mkRun({
          hash: 'a',
          project: 'pkg',
          task: 'build',
          status: 'success',
          durationMs: 10,
          startedAt: 1000,
        }),
        mkRun({
          hash: 'b',
          project: 'pkg',
          task: 'test',
          status: 'success',
          durationMs: 10,
          startedAt: 2000,
        }),
        mkRun({
          hash: 'c',
          project: 'other',
          task: 'build',
          status: 'success',
          durationMs: 10,
          startedAt: 3000,
        }),
      ])
      const db = (cache as unknown as { db: Database }).db
      const table = await new LocalHistoryProvider(db, 10).loadFor([
        'pkg#build',
        'other#build',
        'nope#x',
      ])
      expect([...table.keys()].sort()).toEqual(['other#build', 'pkg#build'])
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('reports the largest peak RSS and CPU parallelism an execution in the window used', async () => {
    // What a reservation learned from history packs on: the maximum, not
    // the mean (the OOM killer reads the maximum), over successful
    // executions only — a hit reports nothing and a failure's usage is
    // not what the task needs to succeed.
    const cache = makeCache()
    const base = 1_000_000
    const unreported = (r: RunRecord): RunRecord => {
      const { peakRssBytes: _rss, cpuMs: _cpu, ...rest } = r
      return rest
    }
    const row = (i: number, extra: Partial<RunRecord>): RunRecord => ({
      ...mkRun({
        hash: `h${i}`,
        project: 'a',
        task: 'build',
        status: 'success',
        durationMs: 1000,
        startedAt: base + i * 100,
      }),
      ...extra,
    })
    recordAsInvocations(cache, [
      row(1, { peakRssBytes: 300 * 1024 * 1024, cpuMs: 1500 }),
      row(2, { peakRssBytes: 900 * 1024 * 1024, cpuMs: 2600 }),
      row(3, { peakRssBytes: 100 * 1024 * 1024, cpuMs: 800 }),
      // A failed execution's usage is not evidence.
      row(4, { status: 'failed', exitCode: 1, peakRssBytes: 5000 * 1024 * 1024, cpuMs: 9000 }),
      // A hit executed nothing; its zeros must not pull the maximum down or up.
      row(5, { cacheHit: true, peakRssBytes: 0, cpuMs: 0 }),
      // A task that never reported usage answers undefined, not 0.
      unreported(
        mkRun({
          hash: 'h6',
          project: 'b',
          task: 'build',
          status: 'success',
          durationMs: 50,
          startedAt: base + 600,
        }),
      ),
    ])
    const table = await new LocalHistoryProvider(cache.dbHandle(), 10).loadFor([
      'a#build',
      'b#build',
    ])
    expect(table.get('a#build')?.maxPeakRssBytes).toBe(900 * 1024 * 1024)
    expect(table.get('a#build')?.maxCpuParallelism).toBeCloseTo(2.6, 5)
    expect(table.get('b#build')?.maxPeakRssBytes).toBeUndefined()
    expect(table.get('b#build')?.maxCpuParallelism).toBeUndefined()
    cache.close()
  })

  it('returns nothing for tasks with no prior runs', async () => {
    const cache = makeCache()
    try {
      const provider = new LocalHistoryProvider((cache as unknown as { db: any }).db)
      const table = await provider.loadFor(['nope#nada'])
      expect(table.size).toBe(0)
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('classifies as stable when 0 failures', async () => {
    const cache = makeCache()
    try {
      const rows = Array.from({ length: 5 }, (_, i) =>
        mkRun({
          hash: 'h' + i,
          project: 'pkg',
          task: 'lint',
          status: 'success',
          cacheHit: false,
          durationMs: 200,
          startedAt: 1000 * i + 1000,
        }),
      )
      cache.recordRuns(rows)
      const provider = new LocalHistoryProvider((cache as unknown as { db: any }).db)
      const table = await provider.loadFor(['pkg#lint'])
      expect(table.get('pkg#lint')!.failureMode).toBe('stable')
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })
})
