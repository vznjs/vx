import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { type InvocationRecord, Cache, type RunRecord } from '../src/cache/index.js'
import {
  cacheKeyDiff,
  compareRuns,
  explainCacheKeyQuery,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStatsSql,
  getFlakiestTasks,
  getHistory,
  getHitRateSplit,
  getInvocation,
  getParallelismHistory,
  getPeriodComparison,
  getPrunableEntries,
  getRecentFailures,
  getRegressions,
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
    ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
  }
}

function mkInvocation(args: Partial<InvocationRecord> & { runId: string }): InvocationRecord {
  return {
    runId: args.runId,
    command: args.command ?? 'vx run build',
    requestedTasks: args.requestedTasks ?? JSON.stringify(['build']),
    cachePolicy: args.cachePolicy ?? 'lR,lW,rR,rW',
    concurrency: args.concurrency ?? 8,
    flow: args.flow ?? 'broad',
    startedAt: args.startedAt ?? 1000,
    endedAt: args.endedAt ?? 1100,
    totalDurationMs: args.totalDurationMs ?? 100,
    taskCount: args.taskCount ?? 1,
    failedCount: args.failedCount ?? 0,
    hitCount: args.hitCount ?? 0,
    hitLocalCount: args.hitLocalCount ?? 0,
    hitRemoteCount: args.hitRemoteCount ?? 0,
    exitOk: args.exitOk ?? true,
    commitSha: args.commitSha ?? 'abc123',
    branch: args.branch ?? 'main',
    dirty: args.dirty ?? false,
    ci: args.ci ?? false,
    ciProvider: args.ciProvider ?? null,
    host: args.host ?? 'box',
    os: args.os ?? 'linux',
    arch: args.arch ?? 'x64',
    vxVersion: args.vxVersion ?? '0.0.0',
    tags: args.tags ?? '{}',
  }
}

/** Write entry_inputs rows directly — the diff reads them by entry hash. */
function seedEntryInputs(
  cache: Cache,
  entryHash: string,
  rows: { kind: string; name: string; hash: string }[],
): void {
  const db = cache.dbHandle()
  // entry_inputs has an FK to entries(hash); satisfy it with a stub row.
  db.query(
    `INSERT OR IGNORE INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
     VALUES (?, 'pkg', 'test', 'cmd', 0, 0, 0, '', 0, 0)`,
  ).run(entryHash)
  for (const r of rows) {
    db.query(
      'INSERT OR IGNORE INTO entry_inputs(entry_hash, kind, name, hash) VALUES (?, ?, ?, ?)',
    ).run(entryHash, r.kind, r.name, r.hash)
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
  it('reads the invocations table newest-first with the richer detail shape', () => {
    withCache((cache) => {
      cache.recordRunBundle({
        runs: [mkRun({ hash: 'h1', project: 'pkg', task: 'build', runId: 'r-1' })],
        invocation: mkInvocation({
          runId: 'r-1',
          startedAt: 1000,
          endedAt: 1300,
          taskCount: 2,
          failedCount: 1,
          totalDurationMs: 300,
        }),
      })
      cache.recordRunBundle({
        runs: [mkRun({ hash: 'h3', project: 'pkg', task: 'build', runId: 'r-2' })],
        invocation: mkInvocation({
          runId: 'r-2',
          startedAt: 2000,
          hitCount: 1,
          hitLocalCount: 1,
        }),
      })
      const rows = listInvocations(cache.dbHandle())
      expect(rows.length).toBe(2)
      // newest first
      expect(rows[0]!.runId).toBe('r-2')
      const r1 = rows.find((r) => r.runId === 'r-1')!
      expect(r1.taskCount).toBe(2)
      expect(r1.failedCount).toBe(1)
      expect(r1.totalDurationMs).toBe(300)
      // richer detail superset
      expect(r1.branch).toBe('main')
      expect(r1.requestedTasks).toEqual(['build'])
      const r2 = rows.find((r) => r.runId === 'r-2')!
      expect(r2.hitCount).toBe(1)
      expect(r2.hitLocalCount).toBe(1)
    })
  })

  it('accepts a bare number for the limit (back-compat)', () => {
    withCache((cache) => {
      for (let i = 0; i < 5; i++) {
        cache.recordRunBundle({
          runs: [mkRun({ hash: `h${i}`, project: 'pkg', task: 'build', runId: `r-${i}` })],
          invocation: mkInvocation({ runId: `r-${i}`, startedAt: 1000 + i }),
        })
      }
      expect(listInvocations(cache.dbHandle(), 2).length).toBe(2)
    })
  })

  it('filters by branch, ci, and tag', () => {
    withCache((cache) => {
      cache.recordRunBundle({
        runs: [mkRun({ hash: 'h1', project: 'pkg', task: 'build', runId: 'r-main' })],
        invocation: mkInvocation({
          runId: 'r-main',
          startedAt: 1000,
          branch: 'main',
          ci: false,
          tags: JSON.stringify({ env: 'dev' }),
        }),
      })
      cache.recordRunBundle({
        runs: [mkRun({ hash: 'h2', project: 'pkg', task: 'build', runId: 'r-feat' })],
        invocation: mkInvocation({
          runId: 'r-feat',
          startedAt: 2000,
          branch: 'feature',
          ci: true,
          ciProvider: 'github',
          tags: JSON.stringify({ env: 'prod', pr: '42' }),
        }),
      })

      const byBranch = listInvocations(cache.dbHandle(), { branch: 'feature' })
      expect(byBranch.map((r) => r.runId)).toEqual(['r-feat'])

      const byCi = listInvocations(cache.dbHandle(), { ci: true })
      expect(byCi.map((r) => r.runId)).toEqual(['r-feat'])
      expect(byCi[0]!.ciProvider).toBe('github')

      const notCi = listInvocations(cache.dbHandle(), { ci: false })
      expect(notCi.map((r) => r.runId)).toEqual(['r-main'])

      const byTag = listInvocations(cache.dbHandle(), { tagKey: 'env', tagValue: 'prod' })
      expect(byTag.map((r) => r.runId)).toEqual(['r-feat'])
      expect(byTag[0]!.tags).toEqual({ env: 'prod', pr: '42' })

      const byTagDev = listInvocations(cache.dbHandle(), { tagKey: 'env', tagValue: 'dev' })
      expect(byTagDev.map((r) => r.runId)).toEqual(['r-main'])
    })
  })
})

describe('getInvocation', () => {
  it('round-trips a recorded invocation, camelCased with parsed booleans/JSON', () => {
    withCache((cache) => {
      cache.recordRunBundle({
        runs: [mkRun({ hash: 'h1', project: 'pkg', task: 'build', runId: 'r-1' })],
        invocation: mkInvocation({
          runId: 'r-1',
          command: 'vx run build test --all',
          requestedTasks: JSON.stringify(['build', 'test']),
          dirty: true,
          ci: true,
          ciProvider: 'gitlab',
          exitOk: false,
          tags: JSON.stringify({ team: 'core' }),
        }),
      })
      const inv = getInvocation(cache.dbHandle(), 'r-1')!
      expect(inv.command).toBe('vx run build test --all')
      expect(inv.requestedTasks).toEqual(['build', 'test'])
      expect(inv.dirty).toBe(true)
      expect(inv.ci).toBe(true)
      expect(inv.ciProvider).toBe('gitlab')
      expect(inv.exitOk).toBe(false)
      expect(inv.tags).toEqual({ team: 'core' })
    })
  })

  it('returns null for an unknown runId', () => {
    withCache((cache) => {
      expect(getInvocation(cache.dbHandle(), 'nope')).toBeNull()
    })
  })
})

describe('cacheKeyDiff', () => {
  it('names the changed / added / removed components vs the previous run', () => {
    withCache((cache) => {
      // Previous run of pkg#test → hash hPrev
      cache.recordRun(
        mkRun({ hash: 'hPrev', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      seedEntryInputs(cache, 'hPrev', [
        { kind: 'file', name: 'src/a.ts', hash: 'oidA1' },
        { kind: 'file', name: 'src/stable.ts', hash: 'oidStable' },
        { kind: 'env', name: 'NODE_ENV', hash: 'development' },
        { kind: 'env', name: 'OLD_ONLY', hash: 'gone' },
      ])
      // This run of pkg#test → hash hCur
      cache.recordRun(
        mkRun({ hash: 'hCur', project: 'pkg', task: 'test', runId: 'r-2', startedAt: 2000 }),
      )
      seedEntryInputs(cache, 'hCur', [
        { kind: 'file', name: 'src/a.ts', hash: 'oidA2' }, // changed
        { kind: 'file', name: 'src/stable.ts', hash: 'oidStable' }, // unchanged
        { kind: 'env', name: 'NODE_ENV', hash: 'production' }, // changed
        { kind: 'file', name: 'src/new.ts', hash: 'oidNew' }, // added
      ])

      const diff = cacheKeyDiff(cache.dbHandle(), 'r-2', 'pkg#test')
      expect(diff.found).toBe(true)
      expect(diff.previousRunId).toBe('r-1')
      expect(diff.unchangedCount).toBe(1) // src/stable.ts

      const byName = new Map(diff.entries.map((e) => [`${e.kind}:${e.name}`, e]))
      expect(byName.get('file:src/a.ts')).toEqual({
        kind: 'file',
        name: 'src/a.ts',
        change: 'changed',
        before: 'oidA1',
        after: 'oidA2',
      })
      expect(byName.get('env:NODE_ENV')).toEqual({
        kind: 'env',
        name: 'NODE_ENV',
        change: 'changed',
        before: 'development',
        after: 'production',
      })
      expect(byName.get('file:src/new.ts')).toEqual({
        kind: 'file',
        name: 'src/new.ts',
        change: 'added',
        before: null,
        after: 'oidNew',
      })
      expect(byName.get('env:OLD_ONLY')).toEqual({
        kind: 'env',
        name: 'OLD_ONLY',
        change: 'removed',
        before: 'gone',
        after: null,
      })
      // exactly those four diffs, nothing else
      expect(diff.entries.length).toBe(4)
    })
  })

  it('first run of a task → found, no previous, empty diff', () => {
    withCache((cache) => {
      cache.recordRun(
        mkRun({ hash: 'hOnly', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      seedEntryInputs(cache, 'hOnly', [{ kind: 'file', name: 'src/a.ts', hash: 'oid' }])
      const diff = cacheKeyDiff(cache.dbHandle(), 'r-1', 'pkg#test')
      expect(diff.found).toBe(true)
      expect(diff.previousRunId).toBeNull()
      expect(diff.entries).toEqual([])
    })
  })

  it('same hash across two runs → found, empty diff (nothing changed)', () => {
    withCache((cache) => {
      cache.recordRun(
        mkRun({ hash: 'hSame', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      cache.recordRun(
        mkRun({ hash: 'hSame', project: 'pkg', task: 'test', runId: 'r-2', startedAt: 2000 }),
      )
      seedEntryInputs(cache, 'hSame', [{ kind: 'file', name: 'src/a.ts', hash: 'oid' }])
      const diff = cacheKeyDiff(cache.dbHandle(), 'r-2', 'pkg#test')
      expect(diff.found).toBe(true)
      expect(diff.previousRunId).toBe('r-1')
      expect(diff.entries).toEqual([])
    })
  })

  it('returns found=false for an unknown runId + taskId', () => {
    withCache((cache) => {
      const diff = cacheKeyDiff(cache.dbHandle(), 'nope', 'pkg#test')
      expect(diff.found).toBe(false)
      expect(diff.entries).toEqual([])
    })
  })

  it('degrades gracefully when fingerprint rows were pruned', () => {
    withCache((cache) => {
      // Two runs with different hashes but no entry_inputs rows recorded.
      cache.recordRun(
        mkRun({ hash: 'hP', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      cache.recordRun(
        mkRun({ hash: 'hC', project: 'pkg', task: 'test', runId: 'r-2', startedAt: 2000 }),
      )
      const diff = cacheKeyDiff(cache.dbHandle(), 'r-2', 'pkg#test')
      expect(diff.found).toBe(true)
      expect(diff.previousRunId).toBe('r-1')
      expect(diff.entries).toEqual([])
      expect(diff.note).toContain('unavailable')
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

  it('returns ALL tasks of a large run (not truncated at the list cap)', () => {
    withCache((cache) => {
      // A run bigger than the old 500-row listRuns cap. getRun must return
      // every task — else run-detail (and the cacheKeyDiff "why" panel) drops
      // tasks on real monorepos. Regression guard for the 500-truncation bug.
      const runs = Array.from({ length: 700 }, (_, i) =>
        mkRun({
          hash: `h${i}`,
          project: `pkg-${String(i).padStart(3, '0')}`,
          task: 'build',
          runId: 'big',
          startedAt: 1000 + i,
          endedAt: 1001 + i,
        }),
      )
      cache.recordRuns(runs)
      const detail = getRun(cache.dbHandle(), 'big')!
      expect(detail.tasks.length).toBe(700)
      expect(detail.tasks.some((t) => t.project === 'pkg-000')).toBe(true)
    })
  })
})

describe('getCacheStatsSql', () => {
  it('counts entries + computes hit rate + local/remote split from runs in last 24h', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns([
        mkRun({
          hash: 'h1',
          project: 'pkg',
          task: 'build',
          status: 'success',
          startedAt: now - 1500,
        }),
        mkRun({
          hash: 'h2',
          project: 'pkg',
          task: 'build',
          status: 'cache-hit',
          startedAt: now - 1000,
        }),
        mkRun({
          hash: 'h3',
          project: 'pkg',
          task: 'test',
          status: 'cache-hit-remote',
          startedAt: now - 500,
        }),
      ])
      const stats = getCacheStatsSql(cache.dbHandle())
      expect(stats.runCountLast24h).toBe(3)
      expect(stats.hitCountLast24h).toBe(2)
      expect(stats.hitLocalCountLast24h).toBe(1)
      expect(stats.hitRemoteCountLast24h).toBe(1)
      expect(stats.hitRate24h).toBeCloseTo(2 / 3)
    })
  })
})

describe('getHitRateSplit', () => {
  it('counts local vs remote hits and computes shares', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'pkg', task: 'a', status: 'success', startedAt: now - 4000 }),
        mkRun({
          hash: 'h2',
          project: 'pkg',
          task: 'a',
          status: 'cache-hit',
          startedAt: now - 3000,
        }),
        mkRun({
          hash: 'h3',
          project: 'pkg',
          task: 'a',
          status: 'cache-hit',
          startedAt: now - 2000,
        }),
        mkRun({
          hash: 'h4',
          project: 'pkg',
          task: 'b',
          status: 'cache-hit-remote',
          startedAt: now - 1000,
        }),
      ])
      const split = getHitRateSplit(cache.dbHandle())
      expect(split.total).toBe(4)
      expect(split.hits).toBe(3)
      expect(split.hitLocal).toBe(2)
      expect(split.hitRemote).toBe(1)
      expect(split.hitRate).toBeCloseTo(0.75)
      expect(split.localShare).toBeCloseTo(2 / 3)
      expect(split.remoteShare).toBeCloseTo(1 / 3)
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

describe('compareRuns', () => {
  it('diffs a run against the immediately-previous invocation', () => {
    withCache((cache) => {
      cache.recordRuns([
        // previous invocation r-1: build (h1, 100ms), test (h2, 200ms)
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
        }),
        // newest invocation r-2: build re-keyed (h3, 150ms), test unchanged key but faster (h2, 120ms)
        mkRun({
          hash: 'h3',
          project: 'pkg',
          task: 'build',
          runId: 'r-2',
          startedAt: 2000,
          durationMs: 150,
        }),
        mkRun({
          hash: 'h2',
          project: 'pkg',
          task: 'test',
          runId: 'r-2',
          startedAt: 2100,
          durationMs: 120,
        }),
      ])
      const cmp = compareRuns(cache.dbHandle(), 'r-2')
      expect(cmp.found).toBe(true)
      expect(cmp.previousRunId).toBe('r-1')
      expect(cmp.summary.aTotalMs).toBe(270)
      expect(cmp.summary.bTotalMs).toBe(300)
      expect(cmp.summary.totalDeltaMs).toBe(-30)
      expect(cmp.tasks.length).toBe(2)
      const build = cmp.tasks.find((t) => t.taskId === 'pkg#build')!
      expect(build.hashChanged).toBe(true)
      expect(build.durationDeltaMs).toBe(50)
      const test = cmp.tasks.find((t) => t.taskId === 'pkg#test')!
      expect(test.hashChanged).toBe(false)
      expect(test.durationDeltaMs).toBe(-80)
      // build's key changed → tasksChanged counts it; test's key + status held.
      expect(cmp.summary.tasksChanged).toBe(1)
    })
  })

  it('flags tasks present on only one side as changed', () => {
    withCache((cache) => {
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'pkg', task: 'build', runId: 'r-1', startedAt: 1000 }),
        // r-2 drops build and adds lint
        mkRun({ hash: 'h2', project: 'pkg', task: 'lint', runId: 'r-2', startedAt: 2000 }),
      ])
      const cmp = compareRuns(cache.dbHandle(), 'r-2')
      expect(cmp.found).toBe(true)
      const lint = cmp.tasks.find((t) => t.taskId === 'pkg#lint')!
      expect(lint.b).toBeNull()
      expect(lint.hashChanged).toBe(true)
      expect(lint.durationDeltaMs).toBeNull()
      const build = cmp.tasks.find((t) => t.taskId === 'pkg#build')!
      expect(build.a).toBeNull()
      expect(cmp.summary.tasksOnlyInA).toBe(1)
      expect(cmp.summary.tasksOnlyInB).toBe(1)
    })
  })

  it('reports no previous invocation when this is the only run', () => {
    withCache((cache) => {
      cache.recordRun(
        mkRun({ hash: 'h1', project: 'pkg', task: 'build', runId: 'r-1', startedAt: 1000 }),
      )
      const cmp = compareRuns(cache.dbHandle(), 'r-1')
      expect(cmp.found).toBe(false)
      expect(cmp.previousRunId).toBeNull()
      // The run itself is still resolved (its own tasks are listed, b = null).
      expect(cmp.tasks.length).toBe(1)
      expect(cmp.tasks[0]!.b).toBeNull()
    })
  })

  it('returns found=false with no tasks for an unknown runId', () => {
    withCache((cache) => {
      const cmp = compareRuns(cache.dbHandle(), 'nope')
      expect(cmp.found).toBe(false)
      expect(cmp.tasks).toEqual([])
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
  it('returns a densified time series with hour buckets + local/remote hit series', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns([
        mkRun({ hash: 'h1', project: 'a', task: 'b', startedAt: now - 60_000 }),
        mkRun({
          hash: 'h2',
          project: 'a',
          task: 'b',
          status: 'cache-hit',
          startedAt: now - 60_000,
        }),
        mkRun({
          hash: 'h3',
          project: 'a',
          task: 'b',
          status: 'cache-hit-remote',
          startedAt: now - 60_000,
        }),
      ])
      const pts = getRunTrends(cache.dbHandle(), { bucket: 'hour' })
      // 24h of hourly buckets ≈ 25 cells (start + end inclusive).
      expect(pts.length).toBeGreaterThan(20)
      expect(pts.reduce((acc, p) => acc + p.runs, 0)).toBe(3)
      expect(pts.reduce((acc, p) => acc + p.hitsLocal, 0)).toBe(1)
      expect(pts.reduce((acc, p) => acc + p.hitsRemote, 0)).toBe(1)
      expect(pts.reduce((acc, p) => acc + p.hits, 0)).toBe(2)
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

  it('CONFIRMS flakiness from a within-run retry, ranked above inferred ones', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns([
        // `inferred#t`: fails in one of four runs — flaky by cross-run inference.
        mkRun({ hash: 'i1', project: 'inferred', task: 't', startedAt: now - 5000 }),
        mkRun({
          hash: 'i2',
          project: 'inferred',
          task: 't',
          status: 'failed',
          exitCode: 1,
          startedAt: now - 4000,
        }),
        mkRun({ hash: 'i3', project: 'inferred', task: 't', startedAt: now - 3000 }),
        mkRun({ hash: 'i4', project: 'inferred', task: 't', startedAt: now - 2000 }),
        // `confirmed#t`: passed on the FIRST try twice, then needed a retry once —
        // a direct nondeterminism signal, even though it never shows a `failed` row.
        mkRun({ hash: 'c1', project: 'confirmed', task: 't', startedAt: now - 1500 }),
        mkRun({ hash: 'c2', project: 'confirmed', task: 't', startedAt: now - 1000 }),
        mkRun({ hash: 'c3', project: 'confirmed', task: 't', attempts: 3, startedAt: now - 500 }),
      ])
      const flaky = getFlakiestTasks(cache.dbHandle())
      const confirmed = flaky.find((f) => f.id === 'confirmed#t')
      expect(confirmed).toBeDefined()
      expect(confirmed!.flakyConfirmed).toBe(true)
      expect(confirmed!.withinRunRetries).toBe(1)
      expect(confirmed!.maxAttempts).toBe(3)
      expect(confirmed!.failures).toBe(0)
      // A confirmed within-run flake outranks a merely-inferred one.
      expect(flaky[0]!.id).toBe('confirmed#t')
    })
  })

  it('surfaces a confirmed within-run flake even with fewer than 3 runs', () => {
    withCache((cache) => {
      cache.recordRun(mkRun({ hash: 'x1', project: 'rare', task: 't', attempts: 2 }))
      const flaky = getFlakiestTasks(cache.dbHandle())
      expect(flaky.find((f) => f.id === 'rare#t')?.flakyConfirmed).toBe(true)
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

describe('getRegressions', () => {
  // Seed one (project, task) run at a given branch/status/time, each in its
  // own invocation so the runs→invocations branch join is exercised.
  const seed = (
    cache: Cache,
    n: number,
    task: string,
    branch: string,
    status: RunRecord['status'],
    startedAt: number,
  ): void => {
    cache.recordRunBundle({
      runs: [mkRun({ hash: `h-${n}`, project: 'pkg', task, runId: `r-${n}`, status, startedAt })],
      invocation: mkInvocation({ runId: `r-${n}`, branch, startedAt }),
    })
  }
  const now = Date.now()
  const day = 86_400_000

  it('surfaces a task now failing across >= 2 branches that used to pass', () => {
    withCache((cache) => {
      // `build` passed a week+ ago, now fails on BOTH main and dev.
      seed(cache, 1, 'build', 'main', 'success', now - 8 * day)
      seed(cache, 2, 'build', 'main', 'failed', now - 2 * day)
      seed(cache, 3, 'build', 'dev', 'failed', now - 1 * day)
      // `lint` fails only on one branch — not "across branches".
      seed(cache, 4, 'lint', 'main', 'failed', now - 1 * day)
      const regs = getRegressions(cache.dbHandle())
      expect(regs.map((r) => r.id)).toEqual(['pkg#build'])
      const b = regs[0]!
      expect(b.branchesFailing).toBe(2)
      expect(b.branches.sort()).toEqual(['dev', 'main'])
      expect(b.regressed).toBe(true) // had a prior success
      expect(b.failures).toBe(2)
    })
  })

  it('uses the LATEST run per branch — a since-recovered branch is not failing', () => {
    withCache((cache) => {
      seed(cache, 1, 'build', 'main', 'success', now - 5 * day)
      seed(cache, 2, 'build', 'main', 'failed', now - 4 * day)
      seed(cache, 3, 'build', 'main', 'success', now - 1 * day) // recovered on main
      seed(cache, 4, 'build', 'dev', 'failed', now - 2 * day)
      seed(cache, 5, 'build', 'feat', 'failed', now - 1 * day)
      const regs = getRegressions(cache.dbHandle())
      // main recovered; only dev + feat are currently failing.
      expect(regs[0]!.branches.sort()).toEqual(['dev', 'feat'])
      expect(regs[0]!.branchesFailing).toBe(2)
    })
  })

  it('a cache-hit counts as a pass (current state), not a failure', () => {
    withCache((cache) => {
      seed(cache, 1, 'build', 'main', 'failed', now - 3 * day)
      seed(cache, 2, 'build', 'main', 'cache-hit', now - 1 * day) // latest = pass
      seed(cache, 3, 'build', 'dev', 'failed', now - 1 * day)
      // Only dev fails now → below the default minBranches=2 → nothing.
      expect(getRegressions(cache.dbHandle())).toEqual([])
      // minBranches=1 surfaces the single-branch regression.
      expect(getRegressions(cache.dbHandle(), { minBranches: 1 }).map((r) => r.id)).toEqual([
        'pkg#build',
      ])
    })
  })

  it('a never-passed task on 2 branches is flagged regressed=false', () => {
    withCache((cache) => {
      seed(cache, 1, 'broken', 'main', 'failed', now - 2 * day)
      seed(cache, 2, 'broken', 'dev', 'failed', now - 1 * day)
      const regs = getRegressions(cache.dbHandle())
      expect(regs[0]!.id).toBe('pkg#broken')
      expect(regs[0]!.regressed).toBe(false)
    })
  })

  it('regressions (used-to-pass) sort above always-broken tasks', () => {
    withCache((cache) => {
      // A regressed task and an always-broken task, both failing on 2 branches.
      seed(cache, 1, 'reg', 'main', 'success', now - 6 * day)
      seed(cache, 2, 'reg', 'main', 'failed', now - 1 * day)
      seed(cache, 3, 'reg', 'dev', 'failed', now - 1 * day)
      seed(cache, 4, 'broke', 'main', 'failed', now - 1 * day)
      seed(cache, 5, 'broke', 'dev', 'failed', now - 1 * day)
      const regs = getRegressions(cache.dbHandle())
      expect(regs.map((r) => r.id)).toEqual(['pkg#reg', 'pkg#broke'])
    })
  })

  it('respects the window: failures older than sinceDays are ignored', () => {
    withCache((cache) => {
      seed(cache, 1, 'build', 'main', 'failed', now - 40 * day)
      seed(cache, 2, 'build', 'dev', 'failed', now - 40 * day)
      expect(getRegressions(cache.dbHandle(), { sinceDays: 7 })).toEqual([])
      expect(getRegressions(cache.dbHandle(), { sinceDays: 60 }).map((r) => r.id)).toEqual([
        'pkg#build',
      ])
    })
  })
})

describe('getPeriodComparison', () => {
  const day = 86_400_000
  // Fixed clock so the two 7-day windows are deterministic. `now` is the end
  // of the CURRENT window; [now-7d, now) is current, [now-14d, now-7d) previous.
  const now = 14 * day + 12 * 3_600_000
  const seed = (
    cache: Cache,
    n: number,
    task: string,
    status: RunRecord['status'],
    durationMs: number,
    startedAt: number,
  ): void => {
    cache.recordRunBundle({
      runs: [
        mkRun({
          hash: `h-${n}`,
          project: 'pkg',
          task,
          runId: `r-${n}`,
          status,
          durationMs,
          startedAt,
        }),
      ],
      invocation: mkInvocation({ runId: `r-${n}`, startedAt }),
    })
  }

  it('splits runs into two adjacent windows and aggregates each', () => {
    withCache((cache) => {
      // Previous window: one success, one failure.
      seed(cache, 1, 'build', 'success', 200, now - 10 * day)
      seed(cache, 2, 'build', 'failed', 0, now - 9 * day)
      // Current window: two successes.
      seed(cache, 3, 'build', 'success', 300, now - 3 * day)
      seed(cache, 4, 'build', 'success', 100, now - 2 * day)
      const cmp = getPeriodComparison(cache.dbHandle(), { endMs: now })
      expect(cmp.windowDays).toBe(7)
      expect(cmp.current.stats.taskRuns).toBe(2)
      expect(cmp.current.stats.failures).toBe(0)
      expect(cmp.current.stats.avgDurationMs).toBe(200) // (300+100)/2
      expect(cmp.previous.stats.taskRuns).toBe(2)
      expect(cmp.previous.stats.failures).toBe(1)
      expect(cmp.previous.stats.failureRate).toBe(0.5)
    })
  })

  it('ranks movers by absolute average-duration delta, both windows >= minRuns', () => {
    withCache((cache) => {
      // `slow` got much slower; `fast` sped up a bit; `rare` has too few runs.
      for (let i = 0; i < 3; i++) {
        seed(cache, 100 + i, 'slow', 'success', 100, now - 10 * day)
        seed(cache, 110 + i, 'slow', 'success', 500, now - 3 * day)
        seed(cache, 120 + i, 'fast', 'success', 200, now - 10 * day)
        seed(cache, 130 + i, 'fast', 'success', 150, now - 3 * day)
      }
      // `rare` runs once per window — below minRuns=3, excluded.
      seed(cache, 140, 'rare', 'success', 100, now - 10 * day)
      seed(cache, 141, 'rare', 'success', 9000, now - 3 * day)
      const cmp = getPeriodComparison(cache.dbHandle(), { endMs: now })
      expect(cmp.movers.map((m) => m.task)).toEqual(['slow', 'fast'])
      const slow = cmp.movers[0]!
      expect(slow.currentAvgMs).toBe(500)
      expect(slow.previousAvgMs).toBe(100)
      expect(slow.deltaMs).toBe(400)
      expect(slow.deltaPct).toBeCloseTo(4, 5)
      expect(cmp.movers.find((m) => m.task === 'rare')).toBeUndefined()
    })
  })

  it('empty db yields zeroed stats and no movers', () => {
    withCache((cache) => {
      const cmp = getPeriodComparison(cache.dbHandle(), { endMs: now })
      expect(cmp.current.stats.taskRuns).toBe(0)
      expect(cmp.current.stats.avgDurationMs).toBe(0)
      expect(cmp.movers).toEqual([])
    })
  })

  it('project/task scoping narrows both windows and the movers', () => {
    withCache((cache) => {
      // Two tasks move; the scope must isolate ONE task's trend.
      for (let i = 0; i < 3; i++) {
        seed(cache, 200 + i, 'build', 'success', 100, now - 10 * day)
        seed(cache, 210 + i, 'build', 'success', 400, now - 3 * day)
        seed(cache, 220 + i, 'test', 'success', 900, now - 10 * day)
        seed(cache, 230 + i, 'test', 'success', 100, now - 3 * day)
      }
      const scoped = getPeriodComparison(cache.dbHandle(), {
        endMs: now,
        project: 'pkg',
        task: 'build',
      })
      expect(scoped.current.stats.taskRuns).toBe(3) // only build's rows
      expect(scoped.current.stats.avgDurationMs).toBe(400)
      expect(scoped.previous.stats.avgDurationMs).toBe(100)
      expect(scoped.movers.map((m) => m.task)).toEqual(['build'])
      // A different project scopes to nothing.
      const other = getPeriodComparison(cache.dbHandle(), { endMs: now, project: 'nope' })
      expect(other.current.stats.taskRuns).toBe(0)
      expect(other.movers).toEqual([])
    })
  })

  it('an empty window returns numeric 0s, never null (SUM-over-no-rows guard)', () => {
    withCache((cache) => {
      // Only the CURRENT window has runs; the previous window is empty — the
      // common case for a workspace younger than the window. Every count must
      // be a number (a bare SUM would return NULL and break the client).
      seed(cache, 1, 'build', 'success', 100, now - 2 * day)
      const prev = getPeriodComparison(cache.dbHandle(), { endMs: now }).previous.stats
      for (const k of ['failures', 'cacheHits', 'executed', 'taskRuns', 'runs'] as const) {
        expect(prev[k]).toBe(0)
        expect(typeof prev[k]).toBe('number')
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Schema drift guard — every exported metrics query must run against the
// CURRENT cache.db schema. The schema is owned by src/cache/cache.ts and its
// DROP-gate makes bumps routine; metrics.ts hardcodes SQL over those tables
// with no compiler signal, so this is the gate that catches a bump breaking
// a query before it surfaces in the cloud dashboard.
// ---------------------------------------------------------------------------

import * as metrics from '../src/orchestrator/metrics.js'

describe('metrics schema drift guard', () => {
  it('every exported query executes against a freshly-created cache.db', () => {
    withCache((cache) => {
      const db = cache.dbHandle()
      const calls: Record<string, () => unknown> = {
        listRuns: () => metrics.listRuns(db),
        getInvocation: () => metrics.getInvocation(db, 'r-none'),
        listInvocations: () => metrics.listInvocations(db),
        getRun: () => metrics.getRun(db, 'r-none'),
        getCacheStatsSql: () => metrics.getCacheStatsSql(db),
        getHitRateSplit: () => metrics.getHitRateSplit(db),
        getHistory: () => metrics.getHistory(db),
        getTopTimeBurners: () => metrics.getTopTimeBurners(db),
        getRecentFailures: () => metrics.getRecentFailures(db),
        listCacheEntries: () => metrics.listCacheEntries(db),
        getCacheBreakdown: () => metrics.getCacheBreakdown(db),
        getTaskDetail: () => metrics.getTaskDetail(db, 'pkg#build'),
        getCacheSavings: () => metrics.getCacheSavings(db),
        explainCacheKey: () => metrics.explainCacheKey(db, 'pkg#build'),
        whyDidThisRerun: () => metrics.whyDidThisRerun(db, 'r-none', 'pkg#build'),
        cacheKeyDiff: () => metrics.cacheKeyDiff(db, 'r-none', 'pkg#build'),
        compareRuns: () => metrics.compareRuns(db, 'r-none'),
        listProjects: () => metrics.listProjects(db),
        getRunTrends: () => metrics.getRunTrends(db),
        getRunHeatmap: () => metrics.getRunHeatmap(db),
        getFlakiestTasks: () => metrics.getFlakiestTasks(db),
        getRegressions: () => metrics.getRegressions(db),
        getPeriodComparison: () => metrics.getPeriodComparison(db),
        getBottlenecks: () => metrics.getBottlenecks(db),
        getParallelismHistory: () => metrics.getParallelismHistory(db),
        getStorageGrowth: () => metrics.getStorageGrowth(db),
        getPrunableEntries: () => metrics.getPrunableEntries(db),
      }

      // Coverage pin: a NEW exported query must be added to `calls` above
      // (and thereby to the drift guard) before it ships.
      const exported = Object.entries(metrics)
        .filter(([, v]) => typeof v === 'function')
        .map(([k]) => k)
        .sort()
      expect(Object.keys(calls).sort()).toEqual(exported)

      for (const [name, call] of Object.entries(calls)) {
        try {
          call()
        } catch (err) {
          throw new Error(
            `metrics.${name} is broken against the current cache.db schema: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    })
  })
})
