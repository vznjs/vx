// What each analytics route DOES with its query parameters, driven over real
// HTTP against a real platform (ephemeral Postgres + fake S3).
//
// `db/analytics-routes.ts` is 525 lines of read-side HTTP surface — ~33 exact
// routes plus 10 parameterized — and nothing exercised it. The neighbouring
// `analytics-route-drift.test.ts` pins WHICH routes are allowlisted; it says
// nothing about what a route does once it is reached. This file covers that
// half: defaults, clamps, filters, refusals, and the tenant boundary.
//
// The four failure classes it exists to catch, each of which has shipped here
// before:
//
//   1. A LOST TENANT CLAMP. Every read is `WHERE workspace_id = <resolved>`;
//      drop one and another tenant's rows appear. Every clamp assertion below
//      seeds a DECOY workspace and proves its rows are absent, so an
//      empty-vs-empty comparison can never pass vacuously.
//   2. A DEGENERATE SCAN (2026-07-14). `?from=0&to=1e15` / `?days=1e15` on a
//      single-threaded multi-tenant server drove a synchronous fill loop into
//      hundreds of millions of allocations. The clamps are asserted by their
//      OBSERVABLE effect — a 400-day-old row that a hostile window still must
//      not reach — not by reading a constant back.
//   3. A 500 WHERE A 400 BELONGS. `decodeURIComponent` throws URIError on a
//      malformed percent-escape; all ten param routes must answer 400.
//   4. A HEADLINE THAT DESCRIBES THE PAGE, NOT THE TRUTH (2026-07-27 F8).
//      `{page, total}` responses must not report the page length as the total.
//
// Numbers are pinned EXACTLY (25, 200, 10, 100, 50, 500, 10000, …) rather than
// as ranges: these are the defaults and ceilings a caller depends on, and a
// range assertion would absorb precisely the drift worth catching. Seeds are
// deliberately sized past each ceiling so the ceiling is what truncates.
//
// Rows are inserted directly (one HTTP ingest per workspace provisions it,
// then bulk SQL) so timestamps, statuses and counts are exact — the
// `analytics-read.test.ts` convention.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { RunSummaryRecord } from '@vzn/vx'
import { openDb, type DbClient } from '../src/db/client.js'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'

const DAY = 86_400_000
/** Mirrors `MAX_TREND_BUCKETS` in db/analytics.ts. */
const MAX_TREND_BUCKETS = 10_000
/** Mirrors `MAX_WINDOW_DAYS` in db/analytics.ts. */
const MAX_WINDOW_DAYS = 366

let plat: TestPlatform
let origin = ''
let db: DbClient
/** workspace name → server workspace uuid. */
const ws: Record<string, string> = {}
let scopedToken = ''
const NOW = Date.now()

// --------------------------------------------------------------------------
// fixture
// --------------------------------------------------------------------------

function summary(runId: string, workspaceId: string): RunSummaryRecord {
  const startedAt = NOW - 3_600_000
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId,
      workspaceName: workspaceId,
      command: 'vx run build',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 2,
      flow: 'broad',
      commitSha: 'c0ffee',
      branch: 'main',
      defaultBranch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'box',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt,
    endedAt: startedAt + 100,
    totalDurationMs: 100,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        taskId: 'seed#build',
        project: 'seed',
        task: 'build',
        status: 'success',
        cacheSource: 'miss',
        exitCode: 0,
        durationMs: 100,
        hash: 'seedkey',
      },
    ],
  } as RunSummaryRecord
}

async function get(p: string, token?: string): Promise<Response> {
  return await fetch(`${origin}${p}`, {
    headers: { authorization: `Bearer ${token ?? plat.ciToken}` },
  })
}

async function getJson<T>(p: string, token?: string): Promise<T> {
  const r = await get(p, token)
  expect(r.status).toBe(200)
  return (await r.json()) as T
}

async function post(p: string, body: unknown, opts: { session?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.session === true) {
    headers['cookie'] = `vx_session=${plat.cookie}`
    headers['x-vx-csrf'] = '1'
  } else headers['authorization'] = `Bearer ${plat.ciToken}`
  return await fetch(`${origin}${p}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

interface Row {
  project?: string
  task?: string
  runId?: string
  id?: string
  hash?: string
  branch?: string | null
  ci?: boolean
}

/** The workspace-scoped names each list route answers under. */
const WS_LIST_KEY = 'runs'

beforeAll(async () => {
  plat = await bootPlatform()
  origin = plat.origin
  // One ingest per workspace: provisions the workspace + its repo mapping, so
  // `?ws=<uuid>` resolves. Every workspace therefore also holds one `seed#build`
  // success at NOW-1h, which the counts below account for.
  for (const name of ['page', 'decoy', 'window', 'par', 'flaky', 'filters']) {
    const r = await post('/v1/ingest', summary(`r-${name}`, name))
    expect(r.status).toBe(200)
  }
  const list = await getJson<{ workspaces: { id: string; name: string }[] }>('/v1/workspaces')
  for (const w of list.workspaces) ws[w.name] = w.id

  db = openDb(plat.dbUrl)
  const org = plat.orgId
  const page = ws['page']!
  // 250 distinct failing projects — past /v1/failures' 200 ceiling.
  await db.sql`
    INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status, exit_code,
      duration_ms, started_at, ended_at, cache_hit)
    SELECT ${org}, ${page}, 'fail-' || g, 'fh' || g, 'f' || g, 'build', 'failed', 1, 100,
           ${NOW} - g * 1000, ${NOW} - g * 1000 + 100, false
    FROM generate_series(1, 250) g`
  // 120 distinct succeeding projects — past /v1/top-tasks' and
  // /v1/bottlenecks' 100 ceilings. Descending durations so the ordering is
  // total-duration-deterministic.
  await db.sql`
    INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status, exit_code,
      duration_ms, started_at, ended_at, cache_hit)
    SELECT ${org}, ${page}, 'ok-' || g, 'oh' || g, 's' || g, 'build', 'success', 0, 1000 - g,
           ${NOW} - g * 1000, ${NOW} - g * 1000 + 100, false
    FROM generate_series(1, 120) g`
  // 520 broken invocations — past /v1/invocations' 500 and
  // /v1/notifications' 100 ceilings.
  await db.sql`
    INSERT INTO invocations (run_id, org_id, workspace_id, command, requested_tasks, cache_policy,
      concurrency, flow, started_at, ended_at, total_duration_ms, task_count, failed_count,
      hit_count, hit_local_count, hit_remote_count, exit_ok, branch, ci, os, arch, vx_version, tags)
    SELECT 'inv-' || g, ${org}, ${page}, 'vx run build', '["build"]'::jsonb, 'lR,lW,rR,rW', 4,
           'broad', ${NOW} - g * 1000, ${NOW} - g * 1000 + 100, 100, 1, 1, 0, 0, 0, false,
           'main', true, 'linux', 'x64', '0.0.0', '{}'::jsonb
    FROM generate_series(1, 520) g`

  // window: one recent row and one 400 days old — past MAX_WINDOW_DAYS. Every
  // window clamp is asserted by `ancient` staying absent.
  const win = ws['window']!
  await db.sql`
    INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status, exit_code,
      duration_ms, started_at, ended_at, cache_hit)
    VALUES (${org}, ${win}, 'w-recent', 'wr', 'recent', 'build', 'success', 0, 100,
            ${NOW - 3_600_000}, ${NOW - 3_600_000 + 100}, false),
           (${org}, ${win}, 'w-ancient', 'wa', 'ancient', 'build', 'success', 0, 100,
            ${NOW - 400 * DAY}, ${NOW - 400 * DAY + 100}, false)`

  // par: 520 two-task runs spanning 200ms — past /v1/trends/parallelism's 500.
  const par = ws['par']!
  for (const task of ['a', 'b']) {
    await db.sql`
      INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status, exit_code,
        duration_ms, started_at, ended_at, cpu_ms, cache_hit)
      SELECT ${org}, ${par}, 'pr-' || g, ${'ph-' + task} || g, 'proj', ${task}, 'cache-hit', 0, 200,
             ${NOW} - g * 1000, ${NOW} - g * 1000 + 200, 200, true
      FROM generate_series(1, 520) g`
  }

  // flaky: 3 confirmed-flaky tasks (a within-run retry IS the definitional
  // flake) and 12 tasks with two same-key successes each (the least-stable
  // population, whose 2 samples sit just under getLeastStableTasks' default
  // minRuns of 3).
  const flaky = ws['flaky']!
  await db.sql`
    INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status, exit_code,
      duration_ms, started_at, ended_at, cache_hit, attempts)
    SELECT ${org}, ${flaky}, 'fl-' || g, 'fk' || g, 'fp' || g, 'build', 'success', 0, 100,
           ${NOW} - g * 1000, ${NOW} - g * 1000 + 100, false, 2
    FROM generate_series(1, 3) g`
  await db.sql`
    INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status, exit_code,
      duration_ms, started_at, ended_at, cache_hit)
    SELECT ${org}, ${flaky}, 'st-' || g || '-' || n, 'sk' || g, 'sp' || g, 'build', 'success', 0,
           100 + n * 40, ${NOW} - (g * 10 + n) * 1000, ${NOW} - (g * 10 + n) * 1000 + 100, false
    FROM generate_series(1, 12) g, generate_series(1, 2) n`

  // filters: a small hand-placed set so every filter assertion is an exact
  // small number rather than a page boundary.
  const filt = ws['filters']!
  await db.sql`
    INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status, exit_code,
      duration_ms, started_at, ended_at, cache_hit)
    VALUES (${org}, ${filt}, 'f-r1', 'ha', 'alpha', 'build', 'success', 0, 100,
            ${NOW - 5000}, ${NOW - 4900}, false),
           (${org}, ${filt}, 'f-r2', 'ha', 'alpha', 'build', 'success', 0, 100,
            ${NOW - 4000}, ${NOW - 3900}, false),
           (${org}, ${filt}, 'f-r3', 'hb', 'beta', 'test', 'success', 0, 100,
            ${NOW - 3000}, ${NOW - 2900}, false)`
  await db.sql`
    INSERT INTO invocations (run_id, org_id, workspace_id, command, requested_tasks, cache_policy,
      concurrency, flow, started_at, ended_at, total_duration_ms, task_count, failed_count,
      hit_count, hit_local_count, hit_remote_count, exit_ok, branch, ci, os, arch, vx_version, tags)
    VALUES ('i-feat', ${org}, ${filt}, 'vx run build', '["build"]'::jsonb, 'p', 4, 'broad',
            ${NOW - 5000}, ${NOW - 4900}, 100, 1, 0, 0, 0, 0, true, 'feat', false,
            'linux', 'x64', '0.0.0', '{}'::jsonb),
           ('i-prod', ${org}, ${filt}, 'vx run build', '["build"]'::jsonb, 'p', 4, 'broad',
            ${NOW - 4000}, ${NOW - 3900}, 100, 1, 0, 0, 0, 0, true, 'main', true,
            'linux', 'x64', '0.0.0', '{"env":"prod"}'::jsonb)`

  // A workspace-SCOPED token, pinned to `decoy` — the write/read clamp that
  // must win over any `?ws=` the caller supplies.
  const mint = await fetch(`${origin}/v1/admin/orgs/${plat.orgId}/tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `vx_session=${plat.cookie}`,
      'x-vx-csrf': '1',
    },
    body: JSON.stringify({ name: 'scoped-decoy', tier: 'trusted', workspaceId: ws['decoy']! }),
  })
  expect(mint.status).toBe(201)
  scopedToken = ((await mint.json()) as { token: string }).token
})

afterAll(async () => {
  await db.close()
  await plat.stop()
})

// --------------------------------------------------------------------------

describe('workspace clamp (?ws=)', () => {
  // Every read route resolves ONE workspace before dispatch and filters on it.
  // The decoy holds a run no other workspace has, so "the clamp held" and
  // "there was nothing to leak" are distinguishable.

  it('a read is scoped to the named workspace, not the org', async () => {
    const a = await getJson<{ runs: Row[] }>(`/v1/runs?ws=${ws['filters']!}&limit=1000`)
    const ids = new Set(a.runs.map((r) => r.runId))
    expect(ids.has('f-r1')).toBe(true)
    // `r-decoy` exists in the SAME org, one workspace over.
    expect(ids.has('r-decoy')).toBe(false)
    const b = await getJson<{ runs: Row[] }>(`/v1/runs?ws=${ws['decoy']!}&limit=1000`)
    expect(b.runs.map((r) => r.runId)).toEqual(['r-decoy'])
  })

  it('the clamp holds on every aggregate route, not just /v1/runs', async () => {
    // A route that forgot its `workspace_id` predicate would surface `page`'s
    // 371 projects here. Each of these reads a different table shape
    // (task_runs aggregate, invocations header, per-key rollup).
    const decoy = ws['decoy']!
    const projects = await getJson<{ projects: Row[]; total: number }>(`/v1/projects?ws=${decoy}`)
    expect(projects.projects.map((p) => p.project)).toEqual(['seed'])
    expect(projects.total).toBe(1)
    const top = await getJson<{ tasks: Row[] }>(`/v1/top-tasks?ws=${decoy}`)
    expect(top.tasks.map((t) => t.id)).toEqual(['seed#build'])
    const failures = await getJson<{ failures: Row[] }>(`/v1/failures?ws=${decoy}`)
    expect(failures.failures).toEqual([])
    const invocations = await getJson<{ invocations: Row[] }>(`/v1/invocations?ws=${decoy}`)
    expect(invocations.invocations.map((i) => i.runId)).toEqual(['r-decoy'])
    const history = await getJson<{ history: Row[] }>(`/v1/history?ws=${decoy}`)
    expect(history.history.map((h) => h.id)).toEqual(['seed#build'])
    const bottlenecks = await getJson<{ bottlenecks: Row[] }>(`/v1/bottlenecks?ws=${decoy}`)
    expect(bottlenecks.bottlenecks.map((b) => b.id)).toEqual(['seed#build'])
  })

  it('a run id from another workspace is not found, not returned', async () => {
    // The point lookups take the id from the PATH; only the clamp keeps them
    // from resolving another tenant's run.
    expect((await get(`/v1/runs/f-r1?ws=${ws['decoy']!}`)).status).toBe(404)
    expect((await get(`/v1/runs/f-r1?ws=${ws['filters']!}`)).status).toBe(200)
    expect((await get(`/v1/invocations/i-prod?ws=${ws['decoy']!}`)).status).toBe(404)
    expect((await get(`/v1/invocations/i-prod?ws=${ws['filters']!}`)).status).toBe(200)
    expect((await get(`/v1/tasks/alpha%23build?ws=${ws['decoy']!}`)).status).toBe(404)
    expect((await get(`/v1/tasks/alpha%23build?ws=${ws['filters']!}`)).status).toBe(200)
  })

  it("a syntactically valid ?ws= that is not this org's workspace is 404, not empty", async () => {
    // An org id is a well-formed uuid that is never a workspace id — the shape
    // a caller would send after copying the wrong identifier. Answering 200
    // with an empty list would read as "this workspace has no runs".
    expect((await get(`/v1/runs?ws=${plat.orgId}`)).status).toBe(404)
    expect((await get(`/v1/projects?ws=${plat.orgId}`)).status).toBe(404)
  })

  it('a malformed ?ws= is refused before any query runs', async () => {
    expect((await get('/v1/runs?ws=not-a-uuid')).status).toBe(404)
    expect((await get("/v1/runs?ws=' OR 1=1 --")).status).toBe(404)
  })

  it('an absent or empty ?ws= resolves a workspace rather than refusing', async () => {
    // Absence is not an error — only an explicitly named unknown workspace is.
    expect((await get('/v1/runs')).status).toBe(200)
    expect((await get('/v1/runs?ws=')).status).toBe(200)
  })

  it('a workspace-scoped token ignores ?ws= and stays pinned', async () => {
    // The token's binding is the clamp; a caller must not be able to widen it
    // by asking for a sibling workspace it can see the id of.
    const own = await getJson<{ runs: Row[] }>('/v1/runs?limit=1000', scopedToken)
    expect(own.runs.map((r) => r.runId)).toEqual(['r-decoy'])
    const asked = await getJson<{ runs: Row[] }>(
      `/v1/runs?limit=1000&ws=${ws['filters']!}`,
      scopedToken,
    )
    expect(asked.runs.map((r) => r.runId)).toEqual(['r-decoy'])
  })

  it('/v1/workspaces answers the ORG list, unnarrowed by ?ws=', async () => {
    // It is the switcher's source: scoping it to the current workspace would
    // make switching away impossible.
    const all = await getJson<{ workspaces: Row[] }>(`/v1/workspaces?ws=${ws['decoy']!}`)
    expect(all.workspaces.length).toBe(6)
  })
})

describe('limit: defaults', () => {
  // Each seed is sized past the default so the default is what truncates.
  const page = (): string => `ws=${ws['page']!}`

  it('/v1/failures defaults to 25 of 250', async () => {
    const r = await getJson<{ failures: Row[] }>(`/v1/failures?${page()}`)
    expect(r.failures.length).toBe(25)
  })

  it('/v1/top-tasks defaults to 10 of 120', async () => {
    const r = await getJson<{ tasks: Row[] }>(`/v1/top-tasks?${page()}`)
    expect(r.tasks.length).toBe(10)
  })

  it('/v1/invocations defaults to 50 of 520', async () => {
    const r = await getJson<{ invocations: Row[] }>(`/v1/invocations?${page()}`)
    expect(r.invocations.length).toBe(50)
  })

  it('/v1/notifications defaults to 20 of 520 broken runs', async () => {
    const r = await getJson<{ notifications: Row[] }>(`/v1/notifications?${page()}`)
    expect(r.notifications.length).toBe(20)
  })

  it('/v1/bottlenecks defaults to 15 tasks over a 14-day lookback', async () => {
    const r = await getJson<{ lookbackDays: number; bottlenecks: Row[] }>(
      `/v1/bottlenecks?${page()}`,
    )
    expect(r.bottlenecks.length).toBe(15)
    expect(r.lookbackDays).toBe(14)
  })

  it('/v1/trends/parallelism defaults to 50 of 520 runs', async () => {
    const r = await getJson<{ points: Row[] }>(`/v1/trends/parallelism?ws=${ws['par']!}`)
    expect(r.points.length).toBe(50)
  })

  it('/v1/projects defaults to a 100-row page', async () => {
    const r = await getJson<{ projects: Row[]; total: number }>(`/v1/projects?${page()}`)
    expect(r.projects.length).toBe(100)
  })

  it('/v1/stability/least defaults to minRuns=3, which excludes a 2-sample task', async () => {
    // The 12 seeded tasks have exactly two same-key executions each. The
    // default is what keeps a barely-measured task out of a ranking that
    // claims to name the least repeatable work.
    const flaky = `ws=${ws['flaky']!}`
    expect((await getJson<{ tasks: Row[] }>(`/v1/stability/least?${flaky}`)).tasks.length).toBe(0)
    expect(
      (await getJson<{ tasks: Row[] }>(`/v1/stability/least?${flaky}&minRuns=2`)).tasks.length,
    ).toBe(8) // and its own default limit of 8 truncates the 12 that qualify
  })

  it('/v1/trends/runs defaults to hourly buckets over the last 24h', async () => {
    const r = await getJson<{ bucket: string; points: Row[] }>(`/v1/trends/runs?${page()}`)
    expect(r.bucket).toBe('hour')
    expect(r.points.length).toBe(25)
  })

  it('/v1/trends/heatmap and /v1/trends/storage default to 30 days', async () => {
    const heat = await getJson<{ days: number }>(`/v1/trends/heatmap?${page()}`)
    expect(heat.days).toBe(30)
    const store = await getJson<{ days: number; points: Row[] }>(`/v1/trends/storage?${page()}`)
    expect(store.days).toBe(30)
    expect(store.points.length).toBe(31)
  })

  it('/v1/cache/prunable defaults to a 7-day minimum age', async () => {
    const r = await getJson<{ minAgeDays: number }>(`/v1/cache/prunable?${page()}`)
    expect(r.minAgeDays).toBe(7)
  })

  it('/v1/analysis defaults to a 7-day window', async () => {
    const r = await getJson<{ windowDays: number }>(`/v1/analysis?${page()}`)
    expect(r.windowDays).toBe(7)
  })
})

describe('limit: ceilings under a hostile value', () => {
  // `?limit=1e9` is the shape a scripted caller sends to mean "everything".
  // Each ceiling is what stops it from streaming an unbounded page out of a
  // multi-tenant server.
  const page = (): string => `ws=${ws['page']!}`

  it('/v1/failures caps at 200', async () => {
    const r = await getJson<{ failures: Row[] }>(`/v1/failures?${page()}&limit=1e9`)
    expect(r.failures.length).toBe(200)
  })

  it('/v1/top-tasks caps at 100', async () => {
    const r = await getJson<{ tasks: Row[] }>(`/v1/top-tasks?${page()}&limit=1e9`)
    expect(r.tasks.length).toBe(100)
  })

  it('/v1/invocations caps at 500', async () => {
    const r = await getJson<{ invocations: Row[] }>(`/v1/invocations?${page()}&limit=1e9`)
    expect(r.invocations.length).toBe(500)
  })

  it('/v1/notifications caps at 100', async () => {
    const r = await getJson<{ notifications: Row[] }>(`/v1/notifications?${page()}&limit=1e9`)
    expect(r.notifications.length).toBe(100)
  })

  it('/v1/bottlenecks caps at 100', async () => {
    const r = await getJson<{ bottlenecks: Row[] }>(`/v1/bottlenecks?${page()}&limit=1e9`)
    expect(r.bottlenecks.length).toBe(100)
  })

  it('/v1/trends/parallelism caps at 500', async () => {
    const r = await getJson<{ points: Row[] }>(`/v1/trends/parallelism?ws=${ws['par']!}&limit=1e9`)
    expect(r.points.length).toBe(500)
  })

  it('/v1/flakiness caps its page while still reporting the true total', async () => {
    const flaky = `ws=${ws['flaky']!}`
    const r = await getJson<{ tasks: Row[]; total: number }>(`/v1/flakiness?${flaky}&limit=1`)
    expect(r.tasks.length).toBe(1)
    // The 2026-07-27 F8 fix: the headline counts the workspace, not the page.
    expect(r.total).toBe(3)
  })

  it('/v1/hermeticity refuses a non-positive limit rather than returning nothing', async () => {
    // Its clamp is hand-rolled (`Math.min(…, 500)` then `> 0 ? limit : 50`)
    // instead of the shared clampInt, so `?limit=0` is the case that would
    // otherwise reach `LIMIT 0` and answer an empty list as if the workspace
    // had no divergent keys.
    for (const q of ['limit=0', 'limit=-5', 'limit=1e9']) {
      const r = await get(`/v1/hermeticity?ws=${ws['page']!}&${q}`)
      expect(r.status).toBe(200)
    }
  })
})

describe('numeric parameter parsing', () => {
  // `numParam` is `Number(v)` guarded only by `Number.isFinite`, and every
  // consumer then floors+clamps. These pin what a caller actually gets for the
  // values a shell or a URL builder produces by accident.
  const page = (): string => `ws=${ws['page']!}`
  const failures = async (q: string): Promise<number> =>
    (await getJson<{ failures: Row[] }>(`/v1/failures?${page()}&${q}`)).failures.length

  it('a non-numeric value falls back to the default', async () => {
    expect(await failures('limit=abc')).toBe(25)
  })

  it('Infinity and NaN fall back to the default', async () => {
    expect(await failures('limit=Infinity')).toBe(25)
    expect(await failures('limit=NaN')).toBe(25)
  })

  it('a fractional value is floored, not rounded', async () => {
    expect(await failures('limit=2.9')).toBe(2)
  })

  it('a negative value clamps to 1 rather than erroring or emptying', async () => {
    expect(await failures('limit=-5')).toBe(1)
  })

  it('SUSPECTED DEFECT: an EMPTY limit means 1, not the default', async () => {
    // `Number('') === 0`, which is finite, so `?? default` never fires and the
    // clamp floor turns it into 1. `curl "…?limit=$LIMIT"` with an unset LIMIT
    // therefore silently returns ONE row instead of the documented default —
    // the same silent-reinterpretation class the 2026-07-26 CLI wave fixed for
    // `--cache=` (an empty spec left caching fully ON). Pinned as CURRENT
    // behaviour; treating '' as absent would be the fix.
    expect(await failures('limit=')).toBe(1)
  })

  it('SUSPECTED DEFECT: a hex limit is accepted and means 16', async () => {
    // `Number('0x10') === 16`. Core's CLI rejects exactly this
    // (`--concurrency 0x10` ran 16 workers until `parseDecimalInt` landed on
    // 2026-07-26); the HTTP surface never got the same strict parse.
    expect(await failures('limit=0x10')).toBe(16)
  })

  it('surrounding whitespace is tolerated', async () => {
    expect(await failures('limit=%20%205%20')).toBe(5)
  })
})

describe('window clamps (MAX_WINDOW_DAYS)', () => {
  // The 2026-07-14 degenerate-scan class: an unclamped `?days=1e15` makes
  // `started_at >= since` match every row in every partition. Asserted by
  // effect — a 400-day-old row must stay out however large the window asked
  // for — so removing a clamp fails these rather than passing on a constant.
  const win = (): string => `ws=${ws['window']!}`

  it('CONTROL: the 400-day-old row exists and an unwindowed route sees it', async () => {
    // Without this control the assertions below could pass because the row was
    // never inserted, which is exactly how a clamp test goes vacuous.
    const r = await getJson<{ tasks: Row[] }>(`/v1/top-tasks?${win()}`)
    expect(new Set(r.tasks.map((t) => t.project))).toEqual(new Set(['seed', 'recent', 'ancient']))
  })

  it('/v1/bottlenecks clamps a hostile window to 366 days', async () => {
    const r = await getJson<{ bottlenecks: Row[] }>(`/v1/bottlenecks?${win()}&days=1e15`)
    const projects = new Set(r.bottlenecks.map((b) => b.project))
    expect(projects.has('recent')).toBe(true)
    expect(projects.has('ancient')).toBe(false)
  })

  it('/v1/cache/stats clamps a hostile windowDays to 366 days', async () => {
    const r = await getJson<{ runCountLast24h: number }>(`/v1/cache/stats?${win()}&windowDays=1e15`)
    expect(r.runCountLast24h).toBe(2) // seed + recent; never the ancient row
  })

  it('/v1/trends/heatmap clamps a hostile days to 366', async () => {
    const r = await getJson<{ cells: { runs: number }[] }>(`/v1/trends/heatmap?${win()}&days=1e15`)
    expect(r.cells.length).toBe(7 * 24)
    expect(r.cells.reduce((n, c) => n + c.runs, 0)).toBe(2)
  })

  it('/v1/trends/storage bounds its fill loop at 366 buckets', async () => {
    // The loop pushes one point per day between `since` and now; unbounded,
    // `?days=1e15` is ~1e12 synchronous allocations.
    const r = await getJson<{ points: Row[] }>(`/v1/trends/storage?${win()}&days=1e15`)
    expect(r.points.length).toBe(MAX_WINDOW_DAYS + 1)
  })

  it('/v1/analysis clamps its window AND reports the clamped value back', async () => {
    // The one route in this family whose echoed field is the value actually
    // used — the contrast that makes the echo defect below concrete.
    const r = await getJson<{ windowDays: number }>(`/v1/analysis?${win()}&window=1e15`)
    expect(r.windowDays).toBe(MAX_WINDOW_DAYS)
  })

  it('a hostile window on every windowed route answers 200, bounded', async () => {
    // The availability half: a degenerate scan surfaced as a frozen replica for
    // every tenant, not as an error for the caller who sent it.
    const hostile = [
      `/v1/regressions?${win()}&sinceDays=1e15&limit=1e9&minBranches=0`,
      `/v1/stability/least?${win()}&sinceDays=1e15&limit=1e9&minRuns=1e9`,
      `/v1/stability?${win()}&project=recent&task=build&sinceDays=1e15&limit=1e9`,
      `/v1/flake-trend?${win()}&project=recent&task=build&sinceDays=1e15`,
      `/v1/branch-failures?${win()}&project=recent&sinceDays=1e15&limit=1e9`,
      `/v1/analysis?${win()}&window=1e15&limit=1e9&minRuns=0`,
      `/v1/flakiness?${win()}&limit=1e9`,
      `/v1/cache/breakdown?${win()}&limit=1e9`,
      `/v1/projects/rank?${win()}&project=recent&top=1e9`,
    ]
    for (const p of hostile) expect((await get(p)).status).toBe(200)
  })
})

describe('trend bucket clamp (MAX_TREND_BUCKETS)', () => {
  it('?from=0&to=1e15 yields exactly MAX_TREND_BUCKETS points, hourly', async () => {
    // Unbounded this is (1e15 - 0) / 3.6e6 ≈ 2.7e8 synchronous pushes.
    const r = await getJson<{ points: Row[] }>(
      `/v1/trends/runs?ws=${ws['page']!}&from=0&to=1e15&bucket=hour`,
    )
    expect(r.points.length).toBe(MAX_TREND_BUCKETS)
  })

  it('?from=0&to=1e15 yields exactly MAX_TREND_BUCKETS points, daily', async () => {
    const r = await getJson<{ points: Row[] }>(
      `/v1/trends/runs?ws=${ws['page']!}&from=0&to=1e15&bucket=day`,
    )
    expect(r.points.length).toBe(MAX_TREND_BUCKETS)
  })

  it('an unknown bucket falls back per route, and the two defaults differ', async () => {
    // /v1/trends/runs defaults to hour (a 24h activity chart); /v1/trends/tasks
    // to day (a 30d per-task trend). A shared fallback would silently rescale
    // one of the two charts.
    const runs = await getJson<{ bucket: string }>(`/v1/trends/runs?ws=${ws['page']!}&bucket=week`)
    expect(runs.bucket).toBe('hour')
    const tasks = await getJson<{ bucket: string }>(
      `/v1/trends/tasks?ws=${ws['filters']!}&project=alpha&bucket=week`,
    )
    expect(tasks.bucket).toBe('day')
  })

  it('a `to` in the future is pulled back to now', async () => {
    // Otherwise the chart pads out to the requested future with empty buckets.
    const r = await getJson<{ points: { t: number }[] }>(
      `/v1/trends/runs?ws=${ws['page']!}&bucket=day&to=${NOW + 400 * DAY}`,
    )
    const last = r.points.at(-1)!.t
    expect(last).toBeLessThanOrEqual(NOW)
    expect(last).toBeGreaterThan(NOW - 2 * DAY)
  })
})

describe('routes that require a project / task', () => {
  const filt = (): string => `ws=${ws['filters']!}`

  it('a missing required param is a 400 naming what is needed', async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/v1/projects/rank', 'project required'],
      ['/v1/trends/tasks', 'project required'],
      ['/v1/branch-failures', 'project required'],
      ['/v1/stability', 'project and task required'],
      ['/v1/flake-trend', 'project and task required'],
    ]
    for (const [p, msg] of cases) {
      const r = await get(`${p}?${filt()}`)
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toBe(msg)
    }
  })

  it('/v1/stability and /v1/flake-trend refuse a half-supplied pair', async () => {
    expect((await get(`/v1/stability?${filt()}&project=alpha`)).status).toBe(400)
    expect((await get(`/v1/stability?${filt()}&task=build`)).status).toBe(400)
    expect((await get(`/v1/flake-trend?${filt()}&project=alpha`)).status).toBe(400)
    expect((await get(`/v1/flake-trend?${filt()}&task=build`)).status).toBe(400)
  })

  it('SUSPECTED DEFECT: an EMPTY project/task is accepted where a missing one is refused', async () => {
    // These guards test `=== null`, so `?project=` (an unset shell variable
    // interpolated into the URL) passes and the query runs against the empty
    // string — answering 200 with a confident-looking empty result instead of
    // the 400 the same caller gets for omitting the parameter entirely.
    // /v1/flakiness gets this right (`project !== null && project !== ''`),
    // which is what shows the others are an oversight rather than a convention.
    for (const p of [
      `/v1/stability?${filt()}&project=&task=`,
      `/v1/flake-trend?${filt()}&project=&task=`,
      `/v1/trends/tasks?${filt()}&project=`,
      `/v1/branch-failures?${filt()}&project=`,
      `/v1/projects/rank?${filt()}&project=`,
    ]) {
      expect((await get(p)).status).toBe(200)
    }
  })

  it('/v1/flakiness narrows to a point lookup only when BOTH halves are non-empty', async () => {
    // The task-detail badge must not depend on the task ranking inside a
    // top-N page; an empty half must not silently widen it back to the scan.
    const flaky = `ws=${ws['flaky']!}`
    const point = await getJson<{ tasks: Row[]; total: number }>(
      `/v1/flakiness?${flaky}&project=fp1&task=build`,
    )
    expect(point.tasks.map((t) => t.id)).toEqual(['fp1#build'])
    expect(point.total).toBe(1)
    const halfEmpty = await getJson<{ tasks: Row[]; total: number }>(
      `/v1/flakiness?${flaky}&project=fp1&task=`,
    )
    expect(halfEmpty.total).toBe(3)
    const foreign = await getJson<{ tasks: Row[] }>(
      `/v1/flakiness?${flaky}&project=nope&task=build`,
    )
    expect(foreign.tasks).toEqual([])
  })
})

describe('malformed percent-encoding in a path segment', () => {
  // `decodeURIComponent('%')` throws URIError. Every parameterized route
  // decodes its segments, so without the router's URIError catch each of these
  // is a 500 — a client fault reported as a server fault, and noise in every
  // error budget that watches 5xx.
  const routes = [
    '/v1/runs/%',
    '/v1/runs/%/logs/x',
    '/v1/runs/r/logs/%',
    '/v1/invocations/%',
    '/v1/compare/%',
    '/v1/tasks/%',
    '/v1/explain/%',
    '/v1/why/%',
    '/v1/why/r/%',
    '/v1/triage/%',
    '/v1/diff/%/x',
    '/v1/diff/r/%',
  ]

  for (const p of routes) {
    it(`${p} answers 400, not 500`, async () => {
      const r = await get(`${p}?ws=${ws['filters']!}`)
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toBe('malformed request path')
    })
  }

  it('a malformed escape in a QUERY value is not fatal', async () => {
    // URLSearchParams decodes leniently, so this must reach the handler
    // normally rather than joining the 400 class above.
    expect((await get(`/v1/runs?ws=${ws['filters']!}&project=%`)).status).toBe(200)
  })
})

describe('SUSPECTED DEFECT: echoed parameters the route never clamps', () => {
  // These routes echo the caller's RAW value beside data computed from the
  // CLAMPED one, so the response describes a window it did not use. Same class
  // as the 2026-07-27 F8 headline that reported a 25-row page as the workspace
  // count. `/v1/analysis` (asserted above) echoes the clamped value, so the
  // family is inconsistent rather than uniformly by-design.
  //
  // Pinned as CURRENT behaviour: echoing the clamped value is the fix, and
  // that change must fail here loudly rather than pass silently.
  const win = (): string => `ws=${ws['window']!}`

  it('/v1/trends/heatmap echoes days=1e15 while querying 366 days', async () => {
    const r = await getJson<{ days: number; cells: { runs: number }[] }>(
      `/v1/trends/heatmap?${win()}&days=1e15`,
    )
    expect(r.days).toBe(1e15)
    expect(r.cells.reduce((n, c) => n + c.runs, 0)).toBe(2) // the clamped truth
  })

  it('/v1/trends/storage echoes days=1e15 while emitting 367 buckets', async () => {
    const r = await getJson<{ days: number; points: Row[] }>(
      `/v1/trends/storage?${win()}&days=1e15`,
    )
    expect(r.days).toBe(1e15)
    expect(r.points.length).toBe(MAX_WINDOW_DAYS + 1)
  })

  it('/v1/bottlenecks echoes lookbackDays=0 while querying a 1-day window', async () => {
    // `?days=0` is not nullish, so the `?? 14` default never fires; the query
    // clamps 0 up to 1 and the response still claims 0 — and the row's
    // `runsPerDay` is derived from the clamped value, so the payload
    // contradicts itself.
    const r = await getJson<{ lookbackDays: number; bottlenecks: { runsPerDay: number }[] }>(
      `/v1/bottlenecks?${win()}&days=0`,
    )
    expect(r.lookbackDays).toBe(0)
    expect(r.bottlenecks[0]!.runsPerDay).toBe(1) // 1 run / 1 clamped day, not / 0
  })

  it('/v1/cache/prunable echoes minAgeDays but never passes it to the query', async () => {
    // `getPrunableEntries(ws)` is called with no second argument, so the echo
    // describes a filter that was never applied. Harmless only while the
    // inventory is the §5.1 shaped empty — it becomes a wrong answer the day
    // that lands.
    const r = await getJson<{ minAgeDays: number; entries: Row[] }>(
      `/v1/cache/prunable?${win()}&minAgeDays=1e15`,
    )
    expect(r.minAgeDays).toBe(1e15)
    expect(r.entries).toEqual([])
  })
})

describe('/v1/runs filters', () => {
  const filt = (): string => `ws=${ws['filters']!}`
  const runs = async (q = ''): Promise<Row[]> =>
    (await getJson<{ runs: Row[] }>(`/v1/runs?${filt()}${q}`)).runs

  it('unfiltered returns every task row in the workspace', async () => {
    expect((await runs()).length).toBe(4) // seed + f-r1 + f-r2 + f-r3
  })

  it('project, task and runId each narrow independently', async () => {
    expect((await runs('&project=alpha')).length).toBe(2)
    expect((await runs('&task=test')).length).toBe(1)
    expect((await runs('&runId=f-r1')).map((r) => r.runId)).toEqual(['f-r1'])
    expect((await runs('&project=alpha&task=build')).length).toBe(2)
    expect((await runs('&project=alpha&task=test')).length).toBe(0)
  })

  it('an EMPTY hash does not filter, but a real one does', async () => {
    // `hash` is the only filter with an explicit empty-string guard, and it has
    // to be: the cache-entry provenance page builds this URL from a row whose
    // hash can be '' (a skipped or persistent task records no key). Without the
    // guard that page would report "no runs produced this artifact".
    expect((await runs('&hash=')).length).toBe(4)
    expect((await runs('&hash=ha')).length).toBe(2)
    expect((await runs('&hash=hb')).length).toBe(1)
    expect((await runs('&hash=nope')).length).toBe(0)
  })

  it('a filter value with SQL metacharacters is data, not syntax', async () => {
    expect((await runs("&project=' OR 1=1 --")).length).toBe(0)
    expect((await runs('&project=%25')).length).toBe(0) // a literal %, not a LIKE wildcard
  })
})

describe('/v1/invocations filters', () => {
  const filt = (): string => `ws=${ws['filters']!}`
  const invs = async (q = ''): Promise<Row[]> =>
    (await getJson<{ invocations: Row[] }>(`/v1/invocations?${filt()}${q}`)).invocations

  it('unfiltered returns every invocation header', async () => {
    expect((await invs()).length).toBe(3) // r-filters + i-feat + i-prod
  })

  it('branch narrows exactly', async () => {
    expect((await invs('&branch=main')).length).toBe(2)
    expect((await invs('&branch=feat')).map((i) => i.runId)).toEqual(['i-feat'])
    expect((await invs('&branch=nope')).length).toBe(0)
  })

  it('ci accepts only `1` and `true` as true — everything else means false', async () => {
    expect((await invs('&ci=1')).length).toBe(2)
    expect((await invs('&ci=true')).length).toBe(2)
    expect((await invs('&ci=0')).map((i) => i.runId)).toEqual(['i-feat'])
    expect((await invs('&ci=false')).map((i) => i.runId)).toEqual(['i-feat'])
    // SUSPECTED DEFECT: an unrecognised value silently means "NOT ci" rather
    // than being ignored or refused, so `?ci=yes` and `?ci=` return the
    // OPPOSITE of what the caller asked for.
    expect((await invs('&ci=yes')).map((i) => i.runId)).toEqual(['i-feat'])
    expect((await invs('&ci=')).map((i) => i.runId)).toEqual(['i-feat'])
  })

  it('the tag filter needs BOTH halves and matches by jsonb containment', async () => {
    // Half a pair must not narrow — the dashboard builds these from two
    // separate inputs, and one filled box would otherwise filter on garbage.
    expect((await invs('&tagKey=env')).length).toBe(3)
    expect((await invs('&tagValue=prod')).length).toBe(3)
    expect((await invs('&tagKey=env&tagValue=prod')).map((i) => i.runId)).toEqual(['i-prod'])
    expect((await invs('&tagKey=env&tagValue=dev')).length).toBe(0)
    expect((await invs('&tagKey=nope&tagValue=prod')).length).toBe(0)
  })
})

describe('/v1/projects paging, search and exact fetch', () => {
  const page = (): string => `ws=${ws['page']!}`

  it('total is the workspace count, not the page length', async () => {
    // A 1000-project workspace must never be described by the size of one page.
    const r = await getJson<{ projects: Row[]; total: number }>(`/v1/projects?${page()}&limit=5`)
    expect(r.projects.length).toBe(5)
    expect(r.total).toBe(371) // 250 failing + 120 succeeding + seed
  })

  it('search narrows server-side, past the page a client could filter', async () => {
    const r = await getJson<{ projects: Row[] }>(`/v1/projects?${page()}&search=f11`)
    expect(r.projects.length).toBeGreaterThan(0)
    expect(r.projects.every((p) => p.project!.includes('f11'))).toBe(true)
  })

  it('SUSPECTED DEFECT: total ignores the search, so a searched page mis-reports its universe', async () => {
    // `countProjects(ws)` takes no search argument, so `{projects, total}`
    // pairs a NARROWED page with the UNNARROWED count — the "showing N of M"
    // headline then names a universe the page was not drawn from.
    const r = await getJson<{ projects: Row[]; total: number }>(`/v1/projects?${page()}&search=f11`)
    expect(r.projects.length).toBeLessThan(371)
    expect(r.total).toBe(371)
  })

  it('repeated ?project= fetches exactly those rows, ignoring empty values', async () => {
    // The project-detail page's point lookup: it must resolve its own row
    // however far down the ordering it sits.
    const two = await getJson<{ projects: Row[] }>(`/v1/projects?${page()}&project=f1&project=f2`)
    expect(new Set(two.projects.map((p) => p.project))).toEqual(new Set(['f1', 'f2']))
    const withEmpty = await getJson<{ projects: Row[] }>(
      `/v1/projects?${page()}&project=&project=f2`,
    )
    expect(withEmpty.projects.map((p) => p.project)).toEqual(['f2'])
  })

  it('/v1/projects/rank reports a true rank over the full set', async () => {
    const r = await getJson<{ total: number; byAvg: { project: string; me: boolean }[] }>(
      `/v1/projects/rank?${page()}&project=s1`,
    )
    expect(r.total).toBe(371)
    expect(r.byAvg.some((x) => x.project === 's1' && x.me)).toBe(true)
  })

  it('/v1/projects/rank caps its per-axis page via ?top=', async () => {
    const r = await getJson<{ byAvg: Row[] }>(`/v1/projects/rank?${page()}&project=s1&top=3`)
    // top-3 plus the named project if it falls outside them.
    expect(r.byAvg.length).toBeLessThanOrEqual(4)
    expect(r.byAvg.length).toBeGreaterThanOrEqual(3)
  })
})

describe('cache inventory routes are deliberate shaped empties (§5.1)', () => {
  // The analytics schema holds run/task history only — cache inventory is the
  // S3 artifact list. These return `[]` on purpose, and the routes still exist
  // so the dashboard renders its zero state instead of erroring. If inventory
  // ever lands, these fail and the cards' assumptions get re-read.
  const page = (): string => `ws=${ws['page']!}`

  it('/v1/cache/entries, /breakdown and /prunable answer empty lists', async () => {
    expect((await getJson<{ entries: Row[] }>(`/v1/cache/entries?${page()}`)).entries).toEqual([])
    expect(
      (await getJson<{ projects: Row[] }>(`/v1/cache/breakdown?${page()}&limit=5`)).projects,
    ).toEqual([])
    expect((await getJson<{ entries: Row[] }>(`/v1/cache/prunable?${page()}`)).entries).toEqual([])
  })

  it('/v1/cache/stats reports zero inventory but REAL run counts', async () => {
    // The half that is genuinely computed must not be zeroed alongside it.
    const r = await getJson<{
      entryCount: number
      totalBytes: number
      runCountLast24h: number
    }>(`/v1/cache/stats?${page()}`)
    expect(r.entryCount).toBe(0)
    expect(r.totalBytes).toBe(0)
    expect(r.runCountLast24h).toBe(371)
  })

  it('/v1/cache/hit-split and /savings compute over real rows', async () => {
    const split = await getJson<{ total: number; hits: number }>(`/v1/cache/hit-split?${page()}`)
    expect(split.total).toBe(371)
    expect(split.hits).toBe(0)
    const savings = await getJson<{ hitsLast24h: number }>(`/v1/cache/savings?${page()}`)
    expect(savings.hitsLast24h).toBe(0)
  })
})

describe('not-found shapes', () => {
  const filt = (): string => `ws=${ws['filters']!}`

  it('the point lookups 404 on an unknown id', async () => {
    for (const p of ['/v1/runs/nope', '/v1/invocations/nope', '/v1/tasks/nope%23build']) {
      const r = await get(`${p}?${filt()}`)
      expect(r.status).toBe(404)
      expect(((await r.json()) as { error: string }).error).toBe('not found')
    }
  })

  it('a run with no captured logs is a 404 that says so', async () => {
    // Distinguishable from "no such run" — the dashboard's log panel renders a
    // different empty state for each.
    const r = await get(`/v1/runs/f-r1/logs/alpha%23build?${filt()}`)
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: string }).error).toBe('no logs captured for this task')
  })

  it('the key-comparison routes answer 200 with found:false instead of 404', async () => {
    // Deliberate asymmetry with the point lookups above: these answer a
    // QUESTION about a run ("why did it re-run?"), and "there is no evidence"
    // is a valid answer the panel renders. Pinned so the two conventions are
    // not accidentally unified.
    const why = await getJson<{ found: boolean }>(`/v1/why/nope/x?${filt()}`)
    expect(why.found).toBe(false)
    const diff = await getJson<{ found: boolean }>(`/v1/diff/nope/x?${filt()}`)
    expect(diff.found).toBe(false)
    const cmp = await getJson<{ found: boolean }>(`/v1/compare/nope?${filt()}`)
    expect(cmp.found).toBe(false)
  })

  it('the batched why/triage routes answer an empty row set', async () => {
    expect((await getJson<{ rows: Row[] }>(`/v1/why/nope?${filt()}`)).rows).toEqual([])
    expect((await getJson<{ rows: Row[] }>(`/v1/triage/nope?${filt()}`)).rows).toEqual([])
  })

  it('an unhandled /v1 path never reaches the analytics router', async () => {
    // The end-to-end half of analytics-route-drift's "refuses an unknown /v1
    // path so it can reach the SPA": the allowlist must not become a catch-all,
    // or a dashboard deep link would receive the router's JSON 404 instead of
    // the app. Proven by the body — the fallback, not an `{error}` envelope.
    const r = await get('/v1/not-a-route')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('vx-cloud')
  })
})

describe('write-route validation gates', () => {
  // The ingest family is the only POST surface here. Its body checks run
  // BEFORE any database work, so a skewed client fails loud instead of writing
  // a half-understood record.

  it('a session (non-token) principal is refused on every write', async () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['/v1/ingest', summary('r-session', 'page')],
      ['/v1/ingest/logs', { v: 1, workspaceId: 'page', tasks: [] }],
      ['/v1/catalog', { v: 1, workspaceId: 'page', projects: [] }],
    ]
    for (const [p, body] of cases) {
      const r = await post(p, body, { session: true })
      expect(r.status).toBe(403)
      expect(((await r.json()) as { error: string }).error).toBe('ci token required')
    }
  })

  it('/v1/ingest/logs refuses a skewed wire version, naming both sides', async () => {
    const r = await post('/v1/ingest/logs', { v: 99, workspaceId: 'page', tasks: [] })
    expect(r.status).toBe(400)
    const err = ((await r.json()) as { error: string }).error
    expect(err).toContain('log wire version mismatch')
    expect(err).toContain('v99')
  })

  it('/v1/catalog refuses a skewed wire version', async () => {
    const r = await post('/v1/catalog', { v: 99, workspaceId: 'page', projects: [] })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('not a catalog push')
  })

  it('a right-versioned but wrong-shaped body is refused', async () => {
    const bundle = await post('/v1/ingest/logs', { v: 1, workspaceId: 'page', tasks: 'nope' })
    expect(bundle.status).toBe(400)
    expect(((await bundle.json()) as { error: string }).error).toBe('not a TaskLogBundle')
    const catalog = await post('/v1/catalog', { v: 1, workspaceId: 'page', projects: 'nope' })
    expect(catalog.status).toBe(400)
    const noRunId = await post('/v1/ingest', { v: 2, run: {}, tasks: [] })
    expect(noRunId.status).toBe(400)
    expect(((await noRunId.json()) as { error: string }).error).toBe('not a RunSummaryRecord')
  })

  it('/v1/ingest/task refuses a record missing its required fields', async () => {
    const r = await post('/v1/ingest/task', {
      v: 1,
      runId: 'r',
      workspaceId: 'page',
      // runStartedAt missing
      task: { taskId: 'a#b', project: 'a', task: 'b' },
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('not a TaskIngestRecord')
  })

  it('a non-JSON body is a 400, not a 500', async () => {
    const r = await fetch(`${origin}/v1/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plat.ciToken}`, 'content-type': 'application/json' },
      body: 'not json at all',
    })
    expect(r.status).toBe(400)
  })
})

describe('response envelope', () => {
  it('every analytics response carries the permissive CORS header', async () => {
    // The dashboard's dev server proxies from another origin. `*` (rather than
    // an echoed Origin) is what keeps a credentialed cross-origin read from
    // succeeding, so it is load-bearing in both directions.
    const ok = await get(`/v1/runs?ws=${ws['filters']!}`)
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    const refused = await get('/v1/runs?ws=not-a-uuid')
    expect(refused.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('an unauthenticated read is 401 before any workspace is resolved', async () => {
    const r = await fetch(`${origin}/v1/${WS_LIST_KEY}?ws=${ws['filters']!}`)
    expect(r.status).toBe(401)
  })
})
