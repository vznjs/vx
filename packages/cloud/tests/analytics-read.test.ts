import { beforeAll, describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import { Analytics, type HeatmapCell } from '../src/db/analytics.js'
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
  commit?: string | null
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
      hit_local_count, hit_remote_count, exit_ok, commit_sha, branch, default_branch, ci, ci_provider,
      os, arch, vx_version, tags)
    VALUES (${v.runId}, ${org}, ${ws}, ${v.command ?? 'vx run build'},
            ${JSON.stringify(v.requestedTasks ?? ['build'])}::jsonb, ${'lR,lW,rR,rW'}, ${4},
            ${'broad'}, ${v.startedAt}, ${v.endedAt ?? v.startedAt + 500}, ${500},
            ${v.taskCount ?? 2}, ${v.failedCount ?? 0}, ${v.hitCount ?? 0}, ${0}, ${0},
            ${(v.failedCount ?? 0) === 0}, ${v.commit ?? null}, ${v.branch ?? 'main'},
            ${v.defaultBranch ?? null}, ${v.ci ?? true}, ${'github'},
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

  it('getCacheStatsSql windows by windowDays (the timeframe selector)', async () => {
    const { org, ws: tw } = await newOrgWs(db, 'stats-window')
    const now = Date.now()
    // One run inside 24h, one at ~3 days old.
    await insertTR(db, tw, org, { runId: 'r-now', project: 'p', task: 't', startedAt: now - HOUR })
    await insertTR(db, tw, org, {
      runId: 'r-old',
      project: 'p',
      task: 't',
      startedAt: now - 3 * DAY,
    })
    // Default (24h) sees only the recent run; a 7-day window sees both.
    expect((await analytics.getCacheStatsSql(tw)).runCountLast24h).toBe(1)
    expect((await analytics.getCacheStatsSql(tw, 7)).runCountLast24h).toBe(2)
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

  it('re-push safety: why/diff never resolve "previous" to the run\'s own copy', async () => {
    const { org: o2, ws: w2 } = await newOrgWs(db, 'why-repush')
    const now = Date.now()
    // The real previous run (key A), then run W (key B) re-pushed +60s —
    // duplicating W's row at a shifted started_at.
    await insertTR(db, w2, o2, {
      runId: 'WP',
      project: 'app',
      task: 'build',
      hash: 'A',
      startedAt: now - 2 * HOUR,
    })
    await insertTR(db, w2, o2, {
      runId: 'W',
      project: 'app',
      task: 'build',
      hash: 'B',
      startedAt: now - HOUR,
    })
    await insertTR(db, w2, o2, {
      runId: 'W',
      project: 'app',
      task: 'build',
      hash: 'B',
      startedAt: now - HOUR + 60_000,
    })
    // Batched panel: ONE row, previous = the REAL prior run, key changed.
    const rows = await analytics.whyRunReran(w2, 'W')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.previousRunId).toBe('WP')
    expect(rows[0]!.reason).toBe('inputs changed')
    // Single-task why: same anchor + exclusion convention.
    const why = await analytics.whyDidThisRerun(w2, 'W', 'app#build')
    expect(why.found).toBe(true)
    expect(why.previousRun?.hash).toBe('A')
    // Diff: previous is WP, and the hashes differ.
    const diff = await analytics.cacheKeyDiff(w2, 'W', 'app#build')
    expect(diff.previousRunId).toBe('WP')
    expect(diff.note).not.toContain('unchanged')
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

  it('compareRuns survives a re-pushed run (two invocation headers)', async () => {
    // invocations' uniqueness is (started_at, run_id): a re-push with a changed
    // startedAt yields TWO headers for one run. compareRuns' prev-lookup scalar
    // subquery `started_at < (SELECT started_at FROM invocations WHERE run_id=…)`
    // would then match >1 row → a hard cardinality error (500), not a diff.
    const { org, ws: w } = await newOrgWs(db, 'cmp-dupe')
    const now = Date.now()
    // A prior run to compare against.
    await insertINV(db, w, org, { runId: 'old', startedAt: now - 2 * HOUR })
    await insertTR(db, w, org, {
      runId: 'old',
      project: 'app',
      task: 'build',
      duration: 100,
      startedAt: now - 2 * HOUR,
      hash: 'k1',
    })
    // The current run, re-pushed → TWO headers (different startedAt).
    for (const started of [now - HOUR, now]) {
      await insertINV(db, w, org, { runId: 'cur', startedAt: started })
    }
    await insertTR(db, w, org, {
      runId: 'cur',
      project: 'app',
      task: 'build',
      duration: 200,
      startedAt: now - HOUR,
      hash: 'k2',
    })
    // Must not throw; picks the prior run deterministically.
    const cmp = await analytics.compareRuns(w, 'cur')
    expect(cmp.found).toBe(true)
    expect(cmp.previousRunId).toBe('old')
    expect(cmp.tasks.find((t) => t.taskId === 'app#build')!.hashChanged).toBe(true)
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

  it('buckets each run into the correct UTC day-of-week/hour cell (SQL EXTRACT == getUTCDay)', async () => {
    const { org, ws: hw } = await newOrgWs(db, 'heat-utc')
    // A recent, known UTC instant, plus one at HH:59:59.999 (the sub-second edge
    // the integer `started_at/1000` truncation must never push across an hour).
    const a = Date.parse('2026-07-10T13:20:00.000Z') // Friday 13:00 UTC cell
    const b = Date.parse('2026-07-06T08:59:59.999Z') // Monday 08:00 UTC cell
    await insertTR(db, hw, org, {
      runId: 'ha',
      project: 'p',
      task: 't',
      duration: 40,
      startedAt: a,
    })
    await insertTR(db, hw, org, {
      runId: 'hb',
      project: 'p',
      task: 't',
      duration: 60,
      startedAt: b,
    })
    const grid = await analytics.getRunHeatmap(hw, 3650)
    const cell = (t: number): HeatmapCell =>
      grid[new Date(t).getUTCDay() * 24 + new Date(t).getUTCHours()]!
    expect(cell(a).runs).toBe(1)
    expect(cell(a).totalDurationMs).toBe(40)
    expect(cell(b).runs).toBe(1)
    expect(cell(b).hourOfDay).toBe(8) // truncation did NOT cross into hour 9
    expect(grid.reduce((n, c) => n + c.runs, 0)).toBe(2)
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

  it('clamps a hostile from/to span so the fill loop stays bounded (no DoS)', async () => {
    const { ws } = await newOrgWs(db, 'trends-dos')
    // `?from=0&to=1e15` would drive an unclamped hourly fill loop into ~2.7e8
    // iterations, freezing the single-threaded multi-tenant server. The clamp
    // caps the point count and returns promptly.
    const t0 = performance.now()
    const points = await analytics.getRunTrends(ws, { bucket: 'hour', from: 0, to: 1e15 })
    expect(points.length).toBeLessThanOrEqual(10_000)
    expect(performance.now() - t0).toBeLessThan(1000)
    // Day buckets over the same absurd span are likewise bounded.
    const daily = await analytics.getStorageGrowth(ws, 1e9)
    expect(daily.length).toBeLessThanOrEqual(367)
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
    // Empty executed-success set → percentile FILTER is NULL → undefined.
    expect(cmp.previous.stats.p50DurationMs).toBeUndefined()
  })

  it('computes avg/p50/p95 in SQL over the executed-success subset', async () => {
    const { org, ws } = await newOrgWs(db, 'period-pct')
    const end = Date.now()
    // Five successful execs spread 100..500 in the current window, plus a
    // cache-hit and a failure that must NOT enter the percentile base.
    for (const [i, d] of [100, 200, 300, 400, 500].entries()) {
      await insertTR(db, ws, org, {
        runId: `s${i}`,
        project: 'app',
        task: 'build',
        duration: d,
        startedAt: end - (i + 1) * HOUR,
      })
    }
    await insertTR(db, ws, org, {
      runId: 'hit',
      project: 'app',
      task: 'build',
      status: 'cache-hit',
      cacheHit: true,
      duration: 9,
      startedAt: end - 6 * HOUR,
    })
    await insertTR(db, ws, org, {
      runId: 'fail',
      project: 'app',
      task: 'build',
      status: 'failed',
      exitCode: 1,
      duration: 9999,
      startedAt: end - 6 * HOUR,
    })
    const cmp = await analytics.getPeriodComparison(ws, { windowDays: 7, endMs: end, minRuns: 1 })
    const s = cmp.current.stats
    expect(s.avgDurationMs).toBe(300) // (100+200+300+400+500)/5
    expect(s.p50DurationMs).toBe(300) // percentile_cont(0.5) over the 5 = middle
    expect(s.p95DurationMs).toBe(480) // 0.95*(5-1)=3.8 → 400 + 0.8*(500-400)
  })
})

describe('triageRun', () => {
  it('classifies each failed task: flaky / pre-existing / new-failure', async () => {
    const { org, ws } = await newOrgWs(db, 'triage')
    const now = Date.now()
    // T0 (oldest trunk run): svc#both succeeded on key X.
    await insertINV(db, ws, org, {
      runId: 'T0',
      startedAt: now - 6 * HOUR,
      branch: 'main',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'T0',
      project: 'svc',
      task: 'both',
      hash: 'X',
      startedAt: now - 6 * HOUR,
    })
    // T1 (latest trunk run): flappy green on F, broken FAILED on B1, solid
    // green on S1, both FAILED on X2.
    await insertINV(db, ws, org, {
      runId: 'T1',
      startedAt: now - 5 * HOUR,
      branch: 'main',
      defaultBranch: 'main',
      failedCount: 2,
    })
    await insertTR(db, ws, org, {
      runId: 'T1',
      project: 'svc',
      task: 'flappy',
      hash: 'F',
      startedAt: now - 5 * HOUR,
    })
    await insertTR(db, ws, org, {
      runId: 'T1',
      project: 'svc',
      task: 'broken',
      hash: 'B1',
      status: 'failed',
      exitCode: 1,
      startedAt: now - 5 * HOUR,
    })
    await insertTR(db, ws, org, {
      runId: 'T1',
      project: 'svc',
      task: 'solid',
      hash: 'S1',
      startedAt: now - 5 * HOUR,
    })
    await insertTR(db, ws, org, {
      runId: 'T1',
      project: 'svc',
      task: 'both',
      hash: 'X2',
      status: 'failed',
      exitCode: 1,
      startedAt: now - 5 * HOUR,
    })
    // PR1 (the triaged run, a feature branch): five failures + one success.
    await insertINV(db, ws, org, {
      runId: 'PR1',
      startedAt: now - HOUR,
      branch: 'feat',
      defaultBranch: 'main',
      failedCount: 5,
    })
    const pr = (t: Omit<TR, 'runId' | 'startedAt'>) =>
      insertTR(db, ws, org, { runId: 'PR1', startedAt: now - HOUR, ...t })
    await pr({ project: 'svc', task: 'flappy', hash: 'F', status: 'failed', exitCode: 1 })
    await pr({ project: 'svc', task: 'broken', hash: 'B2', status: 'failed', exitCode: 1 })
    await pr({ project: 'svc', task: 'solid', hash: 'S2', status: 'failed', exitCode: 1 })
    await pr({ project: 'svc', task: 'fresh', hash: 'N1', status: 'failed', exitCode: 1 })
    await pr({ project: 'svc', task: 'both', hash: 'X', status: 'failed', exitCode: 1 })
    await pr({ project: 'svc', task: 'green', hash: 'G1' })
    // Decoy: a FOREIGN workspace with the same runId + a green same-key row —
    // must never leak into this workspace's verdicts.
    const foreign = await newOrgWs(db, 'triage-decoy')
    // +1ms: the (started_at, run_id, project, task) idempotency index is
    // table-wide, so a byte-identical decoy would collide with the real row.
    await insertTR(db, foreign.ws, foreign.org, {
      runId: 'PR1',
      project: 'svc',
      task: 'flappy',
      hash: 'F',
      startedAt: now - HOUR + 1,
    })

    const rows = await analytics.triageRun(ws, 'PR1')
    // Only the FAILED tasks, ordered by (project, task).
    expect(rows.map((r) => r.taskId)).toEqual([
      'svc#both',
      'svc#broken',
      'svc#flappy',
      'svc#fresh',
      'svc#solid',
    ])
    const byId = new Map(rows.map((r) => [r.taskId, r]))

    // flappy: same key F succeeded on trunk → flaky (decoy ws not counted).
    const flappy = byId.get('svc#flappy')!
    expect(flappy.verdict).toBe('flaky')
    expect(flappy.sameKeySuccesses).toBe(1)

    // broken: unique key, but trunk's LATEST run of the task also failed.
    const broken = byId.get('svc#broken')!
    expect(broken.verdict).toBe('pre-existing')
    expect(broken.defaultBranchFailing).toBe(true)
    expect(broken.defaultBranchRunId).toBe('T1')

    // solid: key changed vs its previous run, trunk is green → new failure.
    const solid = byId.get('svc#solid')!
    expect(solid.verdict).toBe('new-failure')
    expect(solid.keyChanged).toBe(true)
    expect(solid.previousRunId).toBe('T1')
    expect(solid.defaultBranchFailing).toBe(false)

    // fresh: no history at all → new failure, keyChanged unknown.
    const fresh = byId.get('svc#fresh')!
    expect(fresh.verdict).toBe('new-failure')
    expect(fresh.keyChanged).toBeNull()
    expect(fresh.previousRunId).toBeNull()

    // both: trunk latest failed AND a same-key success exists → flaky WINS
    // (nondeterminism evidence beats the inherited-break explanation).
    expect(byId.get('svc#both')!.verdict).toBe('flaky')

    // The foreign workspace triages independently: its lone PR1 row is green,
    // so it has nothing to triage.
    expect(await analytics.triageRun(foreign.ws, 'PR1')).toEqual([])
  })

  it('a re-pushed run yields ONE row per task, never a self-referencing previous', async () => {
    const { org, ws } = await newOrgWs(db, 'triage-repush')
    const now = Date.now()
    // The REAL previous run: key A, success.
    await insertTR(db, ws, org, {
      runId: 'P0',
      project: 'app',
      task: 'build',
      hash: 'A',
      startedAt: now - 2 * HOUR,
    })
    // The triaged run fails on key B — then its summary is RE-PUSHED with a
    // shifted startedAt, duplicating BOTH the header and the task row (the
    // (started_at, run_id, project, task) idempotency key moves with it).
    await insertINV(db, ws, org, { runId: 'R', startedAt: now - HOUR, failedCount: 1 })
    await insertTR(db, ws, org, {
      runId: 'R',
      project: 'app',
      task: 'build',
      hash: 'B',
      status: 'failed',
      exitCode: 1,
      startedAt: now - HOUR,
    })
    await insertINV(db, ws, org, { runId: 'R', startedAt: now - HOUR + 60_000, failedCount: 1 })
    await insertTR(db, ws, org, {
      runId: 'R',
      project: 'app',
      task: 'build',
      hash: 'B',
      status: 'failed',
      exitCode: 1,
      startedAt: now - HOUR + 60_000,
    })
    const rows = await analytics.triageRun(ws, 'R')
    // ONE row (not one per duplicate copy) whose previous run is the REAL
    // prior run — not the triaged run's own later/earlier copy.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.previousRunId).toBe('P0')
    expect(rows[0]!.keyChanged).toBe(true)
    expect(rows[0]!.verdict).toBe('new-failure')
  })

  it('an empty hash is never key evidence: no fabricated flaky, keyChanged null', async () => {
    const { org, ws } = await newOrgWs(db, 'triage-nohash')
    const now = Date.now()
    // A hashless success then a hashless failure — same '' "key". Without the
    // guard this read as flaky (sameKeySuccesses 1) with keyChanged false.
    await insertTR(db, ws, org, {
      runId: 'N0',
      project: 'app',
      task: 'test',
      hash: '',
      startedAt: now - 2 * HOUR,
    })
    await insertTR(db, ws, org, {
      runId: 'N1',
      project: 'app',
      task: 'test',
      hash: '',
      status: 'failed',
      exitCode: 1,
      startedAt: now - HOUR,
    })
    const rows = await analytics.triageRun(ws, 'N1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.verdict).toBe('new-failure')
    expect(rows[0]!.sameKeySuccesses).toBe(0)
    expect(rows[0]!.keyChanged).toBeNull()
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

  it('a duplicate run_id header cannot fake a multi-branch regression', async () => {
    const { org, ws } = await newOrgWs(db, 'regress2')
    const now = Date.now()
    // Prior success, so a surfaced row would read "regressed".
    await insertINV(db, ws, org, { runId: 'ok', startedAt: now - 5 * DAY, branch: 'main' })
    await insertTR(db, ws, org, {
      runId: 'ok',
      project: 'app',
      task: 'e2e',
      status: 'success',
      startedAt: now - 5 * DAY,
    })
    // ONE failing run whose summary was re-pushed with a changed startedAt —
    // two headers (main + feat) for the same run_id. It must count as failing
    // on ONE branch (the earliest header), not two.
    await insertINV(db, ws, org, { runId: 'dup', startedAt: now - 2 * HOUR, branch: 'main' })
    await insertINV(db, ws, org, { runId: 'dup', startedAt: now - HOUR, branch: 'feat' })
    await insertTR(db, ws, org, {
      runId: 'dup',
      project: 'app',
      task: 'e2e',
      status: 'failed',
      exitCode: 1,
      startedAt: now - 2 * HOUR,
    })
    expect(await analytics.getRegressions(ws, { sinceDays: 7, minBranches: 2 })).toHaveLength(0)
  })
})

describe('getProjectBranchFailures', () => {
  it('attributes each task to the branch it FIRST failed on (rank 1)', async () => {
    const { org, ws } = await newOrgWs(db, 'branchfail')
    const now = Date.now()
    // app#e2e first failed on `feat` (earliest), then later on `main`.
    await insertINV(db, ws, org, {
      runId: 'e-feat',
      startedAt: now - 3 * DAY,
      branch: 'feat',
      commit: 'sha-feat',
    })
    await insertTR(db, ws, org, {
      runId: 'e-feat',
      project: 'app',
      task: 'e2e',
      status: 'failed',
      exitCode: 1,
      startedAt: now - 3 * DAY,
    })
    await insertINV(db, ws, org, {
      runId: 'e-main',
      startedAt: now - 1 * DAY,
      branch: 'main',
      commit: 'sha-main',
    })
    await insertTR(db, ws, org, {
      runId: 'e-main',
      project: 'app',
      task: 'e2e',
      status: 'failed',
      exitCode: 1,
      startedAt: now - 1 * DAY,
    })
    // A different task on the SAME project, failing only on main — separate row.
    await insertINV(db, ws, org, {
      runId: 'u-main',
      startedAt: now - 2 * HOUR,
      branch: 'main',
      commit: 'sha-unit',
    })
    await insertTR(db, ws, org, {
      runId: 'u-main',
      project: 'app',
      task: 'unit',
      status: 'failed',
      exitCode: 1,
      startedAt: now - 2 * HOUR,
    })
    // A failure in ANOTHER project — must not leak into app's attribution.
    await insertINV(db, ws, org, { runId: 'w-main', startedAt: now - HOUR, branch: 'main' })
    await insertTR(db, ws, org, {
      runId: 'w-main',
      project: 'web',
      task: 'e2e',
      status: 'failed',
      exitCode: 1,
      startedAt: now - HOUR,
    })

    const rows = await analytics.getProjectBranchFailures(ws, 'app', { sinceDays: 14 })
    // Most-recent first-failure on top: unit (2h ago) before e2e (3d ago).
    expect(rows.map((r) => r.task)).toEqual(['unit', 'e2e'])

    const e2e = rows.find((r) => r.task === 'e2e')!
    expect(e2e.firstBranch).toBe('feat')
    expect(e2e.firstCommit).toBe('sha-feat')
    expect(e2e.branchesFailing).toBe(2)
    expect(e2e.branches.map((b) => b.branch).sort()).toEqual(['feat', 'main'])

    const unit = rows.find((r) => r.task === 'unit')!
    expect(unit.firstBranch).toBe('main')
    expect(unit.branchesFailing).toBe(1)

    // No 'web' rows — project-scoped.
    expect(rows.every((r) => r.task !== 'web')).toBe(true)
  })

  it('a duplicate run_id header (re-pushed summary, new startedAt) attributes once', async () => {
    const { org, ws } = await newOrgWs(db, 'branchfail3')
    const now = Date.now()
    // Two invocation headers for ONE run_id — (started_at, run_id) uniqueness
    // permits this on a re-push. Earliest header (main) is the original.
    await insertINV(db, ws, org, {
      runId: 'dup',
      startedAt: now - 2 * HOUR,
      branch: 'main',
      commit: 'sha-orig',
    })
    await insertINV(db, ws, org, {
      runId: 'dup',
      startedAt: now - HOUR,
      branch: 'feat',
      commit: 'sha-repush',
    })
    await insertTR(db, ws, org, {
      runId: 'dup',
      project: 'app',
      task: 'e2e',
      status: 'failed',
      exitCode: 1,
      startedAt: now - 2 * HOUR,
    })
    const rows = await analytics.getProjectBranchFailures(ws, 'app', { sinceDays: 14 })
    expect(rows).toHaveLength(1)
    // ONE failure on ONE branch — the earliest header wins; never doubled.
    expect(rows[0]!.branchesFailing).toBe(1)
    expect(rows[0]!.firstBranch).toBe('main')
    expect(rows[0]!.firstCommit).toBe('sha-orig')
    expect(rows[0]!.branches).toHaveLength(1)
    expect(rows[0]!.branches[0]!.failures).toBe(1)
  })

  it('ignores successful runs and null-branch invocations', async () => {
    const { org, ws } = await newOrgWs(db, 'branchfail2')
    const now = Date.now()
    // A pass — not a failure.
    await insertINV(db, ws, org, { runId: 'ok', startedAt: now - HOUR, branch: 'main' })
    await insertTR(db, ws, org, {
      runId: 'ok',
      project: 'app',
      task: 'build',
      status: 'success',
      startedAt: now - HOUR,
    })
    // A failure with NO branch on its invocation — not attributable.
    await insertINV(db, ws, org, { runId: 'nb', startedAt: now - HOUR })
    await db.sql`UPDATE invocations SET branch = NULL WHERE run_id = ${'nb'} AND workspace_id = ${ws}`
    await insertTR(db, ws, org, {
      runId: 'nb',
      project: 'app',
      task: 'build',
      status: 'failed',
      exitCode: 1,
      startedAt: now - HOUR,
    })
    expect(await analytics.getProjectBranchFailures(ws, 'app', { sinceDays: 14 })).toHaveLength(0)
  })
})

describe('getProjectTaskTrends', () => {
  it('buckets each top task by day with runs/failures/avg/p95', async () => {
    const { org, ws } = await newOrgWs(db, 'tasktrend')
    const now = Date.now()
    const dayFloor = Math.floor(now / DAY) * DAY
    // app#build: two success runs today (100, 300 → avg 200), one yesterday (500).
    await insertINV(db, ws, org, { runId: 'b1', startedAt: dayFloor + HOUR })
    await insertTR(db, ws, org, {
      runId: 'b1',
      project: 'app',
      task: 'build',
      duration: 100,
      startedAt: dayFloor + HOUR,
    })
    await insertINV(db, ws, org, { runId: 'b2', startedAt: dayFloor + 2 * HOUR })
    await insertTR(db, ws, org, {
      runId: 'b2',
      project: 'app',
      task: 'build',
      duration: 300,
      startedAt: dayFloor + 2 * HOUR,
    })
    await insertINV(db, ws, org, { runId: 'b0', startedAt: dayFloor - DAY + HOUR })
    await insertTR(db, ws, org, {
      runId: 'b0',
      project: 'app',
      task: 'build',
      duration: 500,
      startedAt: dayFloor - DAY + HOUR,
    })
    // app#test: one failure + one success today.
    await insertINV(db, ws, org, { runId: 't1', startedAt: dayFloor + 3 * HOUR })
    await insertTR(db, ws, org, {
      runId: 't1',
      project: 'app',
      task: 'test',
      status: 'failed',
      exitCode: 1,
      duration: 90,
      startedAt: dayFloor + 3 * HOUR,
    })
    await insertINV(db, ws, org, { runId: 't2', startedAt: dayFloor + 4 * HOUR })
    await insertTR(db, ws, org, {
      runId: 't2',
      project: 'app',
      task: 'test',
      status: 'success',
      duration: 80,
      startedAt: dayFloor + 4 * HOUR,
    })
    // A decoy project — must not appear.
    await insertINV(db, ws, org, { runId: 'x1', startedAt: dayFloor + HOUR })
    await insertTR(db, ws, org, {
      runId: 'x1',
      project: 'web',
      task: 'build',
      duration: 999,
      startedAt: dayFloor + HOUR,
    })

    const pts = await analytics.getProjectTaskTrends(ws, 'app', { bucket: 'day' })
    // Only app tasks.
    expect(new Set(pts.map((p) => p.task))).toEqual(new Set(['build', 'test']))
    // build today: 2 runs, avg 200; build yesterday: 1 run, avg 500.
    const buildToday = pts.find((p) => p.task === 'build' && p.t === dayFloor)!
    expect(buildToday.runs).toBe(2)
    expect(buildToday.avgDurationMs).toBe(200)
    const buildYest = pts.find((p) => p.task === 'build' && p.t === dayFloor - DAY)!
    expect(buildYest.runs).toBe(1)
    expect(buildYest.avgDurationMs).toBe(500)
    // test today: 2 runs, 1 failure; avg over the SUCCESS only = 80.
    const testToday = pts.find((p) => p.task === 'test' && p.t === dayFloor)!
    expect(testToday.runs).toBe(2)
    expect(testToday.failures).toBe(1)
    expect(testToday.avgDurationMs).toBe(80)
  })

  it('bounds the task set to the top-N by total duration', async () => {
    const { org, ws } = await newOrgWs(db, 'tasktrend2')
    const now = Date.now() - HOUR
    for (const [i, task] of ['a', 'b', 'c'].entries()) {
      await insertINV(db, ws, org, { runId: `r${i}`, startedAt: now })
      await insertTR(db, ws, org, {
        runId: `r${i}`,
        project: 'app',
        task,
        duration: (i + 1) * 1000,
        startedAt: now,
      })
    }
    // Only the single heaviest task survives the LIMIT.
    const pts = await analytics.getProjectTaskTrends(ws, 'app', { bucket: 'day', limit: 1 })
    expect(new Set(pts.map((p) => p.task))).toEqual(new Set(['c']))
  })

  it('ranks top-N by EXECUTED duration — cache-hit-heavy tasks never crowd out an executed one', async () => {
    const { org, ws } = await newOrgWs(db, 'tasktrend3')
    const now = Date.now() - HOUR
    // hit-happy: huge summed duration, but ALL cache hits (zero executions) —
    // its "series" would be all zeros, so it must not claim a top slot.
    for (let i = 0; i < 10; i++) {
      await insertINV(db, ws, org, { runId: `h${i}`, startedAt: now })
      await insertTR(db, ws, org, {
        runId: `h${i}`,
        project: 'app',
        task: 'hit-happy',
        status: 'cache-hit',
        cacheHit: true,
        duration: 500,
        startedAt: now,
      })
    }
    // exec-real: smaller total, but genuinely executed.
    await insertINV(db, ws, org, { runId: 'e0', startedAt: now })
    await insertTR(db, ws, org, {
      runId: 'e0',
      project: 'app',
      task: 'exec-real',
      duration: 1000,
      startedAt: now,
    })
    const pts = await analytics.getProjectTaskTrends(ws, 'app', { bucket: 'day', limit: 1 })
    expect(new Set(pts.map((p) => p.task))).toEqual(new Set(['exec-real']))
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
    // Two TRUNK runs (main == default) so the default-scope hint sees them.
    await insertINV(db, ws, org, {
      runId: 'w1',
      startedAt: now - HOUR,
      branch: 'main',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'w1',
      project: 'app',
      task: 'build',
      duration: 100,
      startedAt: now - HOUR,
      hash: 'HH',
    })
    await insertINV(db, ws, org, {
      runId: 'w2',
      startedAt: now,
      branch: 'main',
      defaultBranch: 'main',
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

  it('taskDurationHints ignores duplicate invocation headers (re-pushed run)', async () => {
    // invocations' uniqueness is (started_at, run_id): a re-pushed summary with
    // a changed startedAt yields TWO headers for one run. A plain join would
    // DUPLICATE that run's task_run and skew the average toward it.
    const { org, ws } = await newOrgWs(db, 'dupe-hint')
    const now = Date.now()
    // r1: one execution (100ms), a single header.
    await insertINV(db, ws, org, {
      runId: 'r1',
      startedAt: now - 2 * HOUR,
      branch: 'main',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'r1',
      project: 'app',
      task: 'build',
      duration: 100,
      startedAt: now - 2 * HOUR,
    })
    // r2: one execution (200ms), but re-pushed → TWO headers (different startedAt).
    for (const started of [now - HOUR, now]) {
      await insertINV(db, ws, org, {
        runId: 'r2',
        startedAt: started,
        branch: 'main',
        defaultBranch: 'main',
      })
    }
    await insertTR(db, ws, org, {
      runId: 'r2',
      project: 'app',
      task: 'build',
      duration: 200,
      startedAt: now - HOUR,
    })
    // Sharper (discriminating): a trunk run re-pushed as 'feature' must not
    // pollute feature's OWN baseline. r3 runs on trunk (400ms) then is
    // re-pushed with a 'feature' header; r4 is a genuine feature run (1000ms).
    // (All inserts precede every hint call — taskDurationHints memoizes per
    // scope for 30s, so re-reading a scope after a new insert would go stale.)
    await insertINV(db, ws, org, {
      runId: 'r3',
      startedAt: now - 30 * 60 * 1000,
      branch: 'main',
      defaultBranch: 'main',
    })
    await insertINV(db, ws, org, {
      runId: 'r3',
      startedAt: now + 60 * 1000, // later re-push, different branch
      branch: 'feature',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'r3',
      project: 'app',
      task: 'ship',
      duration: 400,
      startedAt: now - 30 * 60 * 1000,
    })
    await insertINV(db, ws, org, {
      runId: 'r4',
      startedAt: now + 2 * 60 * 1000,
      branch: 'feature',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'r4',
      project: 'app',
      task: 'ship',
      duration: 1000,
      startedAt: now + 2 * 60 * 1000,
    })

    const hints = await analytics.taskDurationHints(ws)
    // TRUE mean of {100, 200} = 150. A duplicating join would count r2 twice →
    // (100+200+200)/3 = 166.67.
    expect(hints.get('app#build')).toBe(150)
    // Earliest header (trunk) owns r3, so feature's OWN timing is r4 alone
    // (1000). A duplicating join would leak r3-as-feature in → (1000+400)/2=700.
    const branchHints = await analytics.taskDurationHints(ws, {
      branch: 'feature',
      defaultBranch: 'main',
    })
    expect(branchHints.get('app#ship')).toBe(1000)
    // Trunk owns r3 cleanly (400); r4 (feature) never leaks down.
    const trunkHints = await analytics.taskDurationHints(ws, {
      branch: 'main',
      defaultBranch: 'main',
    })
    expect(trunkHints.get('app#ship')).toBe(400)
  })

  // Scoped-hint fixture — mirrors the cache trust model. Tasks:
  //   build: trunk (100,200 → 150) + a 'exp' branch experiment (2000)
  //   lint:  trunk only (300)
  //   probe: 'exp2' branch only (700) — never trunk, never 'exp'
  async function seedScopedHints(tag: string): Promise<{ org: string; ws: string }> {
    const { org, ws } = await newOrgWs(db, `scoped-hint-${tag}`)
    const now = Date.now()
    const run = async (
      id: string,
      branch: string,
      defaultBranch: string | null,
      project: string,
      task: string,
      duration: number,
      ago: number,
    ): Promise<void> => {
      await insertINV(db, ws, org, { runId: id, startedAt: now - ago, branch, defaultBranch })
      await insertTR(db, ws, org, { runId: id, project, task, duration, startedAt: now - ago })
    }
    await run('s1', 'main', 'main', 'app', 'build', 100, 5 * HOUR)
    await run('s2', 'main', 'main', 'app', 'build', 200, 4 * HOUR)
    await run('s3', 'exp', 'main', 'app', 'build', 2000, 3 * HOUR) // branch experiment
    await run('s4', 'main', 'main', 'app', 'lint', 300, 2 * HOUR) // trunk only
    await run('s5', 'exp2', 'main', 'app', 'probe', 700, HOUR) // other branch only
    return { org, ws }
  }

  it('a TRUNK submission reads only trunk timings — a branch experiment never leaks up', async () => {
    const { ws } = await seedScopedHints('trunk')
    // Default scope == trunk.
    for (const hints of [
      await analytics.taskDurationHints(ws),
      await analytics.taskDurationHints(ws, { branch: 'main', defaultBranch: 'main' }),
    ]) {
      expect(hints.get('app#build')).toBe(150) // 100,200 — the 2000 exp run excluded
      expect(hints.get('app#lint')).toBe(300) // trunk
      expect(hints.has('app#probe')).toBe(false) // ran only on 'exp2' → no trunk hint
    }
  })

  it('a BRANCH submission reads its OWN timings first, then trunk, never another branch', async () => {
    const { ws } = await seedScopedHints('branch')
    const hints = await analytics.taskDurationHints(ws, { branch: 'exp', defaultBranch: 'main' })
    expect(hints.get('app#build')).toBe(2000) // its OWN exp run wins over trunk (150)
    expect(hints.get('app#lint')).toBe(300) // no exp run → falls through to trunk
    expect(hints.has('app#probe')).toBe(false) // 'exp2' is a DIFFERENT branch — never visible
  })

  it('an undetectable scope (null default) is treated as trunk (leak-free default)', async () => {
    const { ws } = await seedScopedHints('nulldflt')
    const hints = await analytics.taskDurationHints(ws, { branch: 'whatever', defaultBranch: null })
    expect(hints.get('app#build')).toBe(150) // trunk baseline, not the 2000 branch run
    expect(hints.has('app#probe')).toBe(false)
  })

  it('a branch literally named after the trunk sentinel cannot poison the trunk memo', async () => {
    // Regression: the memo key must encode trunk-ness in a segment a branch
    // value can never forge, else a branch named `#trunk` shares the trunk
    // entry and — within the 30s TTL — leaks its inflated timing into main.
    const { org, ws } = await newOrgWs(db, 'memo-collision')
    const now = Date.now()
    await insertINV(db, ws, org, {
      runId: 'm1',
      startedAt: now - 2 * HOUR,
      branch: 'main',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'm1',
      project: 'app',
      task: 'build',
      duration: 100,
      startedAt: now - 2 * HOUR,
    })
    await insertINV(db, ws, org, {
      runId: 'm2',
      startedAt: now - HOUR,
      branch: '#trunk',
      defaultBranch: 'main',
    })
    await insertTR(db, ws, org, {
      runId: 'm2',
      project: 'app',
      task: 'build',
      duration: 5000,
      startedAt: now - HOUR,
    })
    // Populate the branch scope FIRST (the order that poisons a colliding memo).
    const branchHints = await analytics.taskDurationHints(ws, {
      branch: '#trunk',
      defaultBranch: 'main',
    })
    expect(branchHints.get('app#build')).toBe(5000) // its OWN slow run
    const trunkHints = await analytics.taskDurationHints(ws, {
      branch: 'main',
      defaultBranch: 'main',
    })
    expect(trunkHints.get('app#build')).toBe(100) // trunk baseline — NOT the 5000 branch leak
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

  it('names the failing projects per run (the pinned-projects lens feed)', async () => {
    const { org, ws } = await newOrgWs(db, 'notif-projects')
    const decoy = await newOrgWs(db, 'notif-projects-decoy')
    const now = Date.now()
    await insertINV(db, ws, org, { runId: 'P1', startedAt: now, failedCount: 2, taskCount: 4 })
    // Two projects fail (one twice — deduped), one succeeds.
    await insertTR(db, ws, org, {
      runId: 'P1',
      project: 'checkout',
      task: 'test',
      status: 'failed',
      exitCode: 1,
      startedAt: now,
    })
    await insertTR(db, ws, org, {
      runId: 'P1',
      project: 'checkout',
      task: 'lint',
      status: 'failed',
      exitCode: 1,
      startedAt: now + 1,
    })
    await insertTR(db, ws, org, {
      runId: 'P1',
      project: 'orders',
      task: 'test',
      status: 'failed',
      exitCode: 1,
      startedAt: now + 2,
    })
    await insertTR(db, ws, org, {
      runId: 'P1',
      project: 'sdk',
      task: 'build',
      startedAt: now + 3,
    })
    // Same runId failing in a FOREIGN workspace — must not pollute the list.
    await insertTR(db, decoy.ws, decoy.org, {
      runId: 'P1',
      project: 'foreign',
      task: 'test',
      status: 'failed',
      exitCode: 1,
      startedAt: now + 4,
    })
    const notes = await analytics.getNotifications(ws)
    expect(notes).toHaveLength(1)
    expect([...notes[0]!.failingProjects].sort()).toEqual(['checkout', 'orders'])
  })

  it('a re-pushed broken run surfaces ONCE, not once per duplicate header', async () => {
    const { org, ws } = await newOrgWs(db, 'notif-repush')
    const now = Date.now()
    await insertINV(db, ws, org, { runId: 'NR', startedAt: now - HOUR, failedCount: 1 })
    await insertINV(db, ws, org, { runId: 'NR', startedAt: now - HOUR + 60_000, failedCount: 1 })
    await insertTR(db, ws, org, {
      runId: 'NR',
      project: 'web',
      task: 'test',
      status: 'failed',
      exitCode: 1,
      startedAt: now - HOUR,
    })
    const notes = await analytics.getNotifications(ws)
    expect(notes.filter((n) => n.runId === 'NR')).toHaveLength(1)
    expect(notes[0]!.failingProjects).toEqual(['web'])
  })
})

describe('getFlakeTrend', () => {
  const DAY = 86_400_000

  it('buckets episodes per day: mixed-key failures + retried successes; breaks never count', async () => {
    const { org, ws } = await newOrgWs(db, 'flaketrend')
    // Bucket-aligned base 10 days ago so expected bucket starts are exact.
    const d0 = Math.floor((Date.now() - 10 * DAY) / DAY) * DAY
    const d1 = d0 + DAY
    const d5 = d0 + 5 * DAY
    const tr = (t: Omit<TR, 'project' | 'task'>) =>
      insertTR(db, ws, org, { project: 'app', task: 'e2e', ...t })
    // Day 0: key K failed then succeeded (mixed), key C failed then CACHE-HIT
    // (a hit is a pass too — the mixedOutcomeKeyCounts rule).
    await tr({ runId: 'R1', startedAt: d0 + 1000, hash: 'K', status: 'failed', exitCode: 1 })
    await tr({ runId: 'R2', startedAt: d0 + 5000, hash: 'K' })
    await tr({ runId: 'R3', startedAt: d0 + 2000, hash: 'C', status: 'failed', exitCode: 1 })
    await tr({ runId: 'R4', startedAt: d0 + 6000, hash: 'C', status: 'cache-hit', cacheHit: true })
    // Day 1: a success that needed a retry (episode) + a pure break — key B
    // ONLY ever fails, and its failed run's attempts>1 must NOT count as
    // "retried" (a deterministic failure retried N times is not flake evidence).
    await tr({ runId: 'R5', startedAt: d1 + 2000, hash: 'K2', attempts: 2 })
    await tr({
      runId: 'R6',
      startedAt: d1 + 3000,
      hash: 'B',
      status: 'failed',
      exitCode: 1,
      attempts: 3,
    })
    // Day 5: a quiet healthy day.
    await tr({ runId: 'R7', startedAt: d5 + 1000, hash: 'K3' })
    // Outside the 90d window: never appears.
    await tr({
      runId: 'OLD',
      startedAt: Date.now() - 100 * DAY,
      hash: 'K',
      status: 'failed',
      exitCode: 1,
    })
    // Decoys: a FOREIGN workspace green for key B (+1ms — the table-wide
    // idempotency index collides on byte-identical rows), and a same-ws
    // DIFFERENT task with its own mixed key — neither may leak in.
    const foreign = await newOrgWs(db, 'flaketrend-decoy')
    await insertTR(db, foreign.ws, foreign.org, {
      runId: 'R6',
      project: 'app',
      task: 'e2e',
      startedAt: d1 + 3001,
      hash: 'B',
    })
    await tr({ runId: 'R8', startedAt: d0 + 7000, hash: 'M' })
    await insertTR(db, ws, org, {
      runId: 'R9',
      project: 'app',
      task: 'other',
      startedAt: d0 + 8000,
      hash: 'M2',
      status: 'failed',
      exitCode: 1,
    })
    await insertTR(db, ws, org, {
      runId: 'R10',
      project: 'app',
      task: 'other',
      startedAt: d0 + 9000,
      hash: 'M2',
    })

    const trend = await analytics.getFlakeTrend(ws, 'app', 'e2e')
    expect(trend.points.map((p) => p.t)).toEqual([d0, d1, d5])
    const [p0, p1, p5] = trend.points
    expect(p0).toEqual({ t: d0, runs: 5, failures: 2, retried: 0, mixedFailures: 2 })
    expect(p1).toEqual({ t: d1, runs: 2, failures: 1, retried: 1, mixedFailures: 0 })
    expect(p5).toEqual({ t: d5, runs: 1, failures: 0, retried: 0, mixedFailures: 0 })
    expect(trend.episodes).toBe(3)
    // Exact ms, not bucket starts.
    expect(trend.firstSeenAt).toBe(d0 + 1000)
    expect(trend.lastSeenAt).toBe(d1 + 2000)

    // A hostile window clamps (MAX_WINDOW_DAYS) instead of scanning everything.
    const clamped = await analytics.getFlakeTrend(ws, 'app', 'e2e', { sinceDays: 1e15 })
    expect(clamped.episodes).toBeGreaterThanOrEqual(3)

    // The foreign workspace sees nothing of ours.
    const foreignTrend = await analytics.getFlakeTrend(foreign.ws, 'app', 'e2e')
    expect(foreignTrend.episodes).toBe(0)
  })

  it('a healthy task yields zero episodes and null first/last seen', async () => {
    const { org, ws } = await newOrgWs(db, 'flaketrend-healthy')
    await insertTR(db, ws, org, {
      runId: 'H1',
      project: 'app',
      task: 'build',
      startedAt: Date.now() - HOUR,
      hash: 'G',
    })
    const trend = await analytics.getFlakeTrend(ws, 'app', 'build')
    expect(trend.points).toHaveLength(1)
    expect(trend.episodes).toBe(0)
    expect(trend.firstSeenAt).toBeNull()
    expect(trend.lastSeenAt).toBeNull()
  })

  it('a re-pushed run counts as ONE data point, not one per duplicate row', async () => {
    const { org, ws } = await newOrgWs(db, 'flaketrend-repush')
    const d = Math.floor((Date.now() - 3 * DAY) / DAY) * DAY
    // One retried success, re-pushed +60s: same run_id, two rows, same day.
    await insertTR(db, ws, org, {
      runId: 'RP',
      project: 'app',
      task: 'e2e',
      hash: 'K',
      attempts: 2,
      startedAt: d + 1000,
    })
    await insertTR(db, ws, org, {
      runId: 'RP',
      project: 'app',
      task: 'e2e',
      hash: 'K',
      attempts: 2,
      startedAt: d + 61_000,
    })
    const trend = await analytics.getFlakeTrend(ws, 'app', 'e2e')
    expect(trend.points).toHaveLength(1)
    expect(trend.points[0]).toEqual({ t: d, runs: 1, failures: 0, retried: 1, mixedFailures: 0 })
    expect(trend.episodes).toBe(1)
  })
})

describe('scale: a workspace larger than one page', () => {
  // The dashboard used to fetch a 500-row page and `.find()` in it, so on a
  // 1000-project workspace half the projects rendered an EMPTY detail page and
  // the ranking card claimed "vs 500 projects". These pin the point lookup,
  // the true count, the true ranks, and server-side search.
  const N = 620

  it('resolves projects past the page limit, and ranks against ALL of them', async () => {
    const { org, ws } = await newOrgWs(db, 'scale')
    const now = Date.now()
    const rows: string[] = []
    for (let i = 0; i < N; i++) {
      const name = `pkg-${String(i).padStart(4, '0')}`
      // Deterministic spread so ranks are well-defined; the TAIL project is
      // deliberately the slowest so it must rank #1 by avg exec.
      const dur = i === N - 1 ? 99_000 : 100 + i
      await insertTR(db, ws, org, {
        runId: `s${i}`,
        project: name,
        task: 'build',
        duration: dur,
        startedAt: now - 3600_000 + i,
      })
      rows.push(name)
    }
    const tail = rows[N - 1]!

    // The page is a page — and the count is the truth.
    const page = await analytics.listProjects(ws, 500)
    expect(page).toHaveLength(500)
    expect(await analytics.countProjects(ws)).toBe(N)

    // Point lookup: the tail project resolves even though it is off the page.
    const exact = await analytics.listProjects(ws, { projects: [tail] })
    expect(exact).toHaveLength(1)
    expect(exact[0]!.project).toBe(tail)

    // Server-side search reaches the tail too (a client filter over the page
    // could never find it).
    const found = await analytics.listProjects(ws, { search: tail })
    expect(found.map((p) => p.project)).toEqual([tail])

    // Ranking: true total, and the tail is genuinely #1 by avg exec.
    const rank = await analytics.rankProject(ws, tail)
    expect(rank.total).toBe(N)
    const me = rank.byAvg.find((r) => r.me)
    expect(me).toBeDefined()
    expect(me!.rank).toBe(1)
    expect(me!.project).toBe(tail)
    // A mid-pack project reports its TRUE rank, not a within-page position.
    const mid = await analytics.rankProject(ws, 'pkg-0300')
    const midMe = mid.byAvg.find((r) => r.me)!
    expect(midMe.rank).toBeGreaterThan(8)
    expect(midMe.rank).toBeLessThanOrEqual(N)
    expect(mid.total).toBe(N)
  }, 60_000)
})
