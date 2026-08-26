import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { type InvocationRecord, Cache, type RunRecord } from '../src/cache/index.js'
import {
  cacheKeyDiff,
  explainCacheKeyQuery,
  getCacheStatsSql,
  getHistory,
  getInvocation,
  getRun,
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

describe('getHistory', () => {
  it('rolls (project, task) aggregates with failureMode classification', () => {
    withCache((cache) => {
      const now = Date.now()
      cache.recordRuns(
        Array.from({ length: 6 }, (_, i) =>
          mkRun({
            // The failing run reuses h4's key — a same-key flap, so the task
            // classifies flaky (a unique-key failure would read 'stable').
            hash: i === 5 ? 'h4' : `h${i}`,
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

  it('reads a unique-key failure as stable (a break, not a flake)', () => {
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
      expect(rows[0]!.failureMode).toBe('stable')
    })
  })

  it('keeps the most-recently-run tasks when the page truncates', () => {
    withCache((cache) => {
      const now = Date.now()
      // 60 alphabetically-early pairs, all older…
      const runs = Array.from({ length: 60 }, (_, i) =>
        mkRun({
          hash: `h${i}`,
          project: `aaa${String(i).padStart(3, '0')}`,
          task: 'build',
          startedAt: now - 1_000_000 + i,
        }),
      )
      // …and the one that just ran, sorting LAST alphabetically.
      runs.push(mkRun({ hash: 'hz', project: 'zzz-just-ran', task: 'build', startedAt: now - 10 }))
      cache.recordRuns(runs)
      const rows = getHistory(cache.dbHandle(), { limit: 50 })
      expect(rows.length).toBe(50)
      // An unordered DISTINCT scan sliced in JS returns the alphabetical
      // prefix — which drops exactly the task the user just ran.
      expect(rows.map((r) => r.id)).toContain('zzz-just-ran#build')
      expect(rows[0]!.id).toBe('zzz-just-ran#build')
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

// ---------------------------------------------------------------------------
// Schema drift guard — every exported metrics query must run against the
// CURRENT cache.db schema. The schema is owned by src/cache/cache.ts and its
// DROP-gate makes bumps routine; metrics.ts hardcodes SQL over those tables
// with no compiler signal, so this is the gate that catches a bump breaking
// a query before it surfaces in the cloud dashboard.
// ---------------------------------------------------------------------------
