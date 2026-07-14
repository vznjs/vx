import { beforeAll, describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import { Analytics } from '../src/db/analytics.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

// Seeded, pinned read-query port tests. Rows are inserted directly (not through
// ingest) so timestamps/statuses/durations are exact. A decoy second workspace
// proves every query is workspace-clamped.

const HOUR = 3_600_000
const DAY = 24 * HOUR

interface TR {
  runId: string
  project: string
  task: string
  status?: string
  duration?: number
  startedAt: number
  endedAt?: number
  cacheHit?: boolean | null
  attempts?: number | null
  hash?: string
  cpuMs?: number | null
  exitCode?: number
}

async function insertTR(db: DbClient, ws: string, org: string, t: TR): Promise<void> {
  const started = t.startedAt
  const ended = t.endedAt ?? started + (t.duration ?? 100)
  await db.sql`INSERT INTO task_runs (
      org_id, workspace_id, run_id, hash, project, task, status, exit_code, duration_ms,
      started_at, ended_at, cpu_ms, cache_hit, attempts)
    VALUES (${org}, ${ws}, ${t.runId}, ${t.hash ?? 'h-' + t.project + '-' + t.task},
            ${t.project}, ${t.task}, ${t.status ?? 'success'}, ${t.exitCode ?? 0},
            ${t.duration ?? 100}, ${started}, ${ended}, ${t.cpuMs ?? null},
            ${t.cacheHit ?? false}, ${t.attempts ?? null})`
}

interface INV {
  runId: string
  startedAt: number
  endedAt?: number
  branch?: string
  defaultBranch?: string | null
  ci?: boolean
  command?: string
  requestedTasks?: string[]
  tags?: Record<string, string>
  taskCount?: number
  failedCount?: number
  hitCount?: number
}

async function insertINV(db: DbClient, ws: string, org: string, v: INV): Promise<void> {
  await db.sql`INSERT INTO invocations (
      run_id, org_id, workspace_id, command, requested_tasks, cache_policy, concurrency, flow,
      started_at, ended_at, total_duration_ms, task_count, failed_count, hit_count,
      hit_local_count, hit_remote_count, exit_ok, branch, default_branch, ci, ci_provider, os, arch,
      vx_version, tags)
    VALUES (${v.runId}, ${org}, ${ws}, ${v.command ?? 'vx run build'},
            ${JSON.stringify(v.requestedTasks ?? ['build'])}::jsonb, ${'lR,lW,rR,rW'}, ${4},
            ${'broad'}, ${v.startedAt}, ${v.endedAt ?? v.startedAt + 500}, ${500},
            ${v.taskCount ?? 2}, ${v.failedCount ?? 0}, ${v.hitCount ?? 0}, ${0}, ${0},
            ${(v.failedCount ?? 0) === 0}, ${v.branch ?? 'main'}, ${v.defaultBranch ?? null},
            ${v.ci ?? true}, ${'github'},
            ${'linux'}, ${'x64'}, ${'0.0.0'}, ${JSON.stringify(v.tags ?? {})}::jsonb)`
}

async function newOrgWs(db: DbClient, tag: string): Promise<{ org: string; ws: string }> {
  const org = Bun.randomUUIDv7()
  const ws = Bun.randomUUIDv7()
  await db.sql`INSERT INTO organizations (id, slug, name, created_at)
               VALUES (${org}, ${'o-' + tag}, ${tag}, ${Date.now()})`
  await db.sql`INSERT INTO workspaces (id, org_id, slug, name, created_at)
               VALUES (${ws}, ${org}, ${'w-' + tag}, ${tag}, ${Date.now()})`
  return { org, ws }
}

let db: DbClient
let analytics: Analytics

beforeAll(async () => {
  const pg = await ephemeralPg()
  db = openDb(await pg.createDatabase())
  analytics = new Analytics(db.sql)
})

describe('base fixture reads', () => {
  let org: string
  let ws: string
  let now: number

  beforeAll(async () => {
    ;({ org, ws } = await newOrgWs(db, 'base'))
    now = Date.now()
    // R1 (oldest): both tasks ran (miss).
    await insertINV(db, ws, org, { runId: 'R1', startedAt: now - 3 * HOUR })
    await insertTR(db, ws, org, {
      runId: 'R1',
      project: 'app',
      task: 'build',
      duration: 100,
      startedAt: now - 3 * HOUR,
      hash: 'k1',
    })
    await insertTR(db, ws, org, {
      runId: 'R1',
      project: 'app',
      task: 'test',
      duration: 200,
      startedAt: now - 3 * HOUR,
    })
    // R2: build is a local cache hit; test failed.
    await insertINV(db, ws, org, {
      runId: 'R2',
      startedAt: now - 2 * HOUR,
      failedCount: 1,
      hitCount: 1,
    })
    await insertTR(db, ws, org, {
      runId: 'R2',
      project: 'app',
      task: 'build',
      status: 'cache-hit',
      duration: 5,
      startedAt: now - 2 * HOUR,
      cacheHit: true,
      hash: 'k1',
    })
    await insertTR(db, ws, org, {
      runId: 'R2',
      project: 'app',
      task: 'test',
      status: 'failed',
      exitCode: 1,
      duration: 50,
      startedAt: now - 2 * HOUR,
    })
    // R3 (newest): build ran with a CHANGED key; test passed; lib#lint retried.
    await insertINV(db, ws, org, { runId: 'R3', startedAt: now - HOUR, taskCount: 3 })
    await insertTR(db, ws, org, {
      runId: 'R3',
      project: 'app',
      task: 'build',
      duration: 120,
      startedAt: now - HOUR,
      cpuMs: 240,
      hash: 'k2',
    })
    await insertTR(db, ws, org, {
      runId: 'R3',
      project: 'app',
      task: 'test',
      duration: 210,
      startedAt: now - HOUR + 10,
      cpuMs: 200,
    })
    await insertTR(db, ws, org, {
      runId: 'R3',
      project: 'lib',
      task: 'lint',
      duration: 80,
      startedAt: now - HOUR,
      attempts: 2,
    })

    // Decoy workspace — must never leak into the reads above.
    const decoy = await newOrgWs(db, 'decoy')
    await insertINV(db, decoy.ws, decoy.org, { runId: 'D1', startedAt: now })
    await insertTR(db, decoy.ws, decoy.org, {
      runId: 'D1',
      project: 'zzz',
      task: 'zzz',
      startedAt: now,
    })
  })

  it('listRuns is newest-first and workspace-clamped', async () => {
    const all = await analytics.listRuns(ws)
    expect(all).toHaveLength(7)
    expect(all[0]!.startedAt).toBeGreaterThanOrEqual(all[1]!.startedAt)
    expect(all.every((r) => r.project !== 'zzz')).toBe(true)
    const build = await analytics.listRuns(ws, { project: 'app', task: 'build' })
    expect(build).toHaveLength(3)
    expect(build[0]!.cacheHit === false || build[0]!.cacheHit === true).toBe(true)
  })

  it('getRun bundles a run and computes its span', async () => {
    const run = await analytics.getRun(ws, 'R3')
    expect(run).not.toBeNull()
    expect(run!.tasks).toHaveLength(3)
    expect(run!.startedAt).toBe(now - HOUR)
    expect(await analytics.getRun(ws, 'nope')).toBeNull()
  })

  it('getInvocation + listInvocations read the header table', async () => {
    const inv = await analytics.getInvocation(ws, 'R2')
    expect(inv).not.toBeNull()
    expect(inv!.failedCount).toBe(1)
    expect(inv!.branch).toBe('main')
    expect(inv!.requestedTasks).toEqual(['build'])
    const list = await analytics.listInvocations(ws)
    expect(list.map((i) => i.runId)).toEqual(['R3', 'R2', 'R1'])
    const onMain = await analytics.listInvocations(ws, { branch: 'main' })
    expect(onMain).toHaveLength(3)
    expect(await analytics.listInvocations(ws, { branch: 'other' })).toHaveLength(0)
  })

  it('getCacheStatsSql / getHitRateSplit count hits over the window', async () => {
    const stats = await analytics.getCacheStatsSql(ws)
    expect(stats.entryCount).toBe(0)
    expect(stats.totalBytes).toBe(0)
    expect(stats.runCountLast24h).toBe(7)
    expect(stats.hitLocalCountLast24h).toBe(1)
    expect(stats.hitRemoteCountLast24h).toBe(0)
    expect(stats.hitCountLast24h).toBe(1)
    const split = await analytics.getHitRateSplit(ws, 1)
    expect(split.total).toBe(7)
    expect(split.hitLocal).toBe(1)
    expect(split.localShare).toBe(1)
  })

  it('getHistory aggregates per (project, task)', async () => {
    const buildHist = await analytics.getHistory(ws, { project: 'app', task: 'build' })
    expect(buildHist).toHaveLength(1)
    const h = buildHist[0]!
    expect(h.id).toBe('app#build')
    expect(h.runs).toBe(3) // 2 success + 1 hit
    expect(h.successes).toBe(2)
    expect(h.hits).toBe(1)
    // avg over the two executed successes (100, 120) = 110.
    expect(h.avgDurationMs).toBe(110)
    expect(h.p50DurationMs).toBe(120)
  })

  it('getHistory (batched, all pairs) matches the per-pair filtered result', async () => {
    // The unfiltered path builds every pair from two set-based queries; each
    // row must equal what the single-pair filtered query returns.
    const all = await analytics.getHistory(ws)
    expect(all.length).toBeGreaterThan(1)
    for (const id of ['app#build', 'app#test']) {
      const [project, task] = id.split('#') as [string, string]
      const batched = all.find((r) => r.id === id)!
      const [single] = await analytics.getHistory(ws, { project, task })
      expect(batched).toEqual(single!)
    }
  })

  it('getTopTimeBurners ranks executed successes by total duration', async () => {
    const top = await analytics.getTopTimeBurners(ws)
    // app#test executed successes: 200 + 210 = 410 (R2 failed excluded).
    const test = top.find((t) => t.id === 'app#test')!
    expect(test.totalDurationMs).toBe(410)
    expect(test.runs).toBe(2)
    expect(test.avgDurationMs).toBe(205)
    // ordered by total desc → app#test first (410 > build 220 > lint 80).
    expect(top[0]!.id).toBe('app#test')
  })

  it('getRecentFailures lists failed rows newest-first', async () => {
    const fails = await analytics.getRecentFailures(ws)
    expect(fails).toHaveLength(1)
    expect(fails[0]).toMatchObject({ runId: 'R2', project: 'app', task: 'test', exitCode: 1 })
  })

  it('getTaskDetail returns aggregate + recent + null entry', async () => {
    const detail = await analytics.getTaskDetail(ws, 'app#build')
    expect(detail).not.toBeNull()
    expect(detail!.aggregate!.runs).toBe(3)
    expect(detail!.recent).toHaveLength(3)
    expect(detail!.latestEntry).toBeNull()
    expect(await analytics.getTaskDetail(ws, 'no#such')).toBeNull()
  })

  it('listProjects rolls up per project with zero cache inventory', async () => {
    const projects = await analytics.listProjects(ws)
    const app = projects.find((p) => p.project === 'app')!
    expect(app.taskCount).toBe(2)
    expect(app.runs).toBe(6) // R1 build+test, R2 build+test, R3 build+test
    expect(app.failures).toBe(1)
    expect(app.hits).toBe(1)
    expect(app.cacheBytes).toBe(0)
    expect(app.cacheEntries).toBe(0)
    expect(projects.find((p) => p.project === 'lib')!.taskCount).toBe(1)
  })

  it('getFlakiestTasks confirms the retried task and ranks it first', async () => {
    const flaky = await analytics.getFlakiestTasks(ws)
    const lint = flaky.find((f) => f.id === 'lib#lint')
    expect(lint).toBeDefined()
    expect(lint!.flakyConfirmed).toBe(true)
    expect(lint!.withinRunRetries).toBe(1)
    expect(lint!.maxAttempts).toBe(2)
    // confirmed-flaky outranks the merely-failing app#test.
    expect(flaky[0]!.id).toBe('lib#lint')
  })

  it('whyDidThisRerun names the key change', async () => {
    const why = await analytics.whyDidThisRerun(ws, 'R3', 'app#build')
    expect(why.found).toBe(true)
    expect(why.hashChanged).toBe(true) // k2 vs previous k1
    expect(why.thisRun!.hash).toBe('k2')
    expect(why.previousRun!.hash).toBe('k1')
    const miss = await analytics.whyDidThisRerun(ws, 'R3', 'no#such')
    expect(miss.found).toBe(false)
  })

  it('cacheKeyDiff degrades to the fingerprints-unavailable note', async () => {
    const diff = await analytics.cacheKeyDiff(ws, 'R3', 'app#build')
    expect(diff.found).toBe(true)
    expect(diff.previousRunId).toBe('R2')
    expect(diff.entries).toEqual([])
    expect(diff.note).toContain('input fingerprints are unavailable')
    // Same key (R2 vs R1 build were both k1) → unchanged note.
    const same = await analytics.cacheKeyDiff(ws, 'R2', 'app#build')
    expect(same.note).toContain('unchanged')
  })

  it('whyRunReran batches every executed task of a run into one verdict list', async () => {
    const rows = await analytics.whyRunReran(ws, 'R3')
    // All three R3 tasks executed (status success) → one row each, sorted.
    expect(rows.map((r) => r.taskId)).toEqual(['app#build', 'app#test', 'lib#lint'])
    const byId = new Map(rows.map((r) => [r.taskId, r]))
    // build: k2 vs the prior run's k1 → the key changed.
    expect(byId.get('app#build')!.reason).toBe('inputs changed')
    expect(byId.get('app#build')!.previousRunId).toBe('R2')
    // test: same hash as its prior run → ran without a cache hit.
    expect(byId.get('app#test')!.reason).toContain('not cacheable')
    // lint: first ever run of this (project, task) → no prior to diff.
    expect(byId.get('lib#lint')!.reason).toBe('first run')
    expect(byId.get('lib#lint')!.previousRunId).toBeNull()
    // Workspace-clamped: the decoy run yields nothing here.
    expect(await analytics.whyRunReran(ws, 'D1')).toEqual([])
  })

  it('compareRuns diffs a run against the previous invocation', async () => {
    const cmp = await analytics.compareRuns(ws, 'R3')
    expect(cmp.found).toBe(true)
    expect(cmp.previousRunId).toBe('R2')
    // app#build changed key (k2 vs k1) and lib#lint is only in R3.
    const build = cmp.tasks.find((t) => t.taskId === 'app#build')!
    expect(build.hashChanged).toBe(true)
    const lint = cmp.tasks.find((t) => t.taskId === 'lib#lint')!
    expect(lint.b).toBeNull()
    expect(cmp.summary.tasksOnlyInA).toBeGreaterThanOrEqual(1)
  })

  it('getParallelismHistory computes the cpu/wall factor', async () => {
    const par = await analytics.getParallelismHistory(ws)
    const r3 = par.find((p) => p.runId === 'R3')!
    expect(r3.taskCount).toBe(3)
    expect(r3.cpuSumMs).toBeGreaterThan(0)
    expect(r3.factor).toBeGreaterThan(0)
  })

  it('getBottlenecks extrapolates weekly burn', async () => {
    const bn = await analytics.getBottlenecks(ws)
    const test = bn.find((b) => b.id === 'app#test')!
    expect(test.runsRecent).toBe(2)
    expect(test.weeklySavingsAt25PctCutMs).toBeGreaterThan(0)
  })

  it('getRunHeatmap buckets every run into the 7×24 grid', async () => {
    const grid = await analytics.getRunHeatmap(ws)
    expect(grid).toHaveLength(168)
    expect(grid.reduce((n, c) => n + c.runs, 0)).toBe(7)
  })

  it('cache-entry inventory queries return shaped empties', async () => {
    expect(await analytics.listCacheEntries(ws)).toEqual([])
    expect(await analytics.getCacheBreakdown(ws)).toEqual([])
    expect(await analytics.getPrunableEntries(ws)).toEqual([])
    const growth = await analytics.getStorageGrowth(ws, 3)
    expect(growth.every((p) => p.bytesAdded === 0 && p.entriesAdded === 0)).toBe(true)
  })

  it('getCacheSavings attributes avg non-hit duration to hits', async () => {
    const savings = await analytics.getCacheSavings(ws)
    // one hit (R2 build); avg executed build duration = 110 → ~110ms saved.
    expect(savings.hitsLast24h).toBe(1)
    expect(savings.estimatedTimeSavedMs).toBe(110)
  })
})

describe('getRunTrends', () => {
  it('buckets by hour and densifies empty buckets', async () => {
    const { org, ws } = await newOrgWs(db, 'trends')
    const to = Date.now()
    const h = 3_600_000
    await insertTR(db, ws, org, {
      runId: 't1',
      project: 'a',
      task: 'b',
      startedAt: to - 30 * 60_000,
    })
    await insertTR(db, ws, org, {
      runId: 't2',
      project: 'a',
      task: 'b',
      status: 'cache-hit',
      cacheHit: true,
      startedAt: to - 20 * 60_000,
    })
    const points = await analytics.getRunTrends(ws, { bucket: 'hour', from: to - 2 * h, to })
    expect(points.length).toBeGreaterThanOrEqual(2)
    const total = points.reduce((n, p) => n + p.runs, 0)
    expect(total).toBe(2)
    expect(points.reduce((n, p) => n + p.hits, 0)).toBe(1)
    expect(points.reduce((n, p) => n + p.hitsLocal, 0)).toBe(1)
  })
})

describe('getPeriodComparison', () => {
  it('splits into two adjacent windows and ranks movers (COALESCEs an empty prior window)', async () => {
    const { org, ws } = await newOrgWs(db, 'period')
    const end = Date.now()
    const win = 7 * DAY
    // Rows seeded safely inside each half-open window (away from boundaries).
    // Previous window [end-2w, end-w): task ran at 100ms.
    for (let i = 0; i < 3; i++) {
      await insertTR(db, ws, org, {
        runId: `p${i}`,
        project: 'app',
        task: 'build',
        duration: 100,
        startedAt: end - win - (i + 1) * HOUR,
      })
    }
    // Current window [end-w, end): task got slower (200ms).
    for (let i = 0; i < 3; i++) {
      await insertTR(db, ws, org, {
        runId: `c${i}`,
        project: 'app',
        task: 'build',
        duration: 200,
        startedAt: end - (i + 1) * HOUR,
      })
    }
    const cmp = await analytics.getPeriodComparison(ws, { windowDays: 7, endMs: end, minRuns: 3 })
    expect(cmp.current.stats.executed).toBe(3)
    expect(cmp.previous.stats.executed).toBe(3)
    // Empty-window NULL fix: numbers, never null.
    expect(typeof cmp.previous.stats.failures).toBe('number')
    const mover = cmp.movers.find((m) => m.id === 'app#build')!
    expect(mover.currentAvgMs).toBe(200)
    expect(mover.previousAvgMs).toBe(100)
    expect(mover.deltaMs).toBe(100)
  })

  it('a fresh workspace with an empty prior window never returns null stats', async () => {
    const { org, ws } = await newOrgWs(db, 'period-fresh')
    const end = Date.now()
    await insertTR(db, ws, org, { runId: 'x', project: 'a', task: 'b', startedAt: end - HOUR })
    const cmp = await analytics.getPeriodComparison(ws, { windowDays: 7, endMs: end })
    expect(cmp.previous.stats.runs).toBe(0)
    expect(cmp.previous.stats.failures).toBe(0)
    expect(cmp.previous.stats.totalDurationMs).toBe(0)
  })
})

describe('getRegressions', () => {
  it('surfaces a task failing on >= minBranches branches that used to pass', async () => {
    const { org, ws } = await newOrgWs(db, 'regress')
    const now = Date.now()
    // A prior success so it counts as regressed, not always-broken.
    await insertINV(db, ws, org, { runId: 'old', startedAt: now - 5 * DAY, branch: 'main' })
    await insertTR(db, ws, org, {
      runId: 'old',
      project: 'app',
      task: 'e2e',
      status: 'success',
      startedAt: now - 5 * DAY,
    })
    // Now failing on two branches (latest run per branch is a failure).
    for (const [i, br] of ['main', 'feat'].entries()) {
      await insertINV(db, ws, org, { runId: `f${i}`, startedAt: now - HOUR, branch: br })
      await insertTR(db, ws, org, {
        runId: `f${i}`,
        project: 'app',
        task: 'e2e',
        status: 'failed',
        exitCode: 1,
        startedAt: now - HOUR,
      })
    }
    const regs = await analytics.getRegressions(ws, { sinceDays: 7, minBranches: 2 })
    expect(regs).toHaveLength(1)
    expect(regs[0]!.id).toBe('app#e2e')
    expect(regs[0]!.branchesFailing).toBe(2)
    expect(regs[0]!.regressed).toBe(true)
    // A single-branch failure isn't surfaced at minBranches 2.
    expect(await analytics.getRegressions(ws, { sinceDays: 7, minBranches: 3 })).toHaveLength(0)
  })
})

describe('hermeticity + logs', () => {
  it('reports cross-platform fingerprint divergence', async () => {
    const { org, ws } = await newOrgWs(db, 'herm')
    const now = Date.now()
    const put = async (
      osName: string,
      arch: string,
      tree: string,
      files: [string, string][],
    ): Promise<void> => {
      await db.sql`INSERT INTO output_fingerprints (
          org_id, workspace_id, hash, os, arch, tree, file_count, files, truncated, task_id, run_id, host, created_at)
        VALUES (${org}, ${ws}, ${'hh'}, ${osName}, ${arch}, ${tree}, ${files.length},
                ${JSON.stringify(files)}::jsonb, ${false}, ${'app#build'}, ${'r'}, ${null}, ${now})`
    }
    await put('linux', 'x64', 'tree-a', [['dist/x.js', 'oid-a']])
    await put('darwin', 'arm64', 'tree-b', [['dist/x.js', 'oid-b']])
    const res = await analytics.hermeticity(ws, 50)
    expect(res.keysTracked).toBe(1)
    expect(res.reportCount).toBe(2)
    expect(res.divergent).toHaveLength(1)
    expect(res.divergent[0]!.crossPlatform).toBe(true)
    expect(res.divergent[0]!.changed).toEqual(['dist/x.js'])
  })

  it('logFor + logByHash round-trip a stored tail', async () => {
    const { org, ws } = await newOrgWs(db, 'logs')
    await db.sql`INSERT INTO task_logs (
        org_id, workspace_id, run_id, task_id, hash, status, codec, content, chars_full, truncated_head, created_at)
      VALUES (${org}, ${ws}, ${'R1'}, ${'app#build'}, ${'kh'}, ${'failed'}, ${'plain'},
              ${Buffer.from('boom\n', 'utf8')}, ${5}, ${0}, ${Date.now()})`
    const got = await analytics.logFor(ws, 'R1', 'app#build')
    expect(got?.content).toBe('boom\n')
    expect(got?.status).toBe('failed')
    const byHash = await analytics.logByHash(ws, 'kh')
    expect(byHash?.content).toBe('boom\n')
    expect(await analytics.logFor(ws, 'R1', 'nope')).toBeUndefined()
  })
})

describe('wiring helpers', () => {
  it('provenanceForHashes + taskDurationHints', async () => {
    const { org, ws } = await newOrgWs(db, 'wire')
    const now = Date.now()
    await insertTR(db, ws, org, {
      runId: 'w1',
      project: 'app',
      task: 'build',
      duration: 100,
      startedAt: now - HOUR,
      hash: 'HH',
    })
    await insertTR(db, ws, org, {
      runId: 'w2',
      project: 'app',
      task: 'build',
      duration: 300,
      startedAt: now,
      hash: 'HH',
    })
    const prov = await analytics.provenanceForHashes(ws, ['HH'])
    expect(prov.get('HH')).toMatchObject({ project: 'app', task: 'build', runId: 'w2' })
    expect(await analytics.provenanceForHashes(ws, [])).toEqual(new Map())
    const hints = await analytics.taskDurationHints(ws)
    expect(hints.get('app#build')).toBe(200) // mean of 100, 300
  })

  it('taskDurationHints averages TRUNK runs only, excluding a branch experiment', async () => {
    const { org, ws } = await newOrgWs(db, 'trunk-hint')
    const now = Date.now()
    // Two trunk (main == default) runs of app#build: 100, 200 → trunk mean 150.
    await insertINV(db, ws, org, {
      runId: 't1',
      startedAt: now - 3 * HOUR,
      branch: 'main',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 't1',
      project: 'app',
      task: 'build',
      duration: 100,
      startedAt: now - 3 * HOUR,
    })
    await insertINV(db, ws, org, {
      runId: 't2',
      startedAt: now - 2 * HOUR,
      branch: 'main',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 't2',
      project: 'app',
      task: 'build',
      duration: 200,
      startedAt: now - 2 * HOUR,
    })
    // A branch EXPERIMENT that made the task 10x slower — must NOT pollute the
    // shared hint (head branch 'exp' != default 'main').
    await insertINV(db, ws, org, {
      runId: 't3',
      startedAt: now - HOUR,
      branch: 'exp',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 't3',
      project: 'app',
      task: 'build',
      duration: 2000,
      startedAt: now - HOUR,
    })
    const hints = await analytics.taskDurationHints(ws)
    expect(hints.get('app#build')).toBe(150) // mean of 100,200 — 2000 excluded
  })

  it('taskDurationHints falls back to ALL runs for a task with no trunk data', async () => {
    const { org, ws } = await newOrgWs(db, 'trunk-fallback')
    const now = Date.now()
    // 'lint' only ever ran on branches (no trunk row): fall back to all → mean.
    await insertINV(db, ws, org, {
      runId: 'f1',
      startedAt: now - 2 * HOUR,
      branch: 'exp',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'f1',
      project: 'app',
      task: 'lint',
      duration: 300,
      startedAt: now - 2 * HOUR,
    })
    await insertINV(db, ws, org, {
      runId: 'f2',
      startedAt: now - HOUR,
      branch: 'exp2',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'f2',
      project: 'app',
      task: 'lint',
      duration: 500,
      startedAt: now - HOUR,
    })
    // A run whose default branch was never detected (default_branch NULL) also
    // must contribute — the client couldn't tell trunk from branch.
    await insertINV(db, ws, org, {
      runId: 'f3',
      startedAt: now - 30 * 60_000,
      branch: 'whatever',
      defaultBranch: null,
    })
    await insertTR(db, ws, org, {
      runId: 'f3',
      project: 'app',
      task: 'lint',
      duration: 400,
      startedAt: now - 30 * 60_000,
    })
    const hints = await analytics.taskDurationHints(ws)
    expect(hints.get('app#lint')).toBe(400) // mean of 300,500,400 — no trunk data
  })
})

describe('getNotifications', () => {
  it('lists failed invocations newest-first, workspace-clamped', async () => {
    const { org, ws } = await newOrgWs(db, 'notif')
    const decoy = await newOrgWs(db, 'notif-decoy')
    const now = Date.now()
    // Two failed builds + one green one; only the failures notify.
    await insertINV(db, ws, org, {
      runId: 'N1',
      startedAt: now - 2 * HOUR,
      branch: 'main',
      failedCount: 3,
      taskCount: 10,
    })
    await insertINV(db, ws, org, { runId: 'N2', startedAt: now - HOUR, failedCount: 0 }) // green
    await insertINV(db, ws, org, {
      runId: 'N3',
      startedAt: now,
      branch: 'feat-x',
      failedCount: 1,
      taskCount: 4,
    })
    // A failure in another workspace must never leak.
    await insertINV(db, decoy.ws, decoy.org, { runId: 'X1', startedAt: now, failedCount: 9 })

    const notes = await analytics.getNotifications(ws)
    expect(notes.map((n) => n.runId)).toEqual(['N3', 'N1']) // newest-first, green excluded
    expect(notes[0]).toMatchObject({
      kind: 'run-failed',
      runId: 'N3',
      branch: 'feat-x',
      failedCount: 1,
      taskCount: 4,
    })
    expect(notes.some((n) => n.runId === 'X1')).toBe(false) // no cross-workspace leak
  })

  it('respects the limit', async () => {
    const { org, ws } = await newOrgWs(db, 'notif-limit')
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await insertINV(db, ws, org, { runId: `L${i}`, startedAt: now - i * HOUR, failedCount: 1 })
    }
    expect(await analytics.getNotifications(ws, 3)).toHaveLength(3)
  })
})
