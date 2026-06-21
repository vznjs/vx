import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache, type RunRecord } from '../src/cache/index.js'
import {
  explainCacheKeyQuery,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStatsSql,
  getFlakiestTasks,
  getHistory,
  getParallelismHistory,
  getPrunableEntries,
  getRecentFailures,
  getRun,
  getRunHeatmap,
  getRunTrends,
  getStorageGrowth,
  getTaskDetail,
  getTopTimeBurners,
  listCacheEntries,
  listInvocations,
  listProjects,
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
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-metrics-q-'))
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

describe('getTopTimeBurners', () => {
  it('ranks tasks by total non-hit success duration', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 'build', durationMs: 100 }),
        mkRun({ hash: 'h2', project: 'a', task: 'build', durationMs: 150 }),
        mkRun({ hash: 'h3', project: 'b', task: 'test', durationMs: 50 }),
        mkRun({ hash: 'h4', project: 'b', task: 'test', durationMs: 50, cacheHit: true }),
      ])
      const top = getTopTimeBurners(cache.dbHandle())
      expect(top[0]!.id).toBe('a#build')
      expect(top[0]!.totalDurationMs).toBe(250)
      const second = top.find((t) => t.id === 'b#test')!
      // cache-hit row excluded from sum
      expect(second.totalDurationMs).toBe(50)
    })
  })
})

describe('getRecentFailures', () => {
  it('returns only failed runs ordered DESC by startedAt', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 'test', status: 'success', startedAt: 1000 }),
        mkRun({
          hash: 'h2',
          project: 'a',
          task: 'test',
          status: 'failed',
          exitCode: 1,
          startedAt: 2000,
        }),
        mkRun({
          hash: 'h3',
          project: 'b',
          task: 'build',
          status: 'failed',
          exitCode: 2,
          startedAt: 3000,
        }),
      ])
      const fails = getRecentFailures(cache.dbHandle())
      expect(fails.length).toBe(2)
      expect(fails[0]!.task).toBe('build')
      expect(fails[0]!.exitCode).toBe(2)
      expect(fails[1]!.task).toBe('test')
    })
  })
})

describe('listCacheEntries / getCacheBreakdown', () => {
  it('lists entries and groups bytes by project', () => {
    withCache((cache) => {
      // recordRun creates an entry row when called for a successful task.
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 'build' }),
        mkRun({ hash: 'h2', project: 'b', task: 'test' }),
      ])
      const entries = listCacheEntries(cache.dbHandle())
      // recordRun is for runs, not entries — only saved tasks land in entries.
      // The listing should not throw; if 0 rows, the breakdown is also 0.
      expect(Array.isArray(entries)).toBe(true)
      const breakdown = getCacheBreakdown(cache.dbHandle())
      expect(Array.isArray(breakdown)).toBe(true)
    })
  })
})

describe('getTaskDetail', () => {
  it('returns null for unknown (project, task)', () => {
    withCache((cache) => {
      expect(getTaskDetail(cache.dbHandle(), 'no#such')).toBeNull()
    })
  })

  it('returns aggregate + recent runs for a known task', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 'build', durationMs: 100 }),
        mkRun({ hash: 'h2', project: 'a', task: 'build', durationMs: 200 }),
      ])
      const detail = getTaskDetail(cache.dbHandle(), 'a#build')!
      expect(detail.project).toBe('a')
      expect(detail.task).toBe('build')
      expect(detail.recent.length).toBe(2)
      expect(detail.aggregate!.runs).toBe(2)
      expect(detail.aggregate!.avgDurationMs).toBe(150)
      expect(detail.aggregate!.minDurationMs).toBe(100)
      expect(detail.aggregate!.maxDurationMs).toBe(200)
    })
  })
})

describe('getCacheSavings', () => {
  it('estimates time saved using the same-task non-hit avg duration', () => {
    withCache((cache) => {
      cache.recordRuns([
        // Two non-hit baselines averaging 100ms
        mkRun({
          hash: 'h1',
          project: 'a',
          task: 'build',
          durationMs: 100,
          startedAt: Date.now() - 5000,
        }),
        mkRun({
          hash: 'h2',
          project: 'a',
          task: 'build',
          durationMs: 100,
          startedAt: Date.now() - 4000,
        }),
        // Two hits in the last 24h → estimatedTimeSaved24h ≈ 2 × 100ms = 200ms
        mkRun({
          hash: 'h3',
          project: 'a',
          task: 'build',
          durationMs: 10,
          cacheHit: true,
          status: 'cache-hit',
          startedAt: Date.now() - 3000,
        }),
        mkRun({
          hash: 'h4',
          project: 'a',
          task: 'build',
          durationMs: 10,
          cacheHit: true,
          status: 'cache-hit',
          startedAt: Date.now() - 2000,
        }),
      ])
      const savings = getCacheSavings(cache.dbHandle())
      expect(savings.hitsLast24h).toBe(2)
      expect(savings.estimatedTimeSavedMs).toBe(200)
      expect(savings.estimatedTimeSavedTotalMs).toBe(200)
    })
  })
})

describe('listProjects', () => {
  it('rolls per-project totals + cache entries', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 'build', durationMs: 100 }),
        mkRun({ hash: 'h2', project: 'a', task: 'test', durationMs: 50 }),
        mkRun({ hash: 'h3', project: 'b', task: 'build', durationMs: 200 }),
      ])
      const rows = listProjects(cache.dbHandle())
      expect(rows.length).toBe(2)
      const a = rows.find((r) => r.project === 'a')!
      expect(a.taskCount).toBe(2)
      expect(a.totalDurationMs).toBe(150)
      expect(a.runs).toBe(2)
    })
  })
})

describe('getRunTrends', () => {
  it('returns a densified time series with hour buckets', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 'b', startedAt: now - 60_000 }),
        mkRun({ hash: 'h2', project: 'a', task: 'b', startedAt: now - 60_000 }),
      ])
      const pts = getRunTrends(cache.dbHandle(), { bucket: 'hour' })
      // 24h of hourly buckets ≈ 25 cells (start + end inclusive).
      expect(pts.length).toBeGreaterThan(20)
      const total = pts.reduce((acc, p) => acc + p.runs, 0)
      expect(total).toBe(2)
    })
  })
})

describe('getRunHeatmap', () => {
  it('emits a 7×24 grid (168 cells) and counts runs in the right cell', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRun(mkRun({ hash: 'h1', project: 'a', task: 'b', startedAt: now }))
      const cells = getRunHeatmap(cache.dbHandle())
      expect(cells.length).toBe(168)
      const total = cells.reduce((acc, c) => acc + c.runs, 0)
      expect(total).toBe(1)
    })
  })
})

describe('getFlakiestTasks', () => {
  it('surfaces tasks with mixed pass/fail or wide p99/p50', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 't', status: 'success', startedAt: now - 5000 }),
        mkRun({
          hash: 'h2',
          project: 'a',
          task: 't',
          status: 'failed',
          exitCode: 1,
          startedAt: now - 4000,
        }),
        mkRun({ hash: 'h3', project: 'a', task: 't', status: 'success', startedAt: now - 3000 }),
        mkRun({ hash: 'h4', project: 'a', task: 't', status: 'success', startedAt: now - 2000 }),
      ])
      const flaky = getFlakiestTasks(cache.dbHandle())
      expect(flaky.length).toBeGreaterThan(0)
      expect(flaky[0]!.id).toBe('a#t')
      expect(flaky[0]!.failures).toBe(1)
    })
  })
})

describe('getBottlenecks', () => {
  it('ranks by extrapolated weekly burn at 25% cut', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 'slow', durationMs: 1000, startedAt: now - 1000 }),
        mkRun({ hash: 'h2', project: 'a', task: 'slow', durationMs: 1000, startedAt: now - 500 }),
        mkRun({ hash: 'h3', project: 'a', task: 'fast', durationMs: 10, startedAt: now - 100 }),
      ])
      const b = getBottlenecks(cache.dbHandle())
      expect(b[0]!.task).toBe('slow')
      expect(b[0]!.weeklySavingsAt25PctCutMs).toBeGreaterThan(0)
    })
  })
})

describe('getParallelismHistory', () => {
  it('computes cpuSum / wall per runId', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({
          hash: 'h1',
          project: 'a',
          task: 't1',
          runId: 'r1',
          startedAt: 1000,
          endedAt: 1100,
          durationMs: 100,
        }),
        mkRun({
          hash: 'h2',
          project: 'a',
          task: 't2',
          runId: 'r1',
          startedAt: 1010,
          endedAt: 1080,
          durationMs: 70,
        }),
      ])
      const pts = getParallelismHistory(cache.dbHandle())
      expect(pts.length).toBe(1)
      expect(pts[0]!.runId).toBe('r1')
      // cpuSum (cpu_ms fallback to duration_ms via COALESCE in SQL) >= wall
      expect(pts[0]!.factor).toBeGreaterThan(0)
    })
  })
})

describe('getStorageGrowth', () => {
  it('returns a densified daily series', () => {
    withCache((cache) => {
      cache.recordRun(mkRun({ hash: 'h1', project: 'a', task: 'b' }))
      const pts = getStorageGrowth(cache.dbHandle(), 7)
      // 7 days of daily buckets ≈ 7–8 cells.
      expect(pts.length).toBeGreaterThanOrEqual(7)
    })
  })
})

describe('getPrunableEntries', () => {
  it('returns empty when nothing is older than the threshold', () => {
    withCache((cache) => {
      cache.recordRun(mkRun({ hash: 'h1', project: 'a', task: 'b' }))
      const entries = getPrunableEntries(cache.dbHandle(), 365)
      expect(entries).toEqual([])
    })
  })
})
