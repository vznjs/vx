// Scale guard for the vx-cloud Postgres analytics reads — the queries the
// dashboard actually calls (listRuns / getHistory / getRun / getFlakiestTasks
// / getRegressions / getPeriodComparison / taskDurationHints / trends /
// savings). The platform targets "orgs of 100000s of devs, millions of
// projects", so a hot read that scans instead of using the workspace-leading
// indexes would make the dashboard LAG on the server side. This seeds ~500
// invocations totalling ~12k task_runs in ONE workspace (plus a decoy org so
// the tenant clamp stays honest) via the real ingest path and pins every read
// under a generous per-query bound + workspace-clamped correctness.
//
// Methodology mirrors tests/scheduler.test.ts's perf guard: min of several
// runs (de-noises), a bound ~10-30x the observed healthy time (guarding that
// the query stays index-bound, not that Postgres is fast on a given box), and
// a functional pin (results are correct + tenant-isolated at scale).

import { beforeAll, describe, expect, it } from 'bun:test'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { openDb, type DbClient } from '../src/db/client.js'
import { Analytics } from '../src/db/analytics.js'
import { ensurePartitions } from '../src/db/partitions.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

const DAY = 86_400_000
const NOW = Date.now()

async function seedOrg(db: DbClient, slug: string): Promise<string> {
  const orgId = Bun.randomUUIDv7()
  await db.sql`INSERT INTO organizations (id, slug, name, created_at)
               VALUES (${orgId}, ${slug}, ${slug}, ${Date.now()})`
  return orgId
}

function task(o: Partial<TaskTelemetry> & Pick<TaskTelemetry, 'project' | 'task'>): TaskTelemetry {
  return {
    taskId: `${o.project}#${o.task}`,
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 100,
    hash: 'h',
    ...o,
  }
}

function summary(o: {
  runId: string
  workspaceId: string
  workspaceName?: string
  startedAt: number
  branch: string
  tasks: TaskTelemetry[]
}): RunSummaryRecord {
  const tasks = o.tasks
  return {
    v: 2,
    run: {
      runId: o.runId,
      vxVersion: '0',
      command: 'vx run',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 8,
      flow: 'broad',
      workspaceId: o.workspaceId,
      workspaceName: o.workspaceName ?? 'acme/app',
      commitSha: `c${o.runId}`,
      branch: o.branch,
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'h',
      os: 'linux',
      arch: 'x64',
      tags: { env: 'ci' },
    },
    startedAt: o.startedAt,
    endedAt: o.startedAt + 500,
    totalDurationMs: 500,
    taskCount: tasks.length,
    failedCount: tasks.filter((t) => t.status === 'failed').length,
    hitCount: tasks.filter((t) => t.cacheSource === 'local' || t.cacheSource === 'remote').length,
    hitLocalCount: tasks.filter((t) => t.cacheSource === 'local').length,
    hitRemoteCount: tasks.filter((t) => t.cacheSource === 'remote').length,
    exitOk: tasks.every((t) => t.status !== 'failed'),
    tasks,
  }
}

const PROJECTS = 25
const TASK_NAMES = ['build', 'test', 'lint', 'typecheck', 'bundle']
const BRANCHES = ['main', 'feat-a', 'feat-b', 'feat-c', 'feat-d']
const INVOCATIONS = 480

let analytics: Analytics
let db: DbClient
let wsAcme: string
let wsEvil: string
let acmeTaskRows = 0

/** min-of-3, de-noises machine load (matches the scheduler perf guard). */
async function bench<T>(fn: () => Promise<T>): Promise<{ best: number; res: T }> {
  let best = Infinity
  let res!: T
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    res = await fn()
    best = Math.min(best, performance.now() - t)
  }
  return { best, res }
}

beforeAll(async () => {
  const pg = await ephemeralPg()
  db = openDb(await pg.createDatabase())
  analytics = new Analytics(db.sql)
  // Create real partitions across the data window (the daily-tick's job) so the
  // rows land in weekly/monthly partitions instead of the DEFAULT catch-all —
  // the realistic served layout.
  for (let d = -35; d <= 3; d += 5) await ensurePartitions(db, { now: NOW + d * DAY })

  const org = await seedOrg(db, 'acme')
  const evil = await seedOrg(db, 'evil')

  // ~480 invocations × 25 tasks across 25 projects × 5 tasks × 5 branches, spread
  // over ~26 days, with a realistic status mix (executed / cache-hit local+remote
  // / failed / retried-then-passed) and recent runs slower (period movers).
  for (let n = 0; n < INVOCATIONS; n++) {
    const base = n % PROJECTS
    const branch = BRANCHES[n % BRANCHES.length]!
    const age = (n * 53) % 26
    const startedAt = NOW - age * DAY - (n % 97) * 60_000
    const tasks: TaskTelemetry[] = []
    for (let pk = 0; pk < 5; pk++) {
      const p = `p${String((base + pk) % PROJECTS).padStart(2, '0')}`
      for (const tk of TASK_NAMES) {
        const roll = (n * 7 + pk * 13) % 100
        let status: TaskTelemetry['status'] = 'success'
        let cacheSource: TaskTelemetry['cacheSource'] = 'miss'
        let attempts: number | undefined
        if (roll < 8) status = 'failed'
        else if (roll < 25) {
          status = 'cache-hit'
          cacheSource = 'local'
        } else if (roll < 35) {
          status = 'cache-hit-remote'
          cacheSource = 'remote'
        } else if (roll < 40) attempts = 2 // retried-then-passed (confirmed flaky)
        const dur = 50 + ((n * 17 + pk * 3) % 400) + (age < 7 ? 100 : 0)
        tasks.push(
          task({
            project: p,
            task: tk,
            status,
            cacheSource,
            durationMs: dur,
            exitCode: status === 'failed' ? 1 : 0,
            ...(attempts !== undefined ? { attempts } : {}),
          }),
        )
      }
    }
    const res = await analytics.ingest({
      orgId: org,
      summary: summary({ runId: `r${n}`, workspaceId: 'main-ws', startedAt, branch, tasks }),
    })
    wsAcme = res.workspaceId
    acmeTaskRows += tasks.length
  }

  // A crafted cross-branch regression: regproj#build ever passed (10d ago) and
  // its LATEST run per branch is now failing on main + feat-a (within 7d).
  const reg = (
    runId: string,
    branch: string,
    startedAt: number,
    failed: boolean,
  ): Promise<unknown> =>
    analytics.ingest({
      orgId: org,
      summary: summary({
        runId,
        workspaceId: 'main-ws',
        startedAt,
        branch,
        tasks: [
          task({
            project: 'regproj',
            task: 'build',
            status: failed ? 'failed' : 'success',
            exitCode: failed ? 1 : 0,
            durationMs: 200,
          }),
        ],
      }),
    })
  await reg('reg-old', 'main', NOW - 10 * DAY, false)
  await reg('reg-m', 'main', NOW - 1 * DAY, true)
  await reg('reg-a', 'feat-a', NOW - 1 * DAY, true)
  acmeTaskRows += 3

  // A single BIG run (~700 tasks) — the known heavy getRun() case.
  const bigTasks: TaskTelemetry[] = []
  for (let i = 0; i < 700; i++) {
    bigTasks.push(
      task({ project: 'bigproj', task: `t${String(i).padStart(3, '0')}`, durationMs: 10 + i }),
    )
  }
  await analytics.ingest({
    orgId: org,
    summary: summary({
      runId: 'big-run',
      workspaceId: 'main-ws',
      startedAt: NOW - 2 * 60_000,
      branch: 'main',
      tasks: bigTasks,
    }),
  })
  acmeTaskRows += 700

  // Decoy org/workspace — its rows must never surface in acme reads.
  for (let n = 0; n < 40; n++) {
    const tasks: TaskTelemetry[] = []
    for (let k = 0; k < 25; k++) {
      tasks.push(task({ project: `evilproj${k % 5}`, task: 'build', durationMs: 999 }))
    }
    const res = await analytics.ingest({
      orgId: evil,
      summary: summary({
        runId: `e${n}`,
        workspaceId: 'evil-ws',
        workspaceName: 'evil/app',
        startedAt: NOW - (n % 20) * DAY,
        branch: 'main',
        tasks,
      }),
    })
    wsEvil = res.workspaceId
  }
}, 300_000)

describe('analytics reads at ~12k task_runs', () => {
  it('seeded the expected scale', async () => {
    const rows = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM task_runs WHERE workspace_id = ${wsAcme}`
    expect(rows[0]!.n).toBe(acmeTaskRows)
    expect(rows[0]!.n).toBeGreaterThan(5000)
    // The decoy org is a DISTINCT workspace.
    expect(wsEvil).not.toBe(wsAcme)
  })

  it('listRuns stays fast + workspace-clamped', async () => {
    // Calibration (this machine): ~9 ms. Bound ~30x.
    const { best, res } = await bench(() => analytics.listRuns(wsAcme))
    expect(res.length).toBe(100) // default limit
    // Tenant clamp: no decoy rows leak into acme's list.
    expect(res.some((r) => r.project.startsWith('evilproj'))).toBe(false)
    expect(best).toBeLessThan(300)
  }, 120_000)

  it('getHistory (per-task rollups) stays fast', async () => {
    // Calibration: ~29 ms. Bound ~17x.
    const { best, res } = await bench(() => analytics.getHistory(wsAcme))
    expect(res.length).toBeGreaterThan(0)
    expect(res.every((r) => !r.project.startsWith('evilproj'))).toBe(true)
    expect(best).toBeLessThan(500)
  }, 120_000)

  it('getRun of a ~700-task run stays fast', async () => {
    // Calibration: ~2 ms. Bound generous.
    const { best, res } = await bench(() => analytics.getRun(wsAcme, 'big-run'))
    expect(res!.tasks.length).toBe(700)
    expect(best).toBeLessThan(300)
  }, 120_000)

  it('getFlakiestTasks (N+1 percentile fetches) stays fast', async () => {
    // Calibration: ~46 ms. Bound ~17x.
    const { best, res } = await bench(() => analytics.getFlakiestTasks(wsAcme))
    expect(res.length).toBeGreaterThan(0)
    expect(res.some((f) => f.flakyConfirmed)).toBe(true)
    expect(best).toBeLessThan(800)
  }, 120_000)

  it('getRegressions (per-failing-task subqueries) stays fast + finds the regression', async () => {
    // Calibration: ~150 ms (the N+1 per-failing-task subquery pattern). Bound
    // higher (~13x) — inherently the heaviest analytic read.
    const { best, res } = await bench(() => analytics.getRegressions(wsAcme))
    const reg = res.find((r) => r.id === 'regproj#build')
    expect(reg).toBeDefined()
    expect(reg!.regressed).toBe(true)
    expect(reg!.branchesFailing).toBeGreaterThanOrEqual(2)
    // A regression explosion (every task marked regressed) would be a bug; keep
    // it bounded on realistic data.
    expect(res.length).toBeLessThan(80)
    expect(best).toBeLessThan(2000)
  }, 120_000)

  it('getPeriodComparison stays fast + returns non-null stats', async () => {
    // Calibration: ~18 ms. Bound ~27x.
    const { best, res } = await bench(() => analytics.getPeriodComparison(wsAcme))
    expect(res.windowDays).toBe(7)
    expect(typeof res.current.stats.failures).toBe('number')
    expect(typeof res.previous.stats.failures).toBe('number')
    expect(Array.isArray(res.movers)).toBe(true)
    expect(best).toBeLessThan(500)
  }, 120_000)

  it('taskDurationHints stays fast', async () => {
    // Calibration: ~9 ms. Bound ~33x.
    const { best, res } = await bench(() => analytics.taskDurationHints(wsAcme))
    expect(res.size).toBeGreaterThan(0)
    expect([...res.keys()].some((k) => k.startsWith('evilproj'))).toBe(false)
    expect(best).toBeLessThan(300)
  }, 120_000)

  it('getRunTrends + getCacheStatsSql stay fast', async () => {
    const trends = await bench(() => analytics.getRunTrends(wsAcme, { bucket: 'day' }))
    expect(trends.res.length).toBeGreaterThan(0)
    expect(trends.best).toBeLessThan(300)
    const stats = await bench(() => analytics.getCacheStatsSql(wsAcme))
    expect(stats.res.runCountLast24h).toBeGreaterThanOrEqual(0)
    expect(stats.best).toBeLessThan(300)
  }, 120_000)

  it('getCacheSavings (correlated per-hit subqueries) stays fast', async () => {
    // Calibration: ~430 ms (a correlated subquery per cache-hit row). The
    // heaviest by wall-clock; bound ~7x.
    const { best, res } = await bench(() => analytics.getCacheSavings(wsAcme))
    expect(res.hitsLast24h).toBeGreaterThanOrEqual(0)
    expect(best).toBeLessThan(3000)
  }, 120_000)

  it('tenant clamp: the decoy workspace sees only its own rows', async () => {
    const evilRuns = await analytics.listRuns(wsEvil)
    expect(evilRuns.length).toBeGreaterThan(0)
    expect(evilRuns.every((r) => r.project.startsWith('evilproj'))).toBe(true)
    // Acme cannot read a decoy run by id, nor a foreign workspace id.
    expect(await analytics.getRun(wsAcme, 'e0')).toBeNull()
    expect(await analytics.getRun(wsEvil, 'big-run')).toBeNull()
  })
})
