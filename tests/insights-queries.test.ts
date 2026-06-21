import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache, type RunRecord } from '../src/cache/index.js'
import {
  explainCacheKeyQuery,
  getCacheStatsSql,
  getHistory,
  getRun,
  listInvocations,
  listRuns,
  whyDidThisRerunQuery,
} from '../src/orchestrator/index.js'

function mkRun(
  args: Partial<RunRecord> & { hash: string; project: string; task: string },
): RunRecord {
  return {
    hash: args.hash,
    project: args.project,
    task: args.task,
    status: args.status ?? 'success',
    exitCode: args.exitCode ?? 0,
    durationMs: args.durationMs ?? 100,
    forwardArgs: [],
    startedAt: args.startedAt ?? Date.now() - 1000,
    endedAt: args.endedAt ?? Date.now() - 900,
    runId: args.runId ?? 'r-1',
    cpuMs: 50,
    peakRssBytes: 0,
    wallclockStartNs: 0n,
    wallclockEndNs: 0n,
    cacheHit: args.cacheHit ?? false,
  }
}

function withCache(fn: (cache: Cache) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-insights-q-'))
  const cache = new Cache(dir)
  try {
    fn(cache)
  } finally {
    cache.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('listRuns', () => {
  it('orders by started_at DESC and applies limit', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'pkg', task: 'build', startedAt: 1000 }),
        mkRun({ hash: 'h2', project: 'pkg', task: 'build', startedAt: 2000 }),
        mkRun({ hash: 'h3', project: 'pkg', task: 'build', startedAt: 3000 }),
      ])
      const rows = listRuns(cache.dbHandle(), { limit: 2 })
      expect(rows.length).toBe(2)
      expect(rows[0]!.hash).toBe('h3')
      expect(rows[1]!.hash).toBe('h2')
    })
  })

  it('filters by project + task + runId', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'pkg', task: 'build', runId: 'r-1' }),
        mkRun({ hash: 'h2', project: 'pkg', task: 'test', runId: 'r-1' }),
        mkRun({ hash: 'h3', project: 'other', task: 'build', runId: 'r-2' }),
      ])
      expect(listRuns(cache.dbHandle(), { project: 'pkg' }).length).toBe(2)
      expect(listRuns(cache.dbHandle(), { task: 'build' }).length).toBe(2)
      expect(listRuns(cache.dbHandle(), { runId: 'r-1' }).length).toBe(2)
      expect(listRuns(cache.dbHandle(), { project: 'pkg', task: 'test' }).length).toBe(1)
    })
  })
})

describe('listInvocations', () => {
  it('groups by run_id with per-invocation aggregates', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({
          hash: 'h1',
          project: 'pkg',
          task: 'build',
          runId: 'r-1',
          startedAt: 1000,
          durationMs: 100,
        }),
        mkRun({
          hash: 'h2',
          project: 'pkg',
          task: 'test',
          runId: 'r-1',
          startedAt: 1100,
          durationMs: 200,
          status: 'failed',
        }),
        mkRun({
          hash: 'h3',
          project: 'pkg',
          task: 'build',
          runId: 'r-2',
          startedAt: 2000,
          durationMs: 50,
          cacheHit: true,
          status: 'cache-hit',
        }),
      ])
      const rows = listInvocations(cache.dbHandle())
      expect(rows.length).toBe(2)
      const r1 = rows.find((r) => r.runId === 'r-1')!
      expect(r1.taskCount).toBe(2)
      expect(r1.failedCount).toBe(1)
      expect(r1.totalDurationMs).toBe(300)
      const r2 = rows.find((r) => r.runId === 'r-2')!
      expect(r2.hitCount).toBe(1)
    })
  })
})

describe('getRun', () => {
  it('returns null for an unknown runId', () => {
    withCache((cache) => {
      expect(getRun(cache.dbHandle(), 'unknown')).toBeNull()
    })
  })

  it('returns run-level start/end derived from tasks', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({
          hash: 'h1',
          project: 'pkg',
          task: 'build',
          runId: 'r-1',
          startedAt: 1000,
          endedAt: 1100,
        }),
        mkRun({
          hash: 'h2',
          project: 'pkg',
          task: 'test',
          runId: 'r-1',
          startedAt: 1200,
          endedAt: 1300,
        }),
      ])
      const detail = getRun(cache.dbHandle(), 'r-1')!
      expect(detail.startedAt).toBe(1000)
      expect(detail.endedAt).toBe(1300)
      expect(detail.tasks.length).toBe(2)
    })
  })
})

describe('getCacheStatsSql', () => {
  it('counts entries + computes hit rate from runs in last 24h', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({
          hash: 'h1',
          project: 'pkg',
          task: 'build',
          status: 'success',
          startedAt: Date.now() - 1000,
        }),
        mkRun({
          hash: 'h2',
          project: 'pkg',
          task: 'build',
          status: 'cache-hit',
          startedAt: Date.now() - 500,
        }),
      ])
      const stats = getCacheStatsSql(cache.dbHandle())
      expect(stats.runCountLast24h).toBe(2)
      expect(stats.hitCountLast24h).toBe(1)
      expect(stats.hitRate24h).toBeCloseTo(0.5)
    })
  })
})

describe('getHistory', () => {
  it('rolls (project, task) aggregates with failureMode classification', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns(
        Array.from({ length: 6 }, (_, i) =>
          mkRun({
            hash: `h${i}`,
            project: 'pkg',
            task: 'test',
            status: i === 5 ? 'failed' : 'success',
            startedAt: now - 1000 * (6 - i),
            durationMs: 100 + i * 50,
          }),
        ),
      )
      const rows = getHistory(cache.dbHandle(), { project: 'pkg', task: 'test' })
      expect(rows.length).toBe(1)
      expect(rows[0]!.id).toBe('pkg#test')
      expect(rows[0]!.runs).toBe(6)
      expect(rows[0]!.successRate).toBeCloseTo(5 / 6, 5)
      expect(rows[0]!.failureMode).toBe('flaky-recoverable')
      expect(rows[0]!.p50DurationMs).toBeGreaterThan(0)
    })
  })
})

describe('explainCacheKeyQuery', () => {
  it('returns the most recent entries row for a (project, task)', () => {
    withCache((cache) => {
      cache.recordRun(mkRun({ hash: 'h1', project: 'pkg', task: 'build', status: 'success' }))
      const explained = explainCacheKeyQuery(cache.dbHandle(), 'pkg#build')
      expect(explained.taskId).toBe('pkg#build')
      expect(explained.project).toBe('pkg')
      expect(explained.task).toBe('build')
    })
  })
})

describe('whyDidThisRerunQuery', () => {
  it('compares hash between this and previous run', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
        mkRun({ hash: 'h2', project: 'pkg', task: 'test', runId: 'r-2', startedAt: 2000 }),
      ])
      const result = whyDidThisRerunQuery(cache.dbHandle(), 'r-2', 'pkg#test')
      expect(result.found).toBe(true)
      expect(result.thisRun!.hash).toBe('h2')
      expect(result.previousRun!.hash).toBe('h1')
      expect(result.hashChanged).toBe(true)
    })
  })

  it('returns found=false for an unknown runId', () => {
    withCache((cache) => {
      const result = whyDidThisRerunQuery(cache.dbHandle(), 'r-x', 'pkg#test')
      expect(result.found).toBe(false)
    })
  })
})
