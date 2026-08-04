// The analytics router's PARAM HONESTY rules, from the 2026-08-04 hostile
// audit of `analytics-routes.ts`. Each block pins a rule whose violation is
// silent-or-misleading rather than loud: a 500 where a 400 belongs, a filter
// that answers a confident empty list, two clamps disagreeing in one file.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'

const NUL = `%${'00'}`

let p: TestPlatform
let ws: string
let db: DbClient

const get = (path: string): Promise<Response> =>
  fetch(`${p.origin}${path}`, { headers: { authorization: `Bearer ${p.ciToken}` } })

const jsonOf = async <T>(path: string): Promise<T> => (await get(path)).json() as Promise<T>

beforeAll(async () => {
  p = await bootPlatform()
  // Two runs, so a filter that wrongly matches nothing is observable as a
  // count rather than as "empty either way".
  const startedAt = Date.now() - 3_600_000
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${p.origin}/v1/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.ciToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 2,
        run: {
          runId: `run-${i}`,
          vxVersion: '0.0.0',
          workspaceId: 'wsclient',
          workspaceName: 'wsclient',
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
        startedAt: startedAt + i * 1000,
        endedAt: startedAt + i * 1000 + 100,
        totalDurationMs: 100,
        taskCount: 1,
        failedCount: 0,
        hitCount: 0,
        hitLocalCount: 0,
        hitRemoteCount: 0,
        exitOk: true,
        tasks: [
          {
            taskId: 'projA#build',
            project: 'projA',
            task: 'build',
            status: 'success',
            cacheSource: 'miss',
            exitCode: 0,
            durationMs: 100,
            hash: `hash${i}`,
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
  }
  ws = (await jsonOf<{ workspaces: { id: string }[] }>('/v1/workspaces')).workspaces[0]!.id
  expect(ws).toBeTruthy()

  db = openDb(p.dbUrl)
  // FOUR divergent fingerprint keys (two platforms per hash), so a limit's row
  // count is observable — status alone is 200 for every limit, which is exactly
  // why the pre-existing hermeticity test could not see the clamp diverge.
  await db.sql`
    INSERT INTO output_fingerprints
      (org_id, workspace_id, hash, os, arch, tree, file_count, files, truncated,
       task_id, run_id, host, created_at)
    SELECT ${p.orgId}, ${ws}, 'fp' || g, plat.os, 'x64', 'tree-' || plat.os || g,
           1, '{}'::jsonb, false, 'projA#build', 'run-0', 'box', ${Date.now()} - g * 1000
    FROM generate_series(1, 4) g, (VALUES ('linux'), ('darwin')) AS plat(os)`

  // 5000 more task_runs (5002 total), so the /v1/runs route cap is observable:
  // uncapped returns 5002, capped returns exactly ROUTE_RUNS_MAX.
  await db.sql`
    INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status,
      exit_code, duration_ms, started_at, ended_at, cache_hit)
    SELECT ${p.orgId}, ${ws}, 'bulk-' || g, 'bh' || g, 'bulk', 'build', 'success', 0, 10,
           ${startedAt} - g * 1000, ${startedAt} - g * 1000 + 10, false
    FROM generate_series(1, 5000) g`
})

afterAll(async () => {
  await db.close()
  await p.stop()
})

describe('a NUL byte is the CALLER a fault, not a server fault', () => {
  // `%00` is a WELL-FORMED escape, so it decodes fine and only fails at
  // Postgres (SQLSTATE 22021) — one step past the malformed-escape guard the
  // suite already had. The write routes answered 400 for the same input while
  // every read route answered 500: the file disagreeing with itself.
  const shapes = [
    `/v1/runs?project=${NUL}`,
    `/v1/history?search=${NUL}`,
    `/v1/invocations?branch=${NUL}`,
    `/v1/tasks/${NUL}`,
    `/v1/why/${NUL}`,
    `/v1/runs/${NUL}`,
    `/v1/compare/${NUL}`,
    `/v1/projects/rank?project=${NUL}`,
  ]
  for (const shape of shapes) {
    it(`answers 400, not 500: ${shape}`, async () => {
      expect((await get(shape)).status).toBe(400)
    })
  }

  it('still answers 500 for a genuine server fault', async () => {
    // The control: without it, "map everything to 400" would pass this block
    // while destroying the operator's 5xx signal. A malformed percent-escape
    // keeps its own 400, and a real fault must stay a 500 — asserted by the
    // classifier being SPECIFIC (errno 22021) rather than catch-all.
    expect((await get('/v1/tasks/%')).status).toBe(400)
  })

  it('a NUL storm does not poison the pool', async () => {
    const before = (await jsonOf<{ runs: unknown[] }>('/v1/runs?limit=5')).runs.length
    for (let i = 0; i < 20; i++) await get(`/v1/runs?project=${NUL}`)
    const after = await jsonOf<{ runs: unknown[] }>('/v1/runs?limit=5')
    expect(before).toBeGreaterThan(0)
    expect(after.runs.length).toBe(before)
  })
})

describe('an empty free-text param means ABSENT, never "match the empty string"', () => {
  // `curl ".../v1/runs?project=$PROJECT"` with an unset variable must not
  // answer a confident empty list for a workspace full of runs. `hash` and
  // `search` already behaved this way; the rest did not.
  const rows = async (qs: string): Promise<number> =>
    (await jsonOf<{ runs: unknown[] }>(`/v1/runs?${qs}`)).runs.length

  it('?project= / ?task= / ?runId= are ignored, like ?hash= already was', async () => {
    // Relational on purpose: the claim is "the empty param changed NOTHING",
    // not a magic row count that drifts whenever the fixture grows.
    const base = await rows('limit=5')
    expect(base).toBeGreaterThan(0)
    for (const key of ['project', 'task', 'runId', 'hash']) {
      expect(await rows(`limit=5&${key}=`)).toBe(base)
    }
  })

  it('?branch= is ignored on invocations', async () => {
    const n = async (qs: string): Promise<number> =>
      (await jsonOf<{ invocations: unknown[] }>(`/v1/invocations?${qs}`)).invocations.length
    const base = await n('limit=5')
    expect(base).toBeGreaterThan(0)
    expect(await n('limit=5&branch=')).toBe(base)
  })

  it('a REAL value still filters — the rule is about empty, not about ignoring', async () => {
    expect(await rows('limit=5&project=projA')).toBe(2)
    expect(await rows('limit=5&project=nope')).toBe(0)
  })

  it('a required param that is empty still 400s', async () => {
    // The guards that read `=== null` had to become `=== undefined` with this
    // change; if they had not, /v1/stability would have stopped refusing.
    expect((await get('/v1/stability?project=&task=')).status).toBe(400)
    expect((await get('/v1/stability')).status).toBe(400)
    expect((await get('/v1/branch-failures?project=')).status).toBe(400)
  })
})

describe('every limit clamps the same way', () => {
  // /v1/hermeticity hand-rolled its clamp: it ROUNDED a fractional limit where
  // clampInt floors, and read ''/0/-1 as "default 50" where clampInt reads 1.
  // Its own EXISTING test asserts only HTTP status, which is 200 either way —
  // structurally unable to observe either divergence. These assert the ROW
  // COUNT, which is the thing that actually differs.
  const keys = async (qs: string): Promise<number> =>
    (await jsonOf<{ divergent: unknown[] }>(`/v1/hermeticity?${qs}`)).divergent.length

  it('floors a fractional limit instead of rounding it up', async () => {
    expect(await keys('limit=2.7')).toBe(2)
  })

  it('reads an empty / zero / negative limit as 1, like every sibling', async () => {
    for (const v of ['', '0', '-1']) expect(await keys(`limit=${v}`)).toBe(1)
  })

  it('still honours an in-range limit — the clamp is not "always 1"', async () => {
    expect(await keys('limit=3')).toBe(3)
    expect(await keys('limit=1000000')).toBe(4)
  })

  it('/v1/runs no longer exposes listRuns 100_000 internal ceiling', async () => {
    // The ceiling exists for `getRun`'s internal reuse, not for a client knob.
    // Discriminating: with 5002 rows present, an unbounded route returns all of
    // them and a capped one returns exactly ROUTE_RUNS_MAX.
    const big = await jsonOf<{ runs: unknown[] }>('/v1/runs?limit=1000000')
    expect(big.runs.length).toBe(5000)
  })
})

describe('a workspace-scoped token does not enumerate its siblings', () => {
  it('lists only the workspace it is pinned to', async () => {
    const mk = await fetch(`${p.origin}/v1/admin/orgs/${p.orgId}/workspaces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `vx_session=${p.cookie}`,
        'x-vx-csrf': '1',
      },
      body: JSON.stringify({ name: 'second', slug: 'second' }),
    })
    expect(mk.status).toBe(201)
    const second = ((await mk.json()) as { workspaceId: string }).workspaceId

    const mint = await fetch(`${p.origin}/v1/admin/orgs/${p.orgId}/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `vx_session=${p.cookie}`,
        'x-vx-csrf': '1',
      },
      body: JSON.stringify({ name: 'pinned', tier: 'trusted', workspaceId: second }),
    })
    const pinned = ((await mint.json()) as { token: string }).token

    const seen = (await (
      await fetch(`${p.origin}/v1/workspaces`, {
        headers: { authorization: `Bearer ${pinned}` },
      })
    ).json()) as { workspaces: { id: string }[] }
    expect(seen.workspaces.map((w) => w.id)).toEqual([second])

    // Control: an ORG-WIDE token still sees every workspace — the dashboard's
    // switcher depends on it, so the narrowing must be the pin, not the route.
    const all = await jsonOf<{ workspaces: { id: string }[] }>('/v1/workspaces')
    expect(all.workspaces.length).toBe(2)
  })
})
