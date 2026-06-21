import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { EmptyHistoryProvider, LocalHistoryProvider } from '../src/orchestrator/index.js'

function mkRun(args: {
  hash: string
  project: string
  task: string
  status: 'success' | 'failed' | 'skipped' | 'aborted'
  cacheHit?: boolean
  durationMs: number
  startedAt: number
}) {
  return {
    hash: args.hash,
    project: args.project,
    task: args.task,
    status: args.status,
    exitCode: args.status === 'success' ? 0 : 1,
    durationMs: args.durationMs,
    forwardArgs: '',
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
    return new Cache(cacheDir, '/ws')
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
      // 1 failure of 6 → flaky-recoverable (< 1/5)
      expect(entry!.failureMode).toBe('flaky-recoverable')
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
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
