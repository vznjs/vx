// Every non-group, non-aborted outcome earns a `runs` row — and a row that
// recorded no cache key must not be mistaken for one.
//
// `toRecord` in run.ts used to drop any outcome with no hash, which selects
// exactly {skipped, persistent}: the scheduler finishes a skip without ever
// probing the cache, and a persistent task is never cacheable. So a persistent
// task that failed to become ready recorded `taskCount: 0, failedCount: 0,
// exitOk: false` — a red run reporting zero tasks and zero failures to
// `vx info`, `vx mcp` and every metrics surface — and a failed task with a
// skipped dependent recorded 1 of 2.
//
// The first half drives the real CLI over both shapes. The second half seeds
// rows directly and pins that the new rows do not DILUTE any rate or mean:
// a skip is a task of the run but not an execution, so it belongs in the
// completeness surfaces (listRuns / getRun / task_count) and nowhere else.
//
// The persistent fixtures sleep 2s, not 30: a compound `sh -c 'a && b'` means
// SIGTERM reaches the shell and ORPHANS the sleeper (the documented
// grandchild limit), so a 30s child outlives its own test by half a minute.
// Three of those measurably degraded the neighbouring scale guard.

import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import {
  cacheKeyDiff,
  getCacheStatsSql,
  getFlakiestTasks,
  getHistory,
  getPeriodComparison,
  getRecentFailures,
  listProjects,
  LocalHistoryProvider,
  run,
  whyDidThisRerunQuery,
} from '../src/orchestrator/index.js'

const TIMEOUT = 20_000

interface Fixture {
  root: string
  log: string[]
}

let fixture: Fixture

const silentLogger = (f: Fixture): Logger => ({
  status(line) {
    f.log.push(line)
  },
  taskStdout() {},
  taskStderr() {},
  taskComplete(node, outcome) {
    f.log.push(`task ${node.id} ${outcome.status}`)
  },
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-record-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  return { root, log: [] }
}

async function addProject(
  root: string,
  name: string,
  config: string,
  deps: Record<string, string> = {},
): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', dependencies: deps }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
}

interface HeaderRow {
  run_id: string
  task_count: number
  failed_count: number
  exit_ok: number
}
interface TaskRow {
  project: string
  task: string
  status: string
  hash: string
}

/** The one invocation header + its per-task rows, as the metrics layer sees them. */
function readRecorded(root: string): { header: HeaderRow; rows: TaskRow[] } {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
  try {
    const headers = db
      .prepare('SELECT run_id, task_count, failed_count, exit_ok FROM invocations')
      .all() as HeaderRow[]
    expect(headers).toHaveLength(1)
    const header = headers[0]!
    const rows = db
      .prepare('SELECT project, task, status, hash FROM runs WHERE run_id = ? ORDER BY project')
      .all(header.run_id) as TaskRow[]
    return { header, rows }
  } finally {
    db.close()
  }
}

describe('every recorded outcome earns a row (real CLI)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a persistent task that never becomes ready is recorded, not dropped',
    async () => {
      await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo wrong-banner && sleep 2',
                timeout: 400,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]?.status).toBe('failed')

      const { header, rows } = readRecorded(fixture.root)
      // Was 0 / 0 — a red run reporting no tasks and no failures.
      expect(header.task_count).toBe(1)
      expect(header.failed_count).toBe(1)
      expect(header.exit_ok).toBe(0)
      expect(rows).toEqual([{ project: 'srv', task: 'dev', status: 'failed', hash: '' }])
    },
    TIMEOUT,
  )

  it(
    'a persistent task that DOES become ready is recorded too',
    async () => {
      await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo Listening && sleep 2',
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      expect(r.ok).toBe(true)

      const { header, rows } = readRecorded(fixture.root)
      expect(header.task_count).toBe(1)
      expect(rows).toEqual([{ project: 'srv', task: 'dev', status: 'success', hash: '' }])
    },
    TIMEOUT,
  )

  it(
    'a failed task with a skipped dependent records BOTH, and task_count = COUNT(*)',
    async () => {
      await addProject(
        fixture.root,
        'b',
        `export default { tasks: { build: { exec: { command: 'exit 3' } } } }`,
      )
      await addProject(
        fixture.root,
        'a',
        `export default {
          tasks: { build: { exec: { command: 'echo ok' }, dependsOn: ['^build'] } },
        }
        `,
        { b: 'workspace:*' },
      )
      // `a` is requested; `b#build` is pulled in by the `^build` edge, fails,
      // and its failure propagates as a skip to the requested task.
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['a'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(false)

      const { header, rows } = readRecorded(fixture.root)
      // Was 1 of 2 — the skipped dependent had no row at all.
      expect(header.task_count).toBe(2)
      expect(header.failed_count).toBe(1)
      expect(rows).toEqual([
        { project: 'a', task: 'build', status: 'skipped', hash: '' },
        { project: 'b', task: 'build', status: 'failed', hash: expect.any(String) },
      ])
      // b#build is a real (uncacheable) task, so it still derives a key; only
      // the skipped row carries the sentinel.
      expect(rows[1]!.hash).not.toBe('')
      // The header count and the rows can no longer disagree.
      expect(header.task_count).toBe(rows.length)
    },
    TIMEOUT,
  )

  it(
    'a failed persistent task reaches the recent-failures surface',
    async () => {
      await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo nope && sleep 2',
                timeout: 400,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      const db = new Database(path.join(fixture.root, '.vx', 'cache', 'cache.db'), {
        readonly: true,
      })
      try {
        const failures = getRecentFailures(db)
        expect(failures.map((f) => `${f.project}#${f.task}`)).toEqual(['srv#dev'])
      } finally {
        db.close()
      }
    },
    TIMEOUT,
  )
})

// ---------------------------------------------------------------------------
// The dilution guards: the new rows must not move any rate or mean.
// ---------------------------------------------------------------------------

const T0 = Date.now() - 60 * 60 * 1000

function mkRun(args: Partial<RunRecord> & { project: string; task: string }): RunRecord {
  return {
    ...(args.hash !== undefined ? { hash: args.hash } : {}),
    project: args.project,
    task: args.task,
    status: args.status ?? 'success',
    exitCode: args.exitCode ?? 0,
    durationMs: args.durationMs ?? 100,
    startedAt: args.startedAt ?? T0,
    endedAt: args.endedAt ?? T0 + 100,
    runId: args.runId ?? 'r-1',
    cacheHit: args.cacheHit ?? false,
  }
}

function mkInvocation(runId: string): InvocationRecord {
  return {
    runId,
    command: 'vx run build',
    requestedTasks: JSON.stringify(['build']),
    cachePolicy: 'lR,lW,rR,rW',
    concurrency: 8,
    flow: 'broad',
    startedAt: T0,
    endedAt: T0 + 100,
    totalDurationMs: 100,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    commitSha: 'abc123',
    branch: 'main',
    dirty: false,
    ci: false,
    ciProvider: null,
    host: 'h',
    os: 'linux',
    arch: 'x64',
    vxVersion: '0.0.0',
    tags: '{}',
  }
}

describe('a skipped row is a task of the run, never an execution', () => {
  let dir: string
  let cache: Cache
  let db: Database

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dilute-'))
    cache = new Cache(dir)
    db = cache.dbHandle()
  })
  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  /** Two real 100ms successes plus three skips for the same pair. */
  function seedSuccessesAndSkips(): void {
    cache.recordRunBundle({
      runs: [
        mkRun({ project: 'app', task: 'build', hash: 'k1', durationMs: 100 }),
        mkRun({ project: 'app', task: 'build', hash: 'k2', durationMs: 100 }),
        mkRun({ project: 'app', task: 'build', status: 'skipped', exitCode: 1, durationMs: 0 }),
        mkRun({ project: 'app', task: 'build', status: 'skipped', exitCode: 1, durationMs: 0 }),
        mkRun({ project: 'app', task: 'build', status: 'skipped', exitCode: 1, durationMs: 0 }),
      ],
      invocation: mkInvocation('r-1'),
    })
  }

  it('does not dilute getHistory runs / successRate / hitRate', () => {
    seedSuccessesAndSkips()
    const [row] = getHistory(db)
    expect(row?.runs).toBe(2)
    expect(row?.successes).toBe(2)
    expect(row?.successRate).toBe(1)
  })

  it('a task that has ONLY ever been skipped has no execution history', () => {
    cache.recordRunBundle({
      runs: [
        mkRun({ project: 'app', task: 'never', status: 'skipped', exitCode: 1, durationMs: 0 }),
      ],
      invocation: mkInvocation('r-1'),
    })
    expect(getHistory(db)).toEqual([])
  })

  it('does not drag listProjects avgDurationMs toward zero', () => {
    seedSuccessesAndSkips()
    const [p] = listProjects(db)
    expect(p?.runs).toBe(2)
    expect(p?.avgDurationMs).toBe(100)
  })

  it('does not dilute the 24h run count / hit rate, on EITHER copy of it', () => {
    seedSuccessesAndSkips()
    // Two implementations answer this: `Cache.stats` (what `vx info` and
    // `vx mcp getCacheStats` read) and `getCacheStatsSql` (the dashboard).
    // Pinning them equal is the drift guard — guarding one and not the other
    // is how the same number starts disagreeing with itself.
    expect(getCacheStatsSql(db).runCountLast24h).toBe(2)
    expect(cache.stats().runCountLast24h).toBe(2)
    expect(cache.stats().runCountLast24h).toBe(getCacheStatsSql(db).runCountLast24h)
  })

  it('does not dilute getFlakiestTasks failureRate', () => {
    // Same key both failed and succeeded => a real flake, surfaced. Its rate
    // is 1 failure in 3 EXECUTIONS, however many skips sit beside it.
    cache.recordRunBundle({
      runs: [
        mkRun({ project: 'app', task: 'test', hash: 'k1', status: 'failed', exitCode: 1 }),
        mkRun({ project: 'app', task: 'test', hash: 'k1' }),
        mkRun({ project: 'app', task: 'test', hash: 'k2' }),
        mkRun({ project: 'app', task: 'test', status: 'skipped', exitCode: 1, durationMs: 0 }),
        mkRun({ project: 'app', task: 'test', status: 'skipped', exitCode: 1, durationMs: 0 }),
        mkRun({ project: 'app', task: 'test', status: 'skipped', exitCode: 1, durationMs: 0 }),
      ],
      invocation: mkInvocation('r-1'),
    })
    const [flaky] = getFlakiestTasks(db)
    expect(flaky?.id).toBe('app#test')
    expect(flaky?.runs).toBe(3)
    expect(flaky?.failureRate).toBeCloseTo(1 / 3, 6)
  })

  it('does not dilute periodStats taskRuns', () => {
    seedSuccessesAndSkips()
    const cmp = getPeriodComparison(db, { windowDays: 7 })
    expect(cmp.current.stats.taskRuns).toBe(2)
    expect(cmp.current.stats.executed).toBe(2)
  })

  it('does not evict real history from the predictive window', async () => {
    // Window of 2: the skips are the NEWEST rows, so an unfiltered window
    // would hold nothing but skips and report a 0% success rate.
    cache.recordRunBundle({
      runs: [
        mkRun({ project: 'app', task: 'build', hash: 'k1', startedAt: T0, endedAt: T0 + 100 }),
        mkRun({ project: 'app', task: 'build', hash: 'k2', startedAt: T0 + 1, endedAt: T0 + 101 }),
        mkRun({
          project: 'app',
          task: 'build',
          status: 'skipped',
          exitCode: 1,
          durationMs: 0,
          startedAt: T0 + 2,
          endedAt: T0 + 2,
        }),
        mkRun({
          project: 'app',
          task: 'build',
          status: 'skipped',
          exitCode: 1,
          durationMs: 0,
          startedAt: T0 + 3,
          endedAt: T0 + 3,
        }),
      ],
      invocation: mkInvocation('r-1'),
    })
    const table = await new LocalHistoryProvider(db, 2).loadFor(['app#build'])
    const h = table.get('app#build')
    expect(h?.runs).toBe(2)
    expect(h?.successRate).toBe(1)
    expect(h?.p50DurationMs).toBe(100)
  })
})

describe('a row with no cache key is not evidence about inputs', () => {
  let dir: string
  let cache: Cache
  let db: Database

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-nokey-'))
    cache = new Cache(dir)
    db = cache.dbHandle()
  })
  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('whyDidThisRerun reports no verdict for a keyless row', () => {
    cache.recordRunBundle({
      runs: [
        mkRun({ project: 'app', task: 'build', hash: 'k1', runId: 'r-1', startedAt: T0 }),
        mkRun({
          project: 'app',
          task: 'build',
          status: 'skipped',
          exitCode: 1,
          durationMs: 0,
          runId: 'r-2',
          startedAt: T0 + 10,
        }),
      ],
      invocation: mkInvocation('r-1'),
    })
    const why = whyDidThisRerunQuery(db, 'r-2', 'app#build')
    expect(why.found).toBe(true)
    // Not `false` — two rows, one of which never had a key, cannot say the
    // inputs are unchanged.
    expect(why.hashChanged).toBeNull()
    expect(why.note).toContain('no cache key')
  })

  it('whyDidThisRerun compares against the previous KEYED run, past a skip', () => {
    cache.recordRunBundle({
      runs: [
        mkRun({ project: 'app', task: 'build', hash: 'k1', runId: 'r-1', startedAt: T0 }),
        mkRun({
          project: 'app',
          task: 'build',
          status: 'skipped',
          exitCode: 1,
          durationMs: 0,
          runId: 'r-2',
          startedAt: T0 + 10,
        }),
        mkRun({ project: 'app', task: 'build', hash: 'k2', runId: 'r-3', startedAt: T0 + 20 }),
      ],
      invocation: mkInvocation('r-1'),
    })
    const why = whyDidThisRerunQuery(db, 'r-3', 'app#build')
    expect(why.previousRun?.hash).toBe('k1')
    expect(why.hashChanged).toBe(true)
  })

  it('cacheKeyDiff does not claim "same inputs" for a keyless row', () => {
    cache.recordRunBundle({
      runs: [
        mkRun({ project: 'app', task: 'build', hash: 'k1', runId: 'r-1', startedAt: T0 }),
        mkRun({
          project: 'app',
          task: 'build',
          status: 'skipped',
          exitCode: 1,
          durationMs: 0,
          runId: 'r-2',
          startedAt: T0 + 10,
        }),
      ],
      invocation: mkInvocation('r-1'),
    })
    const diff = cacheKeyDiff(db, 'r-2', 'app#build')
    expect(diff.found).toBe(true)
    expect(diff.note).toContain('no cache key')
    expect(diff.entries).toEqual([])
  })
})
