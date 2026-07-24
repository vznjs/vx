// Differential guard for the #79 N+1 → CTE rewrites (listProjects /
// getCacheSavings / getRegressions). Each new set-based query must be BYTE-
// identical to the prior per-item version. The prior versions are re-run here
// as reference implementations against a rich seeded dataset; the new methods
// must deep-equal them.

import { beforeAll, describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import { Analytics } from '../src/db/analytics.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

const PASS_STATUSES = ['success', 'cache-hit', 'cache-hit-remote']
let db: DbClient
let analytics: Analytics
let ws: string
const HOUR = 3_600_000

async function seedOrgWs(tag: string): Promise<{ org: string; ws: string }> {
  const org = Bun.randomUUIDv7()
  const wsId = Bun.randomUUIDv7()
  await db.sql`INSERT INTO organizations (id, slug, name, created_at) VALUES (${org}, ${'o-' + tag}, ${tag}, ${Date.now()})`
  await db.sql`INSERT INTO workspaces (id, org_id, slug, name, created_at) VALUES (${wsId}, ${org}, ${'w-' + tag}, ${tag}, ${Date.now()})`
  return { org, ws: wsId }
}

interface TR {
  runId: string
  project: string
  task: string
  status?: string
  cacheHit?: boolean
  duration?: number
  startedAt: number
  branch?: string
}
let org = ''
async function insTR(t: TR): Promise<void> {
  await db.sql`INSERT INTO task_runs (
      org_id, workspace_id, run_id, hash, project, task, status, exit_code, duration_ms,
      started_at, ended_at, cache_hit)
    VALUES (${org}, ${ws}, ${t.runId}, ${'h'}, ${t.project}, ${t.task}, ${t.status ?? 'success'},
            ${0}, ${t.duration ?? 100}, ${t.startedAt}, ${t.startedAt + (t.duration ?? 100)},
            ${t.cacheHit ?? false})`
}
async function insINV(runId: string, startedAt: number, branch: string): Promise<void> {
  await db.sql`INSERT INTO invocations (
      run_id, org_id, workspace_id, command, requested_tasks, cache_policy, concurrency, flow,
      started_at, ended_at, total_duration_ms, task_count, failed_count, hit_count,
      hit_local_count, hit_remote_count, exit_ok, branch, ci, ci_provider, os, arch, vx_version, tags)
    VALUES (${runId}, ${org}, ${ws}, ${'vx run'}, ${JSON.stringify(['build'])}::jsonb, ${'lR,lW,rR,rW'},
            ${4}, ${'broad'}, ${startedAt}, ${startedAt + 500}, ${500}, ${1}, ${0}, ${0}, ${0}, ${0},
            ${true}, ${branch}, ${true}, ${'gh'}, ${'linux'}, ${'x64'}, ${'0'}, ${'{}'}::jsonb)`
}

// ── reference (OLD) implementations ──────────────────────────────────────────

async function refProjectSaved(project: string): Promise<number> {
  return (
    await db.sql<{ saved: number }[]>`
      SELECT COALESCE(SUM(avg_dur), 0)::float8 AS saved FROM (
        SELECT (SELECT trunc(avg(duration_ms))::int FROM task_runs s
                WHERE s.workspace_id = ${ws} AND s.project = r.project AND s.task = r.task
                  AND (s.cache_hit IS NULL OR s.cache_hit = false) AND s.status = 'success') AS avg_dur
        FROM task_runs r
        WHERE r.workspace_id = ${ws} AND r.project = ${project}
          AND (r.cache_hit = true OR r.status LIKE 'cache-hit%')
      ) sub WHERE avg_dur IS NOT NULL`
  )[0]!.saved
}

async function refCacheSavings(): Promise<{ h: number; s24: number; sAll: number }> {
  const since = Date.now() - 24 * HOUR
  const r24 = (
    await db.sql<{ saved: number; hits: number }[]>`
      SELECT COALESCE(SUM(avg_dur), 0)::float8 AS saved, count(*)::int AS hits FROM (
        SELECT (SELECT trunc(avg(duration_ms))::int FROM task_runs s
                WHERE s.workspace_id = ${ws} AND s.project = r.project AND s.task = r.task
                  AND (s.cache_hit IS NULL OR s.cache_hit = false) AND s.status = 'success') AS avg_dur
        FROM task_runs r
        WHERE r.workspace_id = ${ws} AND r.started_at >= ${since}
          AND (r.cache_hit = true OR r.status LIKE 'cache-hit%')
      ) sub WHERE avg_dur IS NOT NULL`
  )[0]!
  const rAll = (
    await db.sql<{ saved: number }[]>`
      SELECT COALESCE(SUM(avg_dur), 0)::float8 AS saved FROM (
        SELECT (SELECT trunc(avg(duration_ms))::int FROM task_runs s
                WHERE s.workspace_id = ${ws} AND s.project = r.project AND s.task = r.task
                  AND (s.cache_hit IS NULL OR s.cache_hit = false) AND s.status = 'success') AS avg_dur
        FROM task_runs r
        WHERE r.workspace_id = ${ws}
          AND (r.cache_hit = true OR r.status LIKE 'cache-hit%')
      ) sub WHERE avg_dur IS NOT NULL`
  )[0]!
  return { h: r24.hits, s24: r24.saved, sAll: rAll.saved }
}

beforeAll(async () => {
  const pg = await ephemeralPg()
  db = openDb(await pg.createDatabase())
  analytics = new Analytics(db.sql)
  ;({ org, ws } = await seedOrgWs('cte'))
  const now = Date.now()
  // A: build has an uncached baseline + cache hits (some within 24h, some not);
  //    test has cache hits but NO uncached baseline (must contribute 0).
  await insTR({
    runId: 'a1',
    project: 'A',
    task: 'build',
    duration: 100,
    startedAt: now - 2 * HOUR,
  })
  await insTR({
    runId: 'a2',
    project: 'A',
    task: 'build',
    duration: 200,
    startedAt: now - 3 * HOUR,
  })
  await insTR({
    runId: 'a3',
    project: 'A',
    task: 'build',
    status: 'cache-hit',
    cacheHit: true,
    duration: 5,
    startedAt: now - 1 * HOUR,
  })
  await insTR({
    runId: 'a4',
    project: 'A',
    task: 'build',
    status: 'cache-hit',
    cacheHit: true,
    duration: 5,
    startedAt: now - 40 * HOUR,
  })
  await insTR({
    runId: 'a5',
    project: 'A',
    task: 'test',
    status: 'cache-hit-remote',
    cacheHit: true,
    duration: 5,
    startedAt: now - 1 * HOUR,
  })
  // B: a single uncached success + one cache hit within 24h.
  await insTR({ runId: 'b1', project: 'B', task: 'lint', duration: 300, startedAt: now - 5 * HOUR })
  await insTR({
    runId: 'b2',
    project: 'B',
    task: 'lint',
    status: 'cache-hit',
    cacheHit: true,
    duration: 5,
    startedAt: now - 2 * HOUR,
  })
  // C: only uncached successes, no hits (contributes 0 savings, but is a project).
  await insTR({ runId: 'c1', project: 'C', task: 'build', duration: 50, startedAt: now - 2 * HOUR })

  // Regression fixture: task R#flaky fails on 3 branches (all latest failed),
  // has a prior pass; R#stable fails on 1 branch only (below minBranches);
  // R#neverpassed fails on 2 branches, never passed.
  for (const [i, br] of ['main', 'feat-a', 'feat-b'].entries()) {
    await insINV(`r-fk-${br}`, now - (i + 1) * HOUR, br)
    await insTR({
      runId: `r-fk-${br}`,
      project: 'R',
      task: 'flaky',
      status: 'failed',
      startedAt: now - (i + 1) * HOUR,
      branch: br,
    })
  }
  await insINV('r-fk-pass', now - 10 * HOUR, 'main')
  await insTR({
    runId: 'r-fk-pass',
    project: 'R',
    task: 'flaky',
    status: 'success',
    startedAt: now - 10 * HOUR,
    branch: 'main',
  })
  await insINV('r-st', now - 1 * HOUR, 'main')
  await insTR({
    runId: 'r-st',
    project: 'R',
    task: 'stable',
    status: 'failed',
    startedAt: now - 1 * HOUR,
    branch: 'main',
  })
  for (const [i, br] of ['main', 'feat-a'].entries()) {
    await insINV(`r-np-${br}`, now - (i + 1) * HOUR, br)
    await insTR({
      runId: `r-np-${br}`,
      project: 'R',
      task: 'neverpassed',
      status: 'failed',
      startedAt: now - (i + 1) * HOUR,
      branch: br,
    })
  }
})

describe('#79 CTE rewrites are output-identical to the per-item versions', () => {
  it('getCacheSavings equals the old two-query version', async () => {
    const got = await analytics.getCacheSavings(ws)
    const ref = await refCacheSavings()
    expect(got.hitsLast24h).toBe(ref.h)
    expect(got.estimatedTimeSavedMs).toBe(ref.s24)
    expect(got.estimatedTimeSavedTotalMs).toBe(ref.sAll)
    // Sanity on the hand-computed values: A#build avg uncached = trunc((100+200)/2)=150;
    // 1 hit within 24h → saved24=150, hits24=1; a4 is >24h → savedAll=300; B#lint
    // avg=300, 1 hit in 24h → +300. C/test contribute 0 (no baseline / no hits).
    expect(got.estimatedTimeSavedMs).toBe(150 + 300)
    expect(got.hitsLast24h).toBe(2)
    expect(got.estimatedTimeSavedTotalMs).toBe(150 + 150 + 300)
  })

  it('listProjects estimatedTimeSavedMs equals the old per-project subquery', async () => {
    const projects = await analytics.listProjects(ws)
    expect(projects.length).toBeGreaterThan(0)
    for (const p of projects) {
      expect(p.estimatedTimeSavedMs).toBe(await refProjectSaved(p.project))
    }
    // The rest of the rollup is unchanged; spot-check A exists with hits.
    const a = projects.find((p) => p.project === 'A')!
    expect(a.estimatedTimeSavedMs).toBe(150 + 150) // two A#build hits × 150
  })

  it('getRegressions equals the per-candidate version (win + everPassed batched)', async () => {
    const got = await analytics.getRegressions(ws, { sinceDays: 7, minBranches: 2 })
    const byId = new Map(got.map((r) => [r.id, r]))
    // flaky: 3 branches failing, has a prior pass → regressed true.
    const flaky = byId.get('R#flaky')!
    expect(flaky.branchesFailing).toBe(3)
    expect(flaky.regressed).toBe(true)
    expect(flaky.failures).toBe(3)
    // neverpassed: 2 branches failing, never passed → present but regressed false.
    const np = byId.get('R#neverpassed')!
    expect(np.branchesFailing).toBe(2)
    expect(np.regressed).toBe(false)
    // stable: only 1 branch → below minBranches → absent.
    expect(byId.has('R#stable')).toBe(false)

    // Differential: each returned row's win-stats + everPassed recomputed the
    // OLD way must match.
    const since = Date.now() - 7 * 86_400_000
    for (const r of got) {
      const win = (
        await db.sql<
          {
            runs: number
            failures: number | null
            first_failed: string | null
            last_run: string | null
          }[]
        >`
          SELECT count(*)::int AS runs,
                 SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
                 MIN(CASE WHEN status = 'failed' THEN started_at END) AS first_failed,
                 MAX(started_at) AS last_run
          FROM task_runs WHERE workspace_id = ${ws}
            AND project = ${r.project} AND task = ${r.task} AND started_at >= ${since}`
      )[0]!
      const everPassed =
        (
          await db.sql<{ one: number }[]>`
            SELECT 1 AS one FROM task_runs
            WHERE workspace_id = ${ws} AND project = ${r.project} AND task = ${r.task}
              AND status IN ${db.sql(PASS_STATUSES)} LIMIT 1`
        ).length > 0
      expect(r.failures).toBe(win.failures ?? 0)
      expect(r.runs).toBe(win.runs)
      expect(r.firstFailedAt).toBe(Number(win.first_failed) || 0)
      expect(r.lastRunAt).toBe(Number(win.last_run) || 0)
      expect(r.regressed).toBe(everPassed)
    }
  })
})
