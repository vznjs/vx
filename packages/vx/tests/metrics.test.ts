import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { type InvocationRecord, Cache, type RunRecord } from '../src/cache/index.js'
import {
  cacheKeyDiff,
  explainCacheKeyQuery,
  getInvocation,
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
    ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
    ...(args.blockedBy !== undefined ? { blockedBy: args.blockedBy } : {}),
    ...(args.timedOut !== undefined ? { timedOut: args.timedOut } : {}),
    ...(args.sandboxViolations !== undefined ? { sandboxViolations: args.sandboxViolations } : {}),
    ...(args.notReady !== undefined ? { notReady: args.notReady } : {}),
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

  it('clamps the limit, so 0 is not "no rows" and -1 is not "every row"', () => {
    withCache((cache) => {
      cache.recordRuns(
        Array.from({ length: 12 }, (_, i) =>
          mkRun({ hash: `h${i}`, project: 'pkg', task: 'build', startedAt: 1000 + i }),
        ),
      )
      // SQLite reads LIMIT 0 as none and LIMIT -1 as unbounded, so an
      // unclamped caller-supplied number is two different wrong answers.
      expect(listRuns(cache.dbHandle(), { limit: 0 }).length).toBe(1)
      expect(listRuns(cache.dbHandle(), { limit: -1 }).length).toBe(1)
      // And the default is high enough that a list view sees a real page.
      expect(listRuns(cache.dbHandle()).length).toBe(12)
    })
  })

  it('reads a pre-column NULL as null, and a bigint back as a decimal string', () => {
    withCache((cache) => {
      cache.recordRuns([mkRun({ hash: 'h1', project: 'pkg', task: 'build', startedAt: 1000 })])
      // `cacheHit`/`cached` are documented as null on rows older than the
      // column. Boolean(null) is false — which reads as "this task declares
      // a cache block and missed", a claim the row does not make.
      cache
        .dbHandle()
        .query(
          'UPDATE runs SET cache_hit = NULL, cached = NULL, wallclock_start_ns = 1500000000000',
        )
        .run()
      const row = listRuns(cache.dbHandle())[0]!
      expect(row.cacheHit).toBeNull()
      expect(row.cached).toBeNull()
      // The ns columns cross the wire as decimal STRINGS, never as numbers:
      // the row's own comment says bigints are not JSON-safe and the client
      // is to call BigInt/Number on them. (Measured while writing this: the
      // read is already a JS number — bun:sqlite is not in safeIntegers
      // mode — so the value would also lose precision above 2^53. It cannot
      // get there: these are ns RELATIVE to run t=0, and 2^53 ns is 104 days
      // of run time. The `bigint` annotation the raw row carried was simply
      // false, and is corrected alongside this.)
      expect(row.wallclockStartNs).toBe('1500000000000')
    })
  })

  describe('the reason columns (v27)', () => {
    it('round-trip each reason, and read null where none applies', () => {
      withCache((cache) => {
        cache.recordRuns([
          mkRun({ hash: '', project: 'p', task: 'skip', status: 'skipped', blockedBy: 'p#lib' }),
          mkRun({
            hash: 'h1',
            project: 'p',
            task: 'slow',
            status: 'failed',
            exitCode: 143,
            timedOut: true,
          }),
          mkRun({
            hash: 'h2',
            project: 'p',
            task: 'box',
            status: 'failed',
            exitCode: 1,
            sandboxViolations: 2,
          }),
          mkRun({
            hash: '',
            project: 'p',
            task: 'dev',
            status: 'failed',
            exitCode: 2,
            notReady: 'exited',
          }),
          mkRun({ hash: 'h3', project: 'p', task: 'plain', status: 'failed', exitCode: 3 }),
        ])
        const byTask = new Map(listRuns(cache.dbHandle(), { project: 'p' }).map((r) => [r.task, r]))
        expect(byTask.get('skip')?.blockedBy).toBe('p#lib')
        expect(byTask.get('slow')?.timedOut).toBe(true)
        expect(byTask.get('box')?.sandboxViolations).toBe(2)
        expect(byTask.get('dev')?.notReady).toBe('exited')
        const plain = byTask.get('plain')!
        expect([plain.blockedBy, plain.timedOut, plain.sandboxViolations, plain.notReady]).toEqual([
          null,
          null,
          null,
          null,
        ])
      })
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

      // TWO filters at once. Every assertion above passes exactly one, and a
      // single clause joins the same under AND or OR — so this function's
      // clause builder was free, while `listRuns`'s identical one is held by
      // a row that does pass two. `branch: 'main'` and `ci: true` select
      // different rows, so OR would return both.
      expect(
        listInvocations(cache.dbHandle(), { branch: 'main', ci: true }).map((r) => r.runId),
      ).toEqual([])
    })
  })

  it('needs BOTH halves of a tag pair before it filters on one', () => {
    withCache((cache) => {
      for (const [runId, startedAt, tags] of [
        ['r-a', 1000, { env: 'dev' }],
        ['r-b', 2000, { env: 'prod' }],
      ] as const) {
        cache.recordRunBundle({
          runs: [mkRun({ hash: 'h', project: 'pkg', task: 'build', runId })],
          invocation: mkInvocation({ runId, startedAt, tags: JSON.stringify(tags) }),
        })
      }
      // A key with no value cannot name a pair, so it must not narrow — the
      // LIKE fragment would otherwise be built from `undefined`.
      expect(listInvocations(cache.dbHandle(), { tagKey: 'env' }).length).toBe(2)
      expect(listInvocations(cache.dbHandle(), { tagValue: 'prod' }).length).toBe(2)
      expect(listInvocations(cache.dbHandle(), { tagKey: 'env', tagValue: 'prod' }).length).toBe(1)
    })
  })

  it('escapes a tag key or value into the serialized pair it matches on', () => {
    withCache((cache) => {
      // The filter is a LIKE over the JSON text, so the fragment has to be
      // spelled the way JSON.stringify spelled the column — a quote or a
      // backslash in either half is escaped there and must be here too, or
      // the pair never matches its own row.
      const tags = { 'we"ird': 'va\\lue' }
      cache.recordRunBundle({
        runs: [mkRun({ hash: 'h', project: 'pkg', task: 'build', runId: 'r-q' })],
        invocation: mkInvocation({ runId: 'r-q', startedAt: 1000, tags: JSON.stringify(tags) }),
      })
      const found = listInvocations(cache.dbHandle(), { tagKey: 'we"ird', tagValue: 'va\\lue' })
      expect(found.map((r) => r.runId)).toEqual(['r-q'])
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

  it('skips a previous run that recorded NO key — the same guard `why` has', () => {
    // `whyDidThisRerun` restricts the previous-run lookup to rows that
    // recorded a key, and every mutation of THAT copy is caught. This
    // function has the identical restriction and its own comment explaining
    // why — a `hash = ''` row would resolve the `prev.hash === this_.hash`
    // branch and answer "same inputs" for two runs that never had a key —
    // and nothing held it. Two copies of one rule, one of them free.
    withCache((cache) => {
      cache.recordRun(
        mkRun({ hash: 'hA', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      // A skipped row in between: recorded, but with no key.
      cache.recordRun(
        mkRun({
          hash: '',
          project: 'pkg',
          task: 'test',
          runId: 'r-2',
          status: 'skipped',
          startedAt: 2000,
        }),
      )
      cache.recordRun(
        mkRun({ hash: 'hB', project: 'pkg', task: 'test', runId: 'r-3', startedAt: 3000 }),
      )
      seedEntryInputs(cache, 'hA', [{ kind: 'file', name: 'a.ts', hash: 'x1' }])
      seedEntryInputs(cache, 'hB', [{ kind: 'file', name: 'a.ts', hash: 'x2' }])

      const diff = cacheKeyDiff(cache.dbHandle(), 'r-3', 'pkg#test')
      // The comparison is against r-1, the last run that HAD a key — not
      // against the keyless r-2 sitting between them.
      expect(diff.previousRunId).toBe('r-1')
      expect(diff.entries).toEqual([
        { kind: 'file', name: 'a.ts', change: 'changed', before: 'x1', after: 'x2' },
      ])
    })
  })

  it('identifies a component by kind AND name, not by name alone', () => {
    // The two sides are joined on a composite key. Keyed by name alone, a
    // `file` and an `env` component sharing a name collide and one silently
    // replaces the other; concatenated without a separator, `kind:'fil'
    // name:'ex'` and `kind:'file' name:'x'` are the same key.
    withCache((cache) => {
      cache.recordRun(
        mkRun({ hash: 'hO', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      cache.recordRun(
        mkRun({ hash: 'hN', project: 'pkg', task: 'test', runId: 'r-2', startedAt: 2000 }),
      )
      seedEntryInputs(cache, 'hO', [
        { kind: 'file', name: 'x', hash: 'f-old' },
        { kind: 'env', name: 'x', hash: 'e-same' },
        { kind: 'fil', name: 'ex', hash: 's-same' },
      ])
      seedEntryInputs(cache, 'hN', [
        { kind: 'file', name: 'x', hash: 'f-new' },
        { kind: 'env', name: 'x', hash: 'e-same' },
        { kind: 'fil', name: 'ex', hash: 's-same' },
      ])
      const diff = cacheKeyDiff(cache.dbHandle(), 'r-2', 'pkg#test')
      // Only the file component moved; the other two are unchanged and must
      // be counted, not collapsed into it.
      expect(diff.entries).toEqual([
        { kind: 'file', name: 'x', change: 'changed', before: 'f-old', after: 'f-new' },
      ])
      expect(diff.unchangedCount).toBe(2)
    })
  })

  it('orders entries by kind, then name', () => {
    withCache((cache) => {
      cache.recordRun(
        mkRun({ hash: 'hO2', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      cache.recordRun(
        mkRun({ hash: 'hN2', project: 'pkg', task: 'test', runId: 'r-2', startedAt: 2000 }),
      )
      // MIXED CASE on purpose. `entry_inputs` is keyed PRIMARY KEY
      // (entry_hash, kind, name), so a `WHERE entry_hash = ?` scan already
      // returns rows in kind-then-name order — but in SQLite's BINARY
      // collation, while the sort is `localeCompare`. Measured: the scan
      // gives [Banana, Zed, apple] and localeCompare gives [apple, Banana,
      // Zed]. All-lowercase kinds make the two agree, and the sort could
      // then be deleted outright with the row still green.
      seedEntryInputs(cache, 'hO2', [
        { kind: 'Zed', name: 'a', hash: 'z-old' },
        { kind: 'apple', name: 'm', hash: 'a-old' },
        { kind: 'Banana', name: 'z', hash: 'b-old' },
      ])
      seedEntryInputs(cache, 'hN2', [
        { kind: 'Zed', name: 'a', hash: 'z-new' },
        { kind: 'apple', name: 'm', hash: 'a-new' },
        { kind: 'Banana', name: 'z', hash: 'b-new' },
      ])
      const diff = cacheKeyDiff(cache.dbHandle(), 'r-2', 'pkg#test')
      expect(diff.entries.map((e) => `${e.kind}/${e.name}`)).toEqual([
        'apple/m',
        'Banana/z',
        'Zed/a',
      ])
    })
  })

  it('says so when the key changed but no component did', () => {
    // Both sides have fingerprints and every component matches, yet the
    // task hash differs — the key folds things `entry_inputs` does not
    // record. The note is the only thing that tells a reader that.
    withCache((cache) => {
      cache.recordRun(
        mkRun({ hash: 'hSame1', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      cache.recordRun(
        mkRun({ hash: 'hSame2', project: 'pkg', task: 'test', runId: 'r-2', startedAt: 2000 }),
      )
      seedEntryInputs(cache, 'hSame1', [{ kind: 'file', name: 'a.ts', hash: 'same' }])
      seedEntryInputs(cache, 'hSame2', [{ kind: 'file', name: 'a.ts', hash: 'same' }])
      const diff = cacheKeyDiff(cache.dbHandle(), 'r-2', 'pkg#test')
      expect(diff.entries).toEqual([])
      expect(diff.unchangedCount).toBe(1)
      expect(diff.note).toBe('cache key changed but no component-level difference was recorded')
    })
  })

  it("names the uncached case when ONE side's fingerprints are gone", () => {
    // Two separate claims the existing pruned row cannot make: it prunes
    // BOTH sides (so `||` and `&&` agree), and its task is cached (so the
    // uncached sentence never renders). An uncached task has no declared
    // inputs at all, which is a different thing to tell the reader than
    // "the entry was pruned".
    withCache((cache) => {
      cache.recordRun(
        mkRun({ hash: 'hK1', project: 'pkg', task: 'test', runId: 'r-1', startedAt: 1000 }),
      )
      cache.recordRun(
        mkRun({ hash: 'hK2', project: 'pkg', task: 'test', runId: 'r-2', startedAt: 2000 }),
      )
      // Only the PREVIOUS side keeps its rows.
      seedEntryInputs(cache, 'hK1', [{ kind: 'file', name: 'a.ts', hash: 'x1' }])
      cache.dbHandle().query('UPDATE runs SET cached = 0').run()
      const diff = cacheKeyDiff(cache.dbHandle(), 'r-2', 'pkg#test')
      expect(diff.entries).toEqual([])
      expect(diff.note).toBe(
        'no `cache` block declares its inputs, so its key folds every file in its project — a file it wrote, or any untracked file, moves it — and no fingerprints are kept to say which',
      )
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

// ---------------------------------------------------------------------------
// Schema drift guard — every exported metrics query must run against the
// CURRENT cache.db schema. The schema is owned by src/cache/cache.ts and its
// DROP-gate makes bumps routine; metrics.ts hardcodes SQL over those tables
// with no compiler signal, so this is the gate that catches a bump breaking
// a query before it surfaces in the cloud dashboard.
// ---------------------------------------------------------------------------
