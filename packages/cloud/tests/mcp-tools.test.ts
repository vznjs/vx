// The MCP control plane — `POST /mcp`, driven over real HTTP against a real
// platform (ephemeral Postgres + fake S3).
//
// `src/cli/mcp.ts` is 329 lines with no dedicated test file: three incidental
// assertions in server.test.ts cover the handshake and one error code. This
// covers the rest, and it matters more here than on the sibling `/v1/*` routes
// for one reason:
//
//   AN AI AGENT CANNOT TELL A WRONG ANSWER FROM A RIGHT ONE.
//
// A human reading the dashboard notices when a number looks absurd. A model
// consuming these tools has no prior — it treats the payload as ground truth
// and acts on it. So the failure classes worth guarding are the SILENT ones:
//
//   1. A LOST TENANT CLAMP. Every tool resolves ONE workspace through
//      `resolveWorkspace` and every query is `WHERE workspace_id = <that>`.
//      There is direct precedent for getting this wrong in an MCP surface: the
//      2026-07-26 core audit found `vx mcp` ADVERTISING a `scope: {project}`
//      it silently ignored, then ECHOING IT BACK so the caller could not tell.
//      Every clamp assertion below therefore seeds a DECOY workspace and proves
//      its rows are absent, and checks the ECHOED `workspace` field as well as
//      the data — an echo that agrees with an ignored argument is the exact
//      defect that shipped before.
//   2. A LOSSY COERCION. `bucket` falls back to 'hour' for anything that is not
//      the exact string 'day'; `limit` is ignored unless it is a `number`;
//      `run_trends` takes the LAST n points, not the first. None of these are
//      reported to the caller, so each is pinned by its OBSERVABLE effect (the
//      bucket SPACING, which point ids come back) rather than by the echo.
//   3. AN ADVERTISEMENT THAT DOES NOT MATCH THE IMPLEMENTATION. `MCP_TOOLS` and
//      the `callTool` switch are two independent lists describing one set, and
//      `inputSchema.required` is a third describing what `requireString`
//      enforces. Drift is invisible to a model, which reads only the
//      advertisement. Guarded in both directions, the
//      `analytics-route-drift.test.ts` technique.
//   4. A TRANSPORT FAULT REPORTED AS A SERVER FAULT. A malformed body must
//      produce a well-formed JSON-RPC error, never a 500 and never a hang.
//
// Rows are inserted directly (one HTTP ingest per workspace provisions it, then
// bulk SQL) so counts and timestamps are exact — the analytics-read.test.ts
// convention.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { RunSummaryRecord } from '@vzn/vx'
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from '../src/cli/mcp.js'
import { openDb, type DbClient } from '../src/db/client.js'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** `resolveWorkspace`'s answer for an org that has no workspace at all. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'
/** A well-formed uuid that is no workspace of any org here. */
const STRANGER_UUID = '11111111-2222-3333-4444-555555555555'

const NOW = Date.now()

let plat: TestPlatform
let origin = ''
let db: DbClient

/** client workspace name → server workspace uuid (org A). */
const ws: Record<string, string> = {}
/** Org A, org-wide trusted — the default MCP principal for most tests. */
let orgToken = ''
/** Org A, pinned to the `alpha` workspace — the clamp under test. */
let alphaToken = ''
/** A second org that must never be reachable from org A's credentials. */
let orgBId = ''
let orgBToken = ''
let charlieWs = ''
/** A third org with NO workspaces — the nil-uuid branch. */
let emptyToken = ''

// --------------------------------------------------------------------------
// fixture
// --------------------------------------------------------------------------

function summary(runId: string, workspaceId: string, startedAt: number): RunSummaryRecord {
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
        hash: `seed-${workspaceId}`,
      },
    ],
  } as RunSummaryRecord
}

async function ingest(body: RunSummaryRecord, token: string): Promise<void> {
  const r = await fetch(`${origin}/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  expect(r.status).toBe(200)
}

async function mintToken(orgId: string, name: string, workspaceId?: string): Promise<string> {
  const r = await fetch(`${origin}/v1/admin/orgs/${orgId}/tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `vx_session=${plat.cookie}`,
      'x-vx-csrf': '1',
    },
    body: JSON.stringify({
      name,
      tier: 'trusted',
      ...(workspaceId !== undefined ? { workspaceId } : {}),
    }),
  })
  expect(r.status).toBe(201)
  return ((await r.json()) as { token: string }).token
}

async function createOrg(slug: string): Promise<string> {
  const r = await fetch(`${origin}/v1/admin/orgs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `vx_session=${plat.cookie}`,
      'x-vx-csrf': '1',
    },
    body: JSON.stringify({ slug, name: slug }),
  })
  expect(r.status).toBe(201)
  return ((await r.json()) as { orgId: string }).orgId
}

// --------------------------------------------------------------------------
// JSON-RPC helpers
// --------------------------------------------------------------------------

/** How a request authenticates: a machine token, or the admin session in an org. */
type Auth = { bearer: string } | { sessionOrg: string }

interface RpcResponse {
  jsonrpc?: unknown
  id?: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface ToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}

function rpcInit(body: string, auth: Auth): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let url = `${origin}/mcp`
  if ('bearer' in auth) headers['authorization'] = `Bearer ${auth.bearer}`
  else {
    headers['cookie'] = `vx_session=${plat.cookie}`
    // A session that belongs to several orgs must name one; the gate refuses
    // otherwise (400), which would look like an MCP fault if left implicit.
    url += `?org=${auth.sessionOrg}`
  }
  return { url, init: { method: 'POST', headers, body } }
}

/** POST a JSON-RPC body; the raw Response (status codes, 202s, 413s). */
async function rpcRaw(body: unknown, auth: Auth = { bearer: orgToken }): Promise<Response> {
  const { url, init } = rpcInit(JSON.stringify(body), auth)
  return await fetch(url, init)
}

/** POST a JSON-RPC body and parse the (single-message) envelope. */
async function rpc(body: unknown, auth: Auth = { bearer: orgToken }): Promise<RpcResponse> {
  const r = await rpcRaw(body, auth)
  expect(r.status).toBe(200)
  return (await r.json()) as RpcResponse
}

/** `tools/call` → the MCP result envelope (which may carry `isError`). */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  auth: Auth = { bearer: orgToken },
): Promise<ToolResult> {
  const res = await rpc(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
    auth,
  )
  expect(res.error).toBeUndefined()
  return res.result as unknown as ToolResult
}

/** A tool call expected to SUCCEED — the decoded payload the model would read. */
async function tool<T>(
  name: string,
  args: Record<string, unknown> = {},
  auth: Auth = { bearer: orgToken },
): Promise<T> {
  const res = await callTool(name, args, auth)
  // A silent isError here would otherwise surface as a confusing JSON.parse
  // failure several lines later.
  expect(res.isError).toBeUndefined()
  return JSON.parse(res.content[0]!.text) as T
}

/** A tool call expected to FAIL as an isError result — returns the message. */
async function toolError(
  name: string,
  args: Record<string, unknown> = {},
  auth: Auth = { bearer: orgToken },
): Promise<string> {
  const res = await callTool(name, args, auth)
  expect(res.isError).toBe(true)
  return res.content[0]!.text
}

/** Every tool that resolves a workspace, with the minimum args it needs. */
const WORKSPACE_TOOLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['list_runs', {}],
  ['get_run', { runId: 'a-run-1' }],
  ['run_trends', {}],
  ['cache_stats', {}],
  ['why_did_rerun', { runId: 'a-run-1', taskId: 'web#build' }],
  ['compare_runs', { runId: 'a-run-2' }],
]

interface WorkspaceEcho {
  workspace: string
}

// --------------------------------------------------------------------------

beforeAll(async () => {
  plat = await bootPlatform()
  origin = plat.origin
  orgToken = plat.ciToken

  // Org A gets three workspaces. `alpha` holds the real fixture; `bravo` is the
  // decoy every clamp assertion proves absent; `trend` is an isolated series so
  // the trend assertions are not perturbed by alpha's rows.
  // `bulk` exists purely so `list_runs`' default limit is OBSERVABLE: with only
  // a handful of runs, dropping mcp's `: 50` would fall through to
  // `listInvocations`' own `?? 50` and change nothing measurable, so the
  // assertion would pass either way.
  await ingest(summary('r-alpha-seed', 'alpha', NOW - 10 * HOUR), orgToken)
  await ingest(summary('r-bravo-seed', 'bravo', NOW - 9 * HOUR), orgToken)
  await ingest(summary('r-trend-seed', 'trend', NOW - 20 * HOUR), orgToken)
  await ingest(summary('r-bulk-seed', 'bulk', NOW - 12 * HOUR), orgToken)

  const listed = await fetch(`${origin}/v1/workspaces`, {
    headers: { authorization: `Bearer ${orgToken}` },
  })
  for (const w of ((await listed.json()) as { workspaces: { id: string; name: string }[] })
    .workspaces) {
    ws[w.name] = w.id
  }

  db = openDb(plat.dbUrl)
  const org = plat.orgId
  const alpha = ws['alpha']!

  // Two alpha invocations, an hour apart, so `compare_runs` has a predecessor
  // and `why_did_rerun` has a key to compare against.
  await db.sql`
    INSERT INTO invocations (run_id, org_id, workspace_id, command, requested_tasks, cache_policy,
      concurrency, flow, started_at, ended_at, total_duration_ms, task_count, failed_count,
      hit_count, hit_local_count, hit_remote_count, exit_ok, branch, ci, os, arch, vx_version, tags)
    VALUES ('a-run-1', ${org}, ${alpha}, 'vx run build', '["build"]'::jsonb, 'lR,lW,rR,rW', 4,
            'broad', ${NOW - 2 * HOUR}, ${NOW - 2 * HOUR + 100}, 100, 1, 0, 0, 0, 0, true,
            'main', true, 'linux', 'x64', '0.0.0', '{}'::jsonb),
           ('a-run-2', ${org}, ${alpha}, 'vx run build', '["build"]'::jsonb, 'lR,lW,rR,rW', 4,
            'broad', ${NOW - HOUR}, ${NOW - HOUR + 100}, 100, 2, 0, 1, 1, 0, true,
            'main', true, 'linux', 'x64', '0.0.0', '{}'::jsonb),
           -- A header with no task rows, and (below) task rows with no header:
           -- the two halves of get_run's found disjunction, each reachable in
           -- production. The second is what a LIVE run looks like -- incremental
           -- ingest writes task_runs per task and the header only at run end.
           -- (No backticks in this comment: it lives inside a tagged template.)
           ('header-only', ${org}, ${alpha}, 'vx run build', '["build"]'::jsonb, 'lR,lW,rR,rW', 4,
            'broad', ${NOW - 5 * HOUR}, ${NOW - 5 * HOUR + 100}, 100, 0, 0, 0, 0, 0, true,
            'main', true, 'linux', 'x64', '0.0.0', '{}'::jsonb)`
  // web#build re-ran under a DIFFERENT key in a-run-2 — the input change
  // `why_did_rerun` exists to explain. api#test is the one cache hit, so the
  // cache_stats hit count is a number no other workspace produces.
  await db.sql`
    INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status, exit_code,
      duration_ms, started_at, ended_at, cache_hit)
    VALUES (${org}, ${alpha}, 'a-run-1', 'key-one', 'web', 'build', 'success', 0, 500,
            ${NOW - 2 * HOUR}, ${NOW - 2 * HOUR + 500}, false),
           (${org}, ${alpha}, 'a-run-2', 'key-two', 'web', 'build', 'success', 0, 700,
            ${NOW - HOUR}, ${NOW - HOUR + 700}, false),
           (${org}, ${alpha}, 'a-run-2', 'key-api', 'api', 'test', 'cache-hit', 0, 5,
            ${NOW - HOUR}, ${NOW - HOUR + 5}, true),
           (${org}, ${alpha}, 'tasks-only', 'key-ghost', 'ghost', 'build', 'success', 0, 10,
            ${NOW - 6 * HOUR}, ${NOW - 6 * HOUR + 10}, false)`

  // 59 more invocations in `bulk` (60 with its seed) — past the 50 default so
  // the default is what truncates, and under the 500 ceiling so the ceiling is
  // not what does.
  await db.sql`
    INSERT INTO invocations (run_id, org_id, workspace_id, command, requested_tasks, cache_policy,
      concurrency, flow, started_at, ended_at, total_duration_ms, task_count, failed_count,
      hit_count, hit_local_count, hit_remote_count, exit_ok, branch, ci, os, arch, vx_version, tags)
    SELECT 'bulk-' || g, ${org}, ${ws['bulk']!}, 'vx run build', '["build"]'::jsonb, 'p', 4,
           'broad', ${NOW} - g * 1000, ${NOW} - g * 1000 + 100, 100, 1, 0, 0, 0, 0, true,
           'main', true, 'linux', 'x64', '0.0.0', '{}'::jsonb
    FROM generate_series(1, 59) g`

  // The no-argument default is "the org's most-recently-seen workspace", read
  // from repos.last_seen_at — which ingest stamps with the wall clock, so two
  // pushes in the same millisecond would make the default non-deterministic.
  // Pin the order explicitly: alpha is newest.
  for (const [name, seen] of [
    ['alpha', NOW],
    ['bravo', NOW - 1000],
    ['trend', NOW - 2000],
    ['bulk', NOW - 3000],
  ] as const) {
    await db.sql`UPDATE repos SET last_seen_at = ${seen} WHERE workspace_id = ${ws[name]!}`
  }

  // A workspace-scoped token pinned to alpha — the clamp the tool `workspace`
  // argument must never be able to widen.
  alphaToken = await mintToken(plat.orgId, 'alpha-scoped', alpha)

  // A second org, with data of its own that org A must never reach.
  orgBId = await createOrg('org-b')
  orgBToken = await mintToken(orgBId, 'org-b-ci')
  await ingest(summary('r-charlie-seed', 'charlie', NOW - 8 * HOUR), orgBToken)
  const bList = await fetch(`${origin}/v1/workspaces`, {
    headers: { authorization: `Bearer ${orgBToken}` },
  })
  charlieWs = ((await bList.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id

  // A third org that never pushed — the only way to reach the nil-uuid branch.
  emptyToken = await mintToken(await createOrg('org-empty'), 'empty-ci')
})

afterAll(async () => {
  await db.close()
  await plat.stop()
})

// --------------------------------------------------------------------------

describe('fixture sanity', () => {
  // Without this, a clamp assertion could pass because the decoy row was never
  // written — the classic way a tenant test goes vacuous.
  it('the three org-A workspaces exist and are distinct', () => {
    expect(new Set([ws['alpha'], ws['bravo'], ws['trend']]).size).toBe(3)
    expect(charlieWs).not.toBe(ws['alpha'])
  })

  it("alpha's runs are visible and bravo's are not the same rows", async () => {
    const a = await tool<{ runs: { runId: string }[] }>('list_runs', { workspace: ws['alpha']! })
    const b = await tool<{ runs: { runId: string }[] }>('list_runs', { workspace: ws['bravo']! })
    expect(a.runs.map((r) => r.runId)).toEqual([
      'a-run-2',
      'a-run-1',
      'header-only',
      'r-alpha-seed',
    ])
    expect(b.runs.map((r) => r.runId)).toEqual(['r-bravo-seed'])
  })

  it('the header-less run has task rows but no invocation', async () => {
    // `tasks-only` is deliberately absent from list_runs (which reads the
    // invocations header table) while get_run still finds it — the asymmetry
    // the `found` disjunction exists to handle.
    const r = await tool<{ found: boolean; invocation: unknown; tasks: unknown[] }>('get_run', {
      runId: 'tasks-only',
      workspace: ws['alpha']!,
    })
    expect(r.found).toBe(true)
    expect(r.invocation).toBeNull()
    expect(r.tasks).toHaveLength(1)
  })
})

describe('resolveWorkspace — a workspace-scoped token IGNORES the workspace argument', () => {
  // The sharpest surface in the file. `resolveWorkspace` returns
  // `ctx.tokenWorkspaceId` before it ever looks at `args.workspace`, so a token
  // bound to one workspace cannot be talked into reading a sibling — not by
  // naming it, and not by naming something that does not exist.
  //
  // The echo is asserted alongside the data on purpose. A surface that ignored
  // the argument but echoed it back would look correct to a model reading the
  // payload, which is precisely the defect the 2026-07-26 core audit found in
  // `vx mcp`'s cache-stats `scope`.

  it('naming a sibling workspace still reads the token’s own', async () => {
    const r = await tool<{ workspace: string; runs: { runId: string }[] }>(
      'list_runs',
      { workspace: ws['bravo']! },
      { bearer: alphaToken },
    )
    expect(r.workspace).toBe(ws['alpha']!)
    expect(r.workspace).not.toBe(ws['bravo']!)
    // The decoy's only run must be absent, and alpha's present — so "the clamp
    // held" is distinguishable from "there was nothing to leak".
    const ids = r.runs.map((x) => x.runId)
    expect(ids).toContain('a-run-2')
    expect(ids).not.toContain('r-bravo-seed')
  })

  it('naming a workspace that does not exist is not even an error', async () => {
    // Proof the argument is never consulted: an unknown workspace throws for an
    // org-wide token (below), so a scoped token answering normally can only mean
    // the early return fired first.
    const r = await tool<WorkspaceEcho>(
      'list_runs',
      { workspace: 'not-a-workspace-at-all' },
      { bearer: alphaToken },
    )
    expect(r.workspace).toBe(ws['alpha']!)
  })

  it("naming ANOTHER ORG's workspace reads the token's own", async () => {
    const r = await tool<{ workspace: string; runs: { runId: string }[] }>(
      'list_runs',
      { workspace: charlieWs },
      { bearer: alphaToken },
    )
    expect(r.workspace).toBe(ws['alpha']!)
    expect(r.runs.map((x) => x.runId)).not.toContain('r-charlie-seed')
  })

  for (const [name, args] of WORKSPACE_TOOLS) {
    it(`${name} routes through the clamp`, async () => {
      // Generated per tool so a NEW tool that forgets `resolveWorkspace` — or
      // reads `args.workspace` directly — fails here rather than shipping a
      // cross-workspace read behind a familiar-looking name.
      const r = await tool<WorkspaceEcho>(
        name,
        { ...args, workspace: ws['bravo']! },
        { bearer: alphaToken },
      )
      expect(r.workspace).toBe(ws['alpha']!)
    })
  }
})

describe('resolveWorkspace — an org-wide token resolves within its org', () => {
  it('an explicitly named unknown workspace THROWS, surfaced as isError', async () => {
    // Distinct from the empty-org case below: naming something that is not
    // there is a caller mistake and must be reported, or a model would read a
    // confidently empty result as "this workspace has no runs".
    const msg = await toolError('list_runs', { workspace: STRANGER_UUID })
    expect(msg).toContain('unknown workspace')
    expect(msg).toContain(STRANGER_UUID)
  })

  it('a non-uuid workspace name is unknown, not a lookup key', async () => {
    // `resolveReadWorkspace` refuses anything that is not a uuid before it
    // queries, so a slug or display name is an error rather than a silent miss.
    expect(await toolError('list_runs', { workspace: 'alpha' })).toContain('unknown workspace')
    expect(await toolError('list_runs', { workspace: "' OR 1=1 --" })).toContain(
      'unknown workspace',
    )
  })

  it("another org's workspace id is unknown here — never a cross-org read", async () => {
    // The id is well-formed and real; only the org clamp inside
    // `resolveReadWorkspace` keeps it from resolving.
    const msg = await toolError('list_runs', { workspace: charlieWs })
    expect(msg).toContain('unknown workspace')
    // And the reverse direction, so neither org can reach the other.
    expect(
      await toolError('list_runs', { workspace: ws['alpha']! }, { bearer: orgBToken }),
    ).toContain('unknown workspace')
  })

  it('org B reads only its own rows', async () => {
    const r = await tool<{ workspace: string; runs: { runId: string }[] }>(
      'list_runs',
      {},
      { bearer: orgBToken },
    )
    expect(r.workspace).toBe(charlieWs)
    expect(r.runs.map((x) => x.runId)).toEqual(['r-charlie-seed'])
  })

  it('no argument resolves the most-recently-seen workspace', async () => {
    const r = await tool<{ workspace: string; runs: { runId: string }[] }>('list_runs', {})
    expect(r.workspace).toBe(ws['alpha']!)
    expect(r.runs.map((x) => x.runId)).toContain('a-run-2')
  })

  it('an EMPTY or non-string workspace is treated as absent, not as unknown', async () => {
    // `typeof requested === 'string' && requested !== ''` — so an agent
    // interpolating an unset variable gets the default rather than an error.
    // Pinned because the two readings are both defensible and the choice is
    // invisible to the caller.
    for (const value of ['', 123, null, true, ['x'], {}]) {
      const r = await tool<WorkspaceEcho>('list_runs', { workspace: value })
      expect(r.workspace).toBe(ws['alpha']!)
    }
  })
})

describe('resolveWorkspace — an org with no workspaces', () => {
  // The nil-uuid branch: `resolveReadWorkspace` finds nothing AND no workspace
  // was named, so there is no caller mistake to report. Every read then filters
  // on a uuid no row can carry, which is what makes "empty" honest rather than
  // a silent fallback to some other tenant's data.

  it('no argument yields the nil workspace and empty reads', async () => {
    const r = await tool<{ workspace: string; runs: unknown[] }>(
      'list_runs',
      {},
      { bearer: emptyToken },
    )
    expect(r.workspace).toBe(NIL_UUID)
    expect(r.runs).toEqual([])
  })

  it('the nil workspace really is empty on every tool, not just list_runs', async () => {
    const stats = await tool<{ workspace: string; stats: { runCountLast24h: number } }>(
      'cache_stats',
      {},
      { bearer: emptyToken },
    )
    expect(stats.workspace).toBe(NIL_UUID)
    expect(stats.stats.runCountLast24h).toBe(0)
    const run = await tool<{ found: boolean }>(
      'get_run',
      { runId: 'a-run-1' },
      { bearer: emptyToken },
    )
    expect(run.found).toBe(false)
  })

  it('but naming a workspace explicitly is still an error there', async () => {
    // The distinction that keeps "no workspaces yet" from swallowing a typo.
    const msg = await toolError('list_runs', { workspace: STRANGER_UUID }, { bearer: emptyToken })
    expect(msg).toContain('unknown workspace')
  })
})

describe('list_workspaces — scoped by org alone', () => {
  // The one tool that takes no workspace: it is the switcher's source, so
  // narrowing it to the current workspace would make switching impossible. Its
  // clamp is `ctx.orgId`, and that is the only thing standing between two
  // tenants' workspace inventories.

  it("names every workspace in the caller's org and no other's", async () => {
    const a = await tool<{ workspaces: { id: string; name: string }[] }>('list_workspaces')
    expect(a.workspaces.map((w) => w.name).sort()).toEqual(['alpha', 'bravo', 'bulk', 'trend'])
    expect(a.workspaces.map((w) => w.id)).not.toContain(charlieWs)

    const b = await tool<{ workspaces: { id: string; name: string }[] }>(
      'list_workspaces',
      {},
      { bearer: orgBToken },
    )
    expect(b.workspaces.map((w) => w.name)).toEqual(['charlie'])
    expect(b.workspaces.map((w) => w.id)).not.toContain(ws['alpha']!)
  })

  it('an org with no workspaces answers an empty list, not the nil workspace', async () => {
    const r = await tool<{ workspaces: unknown[] }>('list_workspaces', {}, { bearer: emptyToken })
    expect(r.workspaces).toEqual([])
  })

  it('a workspace-scoped token still sees the whole ORG inventory', async () => {
    // Deliberate and consistent with `GET /v1/workspaces`, which is also
    // `workspacesForOrg(ctx.orgId)` regardless of the token's binding. It does
    // mean a scoped token can enumerate sibling names/ids — but it cannot READ
    // them (proved above), and narrowing only one of the two surfaces would be
    // the drift. Pinned so a change to either is a deliberate one.
    const r = await tool<{ workspaces: { name: string }[] }>(
      'list_workspaces',
      {},
      { bearer: alphaToken },
    )
    expect(r.workspaces.map((w) => w.name).sort()).toEqual(['alpha', 'bravo', 'bulk', 'trend'])
  })

  it('ignores a workspace argument entirely rather than failing on it', async () => {
    // It advertises no `workspace` property, but a model may send one anyway.
    const r = await tool<{ workspaces: unknown[] }>('list_workspaces', {
      workspace: STRANGER_UUID,
    })
    expect(r.workspaces).toHaveLength(4)
  })
})

describe('tools/list ⇄ callTool — the advertisement must match the implementation', () => {
  // Two independent lists describe one set: `MCP_TOOLS` is what a model reads
  // and decides to call; the `callTool` switch is what actually runs. A model
  // has no way to discover the difference — an advertised-but-unimplemented
  // tool is a hard -32602 mid-task, and an implemented-but-unadvertised tool is
  // simply never used.
  //
  // TRAP (the analytics-route-drift lesson): parsing only works while the
  // switch is literal. The parse-sanity assertion below is what stops this
  // whole block from passing vacuously against an empty set, and it must be
  // FIXED rather than relaxed if the dispatch shape ever changes.

  const MCP_SRC = readFileSync(path.join(import.meta.dir, '..', 'src', 'cli', 'mcp.ts'), 'utf8')

  function switchCasesIn(fnSignature: string): string[] {
    const start = MCP_SRC.indexOf(fnSignature)
    if (start === -1) {
      throw new Error(
        `mcp drift guard: could not find \`${fnSignature}\` in src/cli/mcp.ts — ` +
          'the dispatch shape changed and this guard must be rewritten, not deleted',
      )
    }
    // Functions are top-level, so the first column-0 closing brace ends the body.
    const end = MCP_SRC.indexOf('\n}\n', start)
    if (end === -1) throw new Error('mcp drift guard: unterminated function body')
    const body = MCP_SRC.slice(start, end)
    return [...new Set([...body.matchAll(/case '([^']+)':/g)].map((m) => m[1]!))].sort()
  }

  const dispatchedTools = switchCasesIn('async function callTool(')
  const dispatchedMethods = switchCasesIn('async function handleMessage(')
  const advertised = MCP_TOOLS.map((t) => t.name).sort()

  it('extracts a healthy set from the source', () => {
    expect(dispatchedTools.length).toBeGreaterThanOrEqual(7)
    expect(dispatchedMethods.length).toBeGreaterThanOrEqual(4)
    expect(advertised.length).toBeGreaterThanOrEqual(7)
  })

  it('every dispatched tool is advertised', () => {
    expect(dispatchedTools).toEqual(advertised)
  })

  for (const t of MCP_TOOLS) {
    it(`${t.name} is actually callable`, async () => {
      // The behavioural half of the direction above: an unknown tool is the ONLY
      // path to a -32602 error response, because a bad argument is an isError
      // RESULT. So "the envelope carries a result" is exactly "the switch has
      // this case".
      const res = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: t.name, arguments: {} },
      })
      expect(res.error).toBeUndefined()
      expect(res.result).toBeDefined()
    })
  }

  it('an unknown tool is a protocol error, not an isError result', async () => {
    // The asymmetry is deliberate and load-bearing: a model can self-correct
    // from a bad ARGUMENT (an isError result it can read and retry), but a
    // misspelled TOOL NAME is a client fault the protocol layer should report.
    const res = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_run', arguments: {} },
    })
    expect(res.result).toBeUndefined()
    expect(res.error?.code).toBe(-32602)
    expect(res.error?.message).toBe('unknown tool: list_run')
  })

  it('every advertised tool carries a name, description and object schema', () => {
    for (const t of MCP_TOOLS) {
      expect(typeof t.name).toBe('string')
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.inputSchema['type']).toBe('object')
    }
  })
})

describe('required arguments — the schema must match what requireString enforces', () => {
  // `inputSchema.required` is a THIRD list describing the same contract, and it
  // is the only one a model reads. If a field is required by the code but not
  // advertised, every model call fails until it guesses; if advertised but not
  // required, a tool silently runs on a missing value.

  function requiredFields(schema: Record<string, unknown>): string[] {
    const r = schema['required']
    return Array.isArray(r) ? (r as string[]) : []
  }

  it('the advertised required set is what it should be', () => {
    // Pinned literally so adding a required field to a schema without
    // implementing the check (or vice versa) has to be a deliberate edit here.
    const map = Object.fromEntries(
      MCP_TOOLS.map((t) => [t.name, requiredFields(t.inputSchema)] as const),
    )
    expect(map).toEqual({
      list_workspaces: [],
      list_runs: [],
      get_run: ['runId'],
      run_trends: [],
      cache_stats: [],
      why_did_rerun: ['runId', 'taskId'],
      compare_runs: ['runId'],
    })
  })

  for (const t of MCP_TOOLS) {
    for (const field of requiredFields(t.inputSchema)) {
      it(`${t.name} refuses a missing ${field}`, async () => {
        const args = Object.fromEntries(
          requiredFields(t.inputSchema)
            .filter((f) => f !== field)
            .map((f) => [f, f === 'taskId' ? 'web#build' : 'a-run-1']),
        )
        const msg = await toolError(t.name, args)
        // The message names BOTH the tool and the field — a model correcting
        // itself mid-conversation has only this string to work from.
        expect(msg).toContain(t.name)
        expect(msg).toContain(field)
      })

      it(`${t.name} refuses an empty or non-string ${field}`, async () => {
        // `requireString` rejects '' as well as the wrong type. An empty string
        // is what an unset shell variable interpolates to, and treating it as a
        // real id would answer "no such run" for a request that was malformed.
        for (const bad of ['', 42, null, true, { a: 1 }, ['a-run-1']]) {
          const args = Object.fromEntries(
            requiredFields(t.inputSchema).map((f) => [
              f,
              f === field ? bad : f === 'taskId' ? 'web#build' : 'a-run-1',
            ]),
          )
          expect(await toolError(t.name, args)).toContain(`${t.name}: ${field} must be a string`)
        }
      })
    }
  }

  it('a tool with no required fields succeeds on an empty argument object', async () => {
    for (const t of MCP_TOOLS.filter((x) => requiredFields(x.inputSchema).length === 0)) {
      const res = await callTool(t.name, {})
      expect(res.isError).toBeUndefined()
    }
  })
})

describe('list_runs — limit defaults and coercions', () => {
  it('defaults to exactly 50 of 60', async () => {
    // The `bulk` workspace is sized past the default on purpose, so this
    // asserts the number rather than merely "not truncated". A model that asks
    // for a workspace's runs and silently receives the newest 50 of 600 will
    // reason about a partial history as though it were complete — which is why
    // the page size is worth pinning even though nothing reports it.
    const r = await tool<{ runs: unknown[] }>('list_runs', { workspace: ws['bulk']! })
    expect(r.runs).toHaveLength(50)
  })

  it('an explicit limit above the default reaches further back', async () => {
    // The control proving 50 is the DEFAULT and not a ceiling: the same
    // workspace yields all 60 when asked.
    const r = await tool<{ runs: unknown[] }>('list_runs', { workspace: ws['bulk']!, limit: 60 })
    expect(r.runs).toHaveLength(60)
  })

  it('a numeric limit truncates from the newest end', async () => {
    const r = await tool<{ runs: { runId: string }[] }>('list_runs', {
      workspace: ws['alpha']!,
      limit: 2,
    })
    expect(r.runs.map((x) => x.runId)).toEqual(['a-run-2', 'a-run-1'])
  })

  it('a STRING limit is silently ignored and the default applies', async () => {
    // `typeof args['limit'] === 'number'` — and JSON-RPC arguments come from a
    // model, which produces `"2"` about as readily as `2`. The request is not
    // refused and the response says nothing, so the caller sees 3 rows where it
    // asked for 2 and has no way to notice. Pinned as CURRENT behaviour.
    const r = await tool<{ runs: unknown[] }>('list_runs', {
      workspace: ws['alpha']!,
      limit: '2',
    })
    expect(r.runs).toHaveLength(4)
  })

  it('a non-positive or fractional limit is clamped downstream, never an error', async () => {
    // clampInt(n, 1, 500): floor, then bound. `limit: 0` meaning ONE row is the
    // surprising one — an agent asking for "no rows" gets a row.
    const at = async (limit: unknown): Promise<number> =>
      (await tool<{ runs: unknown[] }>('list_runs', { workspace: ws['alpha']!, limit })).runs.length
    expect(await at(0)).toBe(1)
    expect(await at(-5)).toBe(1)
    expect(await at(2.9)).toBe(2)
    expect(await at(1e9)).toBe(4) // capped at 500, so the fixture is what limits
  })

  it('NaN and Infinity cannot reach this surface at all', async () => {
    // Worth stating because the sibling HTTP surface DOES have to handle them:
    // `/v1/failures?limit=NaN` parses a string, so `numParam` sees NaN and
    // falls back. JSON has no NaN/Infinity literal — `JSON.stringify` emits
    // `null` — so over JSON-RPC they arrive as null, fail the `typeof ===
    // 'number'` test, and take the default. There is no non-finite path here to
    // guard, which is why `clampInt`'s `Number.isFinite` branch is unreachable
    // from MCP.
    expect(JSON.stringify({ limit: Number.NaN })).toBe('{"limit":null}')
    const r = await tool<{ runs: unknown[] }>('list_runs', {
      workspace: ws['alpha']!,
      limit: Number.NaN,
    })
    expect(r.runs).toHaveLength(4)
  })
})

describe('run_trends — bucket coercion and slice direction', () => {
  // Two lossy conversions in six lines, neither reported to the caller.

  const trendWs = (): string => ws['trend']!

  it("bucket is 'day' only on an exact match", async () => {
    const r = await tool<{ bucket: string }>('run_trends', {
      workspace: trendWs(),
      bucket: 'day',
    })
    expect(r.bucket).toBe('day')
  })

  it('anything else silently becomes hourly', async () => {
    // `args['bucket'] === 'day' ? 'day' : 'hour'`. A model that writes 'DAY',
    // 'daily' or 'week' gets a 24-hour window of hourly points and is told
    // `bucket: "hour"` — the echo is honest, but nothing rejects the request,
    // so a chart built from it silently covers 1/30th of the intended span.
    for (const bucket of ['DAY', 'Day', 'daily', 'week', 'month', 5, true, null]) {
      const r = await tool<{ bucket: string }>('run_trends', { workspace: trendWs(), bucket })
      expect(r.bucket).toBe('hour')
    }
  })

  it('the echoed bucket is the one actually queried, proven by point spacing', async () => {
    // The echo alone could be right while the query used the other bucket —
    // that is the 2026-07-27 F8 class. Spacing is the observable that cannot lie.
    const hourly = await tool<{ points: { t: number }[] }>('run_trends', {
      workspace: trendWs(),
      bucket: 'hour',
    })
    const daily = await tool<{ points: { t: number }[] }>('run_trends', {
      workspace: trendWs(),
      bucket: 'day',
    })
    expect(hourly.points[1]!.t - hourly.points[0]!.t).toBe(HOUR)
    expect(daily.points[1]!.t - daily.points[0]!.t).toBe(DAY)
    // …and the two windows differ: 24h of hourly buckets vs 30d of daily ones.
    expect(hourly.points).toHaveLength(25)
    expect(daily.points).toHaveLength(31)
  })

  it('limit takes the MOST RECENT points, not the first', async () => {
    // `points.slice(-limit)`. The fixture's only run sits ~20h back, so a
    // first-N implementation would include it and a last-N one must not — the
    // difference between "here is what just happened" and "here is what
    // happened yesterday", presented identically.
    const all = await tool<{ points: { t: number; runs: number }[] }>('run_trends', {
      workspace: trendWs(),
      bucket: 'hour',
    })
    const tail = await tool<{ points: { t: number; runs: number }[] }>('run_trends', {
      workspace: trendWs(),
      bucket: 'hour',
      limit: 3,
    })
    expect(tail.points.map((p) => p.t)).toEqual(all.points.slice(-3).map((p) => p.t))
    expect(tail.points[0]!.t).not.toBe(all.points[0]!.t)
    // The seeded run is in the window but NOT in its last three hours.
    expect(all.points.reduce((n, p) => n + p.runs, 0)).toBe(1)
    expect(tail.points.reduce((n, p) => n + p.runs, 0)).toBe(0)
  })

  it('a limit larger than the series returns the whole series', async () => {
    const r = await tool<{ points: unknown[] }>('run_trends', {
      workspace: trendWs(),
      bucket: 'hour',
      limit: 1000,
    })
    expect(r.points).toHaveLength(25)
  })

  it('a STRING limit is ignored, like list_runs', async () => {
    const r = await tool<{ points: unknown[] }>('run_trends', {
      workspace: trendWs(),
      bucket: 'hour',
      limit: '3',
    })
    expect(r.points).toHaveLength(25)
  })

  it('FINDING: a negative limit returns the WHOLE series, not an empty one', async () => {
    // `slice(-limit)` with limit = -3 is `slice(3)` — it DROPS the three oldest
    // points and returns 22, which reads as a legitimate answer. Every other
    // limit on the platform clamps to >= 1 (`clampInt`); this one is raw
    // arithmetic on caller input, so the sign is load-bearing and unchecked.
    // Same class as the 2026-07-26 CLI wave's `--max-size 0` (a non-positive
    // value silently meaning something else entirely). Pinned as CURRENT
    // behaviour; clamping to >= 1 would be the fix.
    const r = await tool<{ points: unknown[] }>('run_trends', {
      workspace: trendWs(),
      bucket: 'hour',
      limit: -3,
    })
    expect(r.points).toHaveLength(22)
    // And limit: 0 empties the series entirely — `slice(-0)` is `slice(0)`.
    const zero = await tool<{ points: unknown[] }>('run_trends', {
      workspace: trendWs(),
      bucket: 'hour',
      limit: 0,
    })
    expect(zero.points).toHaveLength(25)
  })
})

describe('get_run — the not-found shape', () => {
  it('found:true carries the invocation header AND the task rows', async () => {
    const r = await tool<{
      found: boolean
      workspace: string
      runId: string
      invocation: { command: string } | null
      tasks: { project: string; task: string; hash: string }[]
    }>('get_run', { runId: 'a-run-2', workspace: ws['alpha']! })
    expect(r.found).toBe(true)
    expect(r.runId).toBe('a-run-2')
    expect(r.workspace).toBe(ws['alpha']!)
    expect(r.invocation?.command).toBe('vx run build')
    // Rows carry `project` + `task` separately (never a joined `taskId`) — the
    // shape a model has to reassemble before it can call why_did_rerun, which
    // takes the JOINED form. Pinned because the asymmetry is easy to break.
    expect(r.tasks.map((t) => `${t.project}#${t.task}`).sort()).toEqual(['api#test', 'web#build'])
  })

  it('found:true means at least one of the two sources had the run', async () => {
    // `found` is `!(invocation === null && detail === null)`, so a run with an
    // invocation header but no task rows — or task rows but no header, which is
    // what a LIVE run looks like mid-flight under incremental ingest — is still
    // found, with the missing half rendered honestly rather than as absence of
    // the run. `tasks` falls back to [] rather than null for the same reason.
    const r = await tool<{ found: boolean; invocation: unknown; tasks: unknown[] }>('get_run', {
      runId: 'header-only',
      workspace: ws['alpha']!,
    })
    expect(r.found).toBe(true)
    expect(r.invocation).not.toBeNull()
    expect(r.tasks).toEqual([])
  })

  it('an unknown run id is found:false with a note, not an error', async () => {
    // A question about a run that is not there has a valid answer; refusing
    // would make a model retry rather than move on.
    const r = await tool<{ found: boolean; note: string; workspace: string }>('get_run', {
      runId: 'no-such-run',
      workspace: ws['alpha']!,
    })
    expect(r.found).toBe(false)
    expect(r.note).toBe('no run with that id in this workspace')
    expect(r.workspace).toBe(ws['alpha']!)
  })

  it('a run that exists in ANOTHER workspace reads found:false here', async () => {
    // Where the clamp and the not-found path meet, and the one case that would
    // expose a dropped `workspace_id` predicate as data rather than as silence.
    const here = await tool<{ found: boolean }>('get_run', {
      runId: 'r-bravo-seed',
      workspace: ws['alpha']!,
    })
    expect(here.found).toBe(false)
    // The control: it IS found one workspace over, so the row genuinely exists.
    const there = await tool<{ found: boolean }>('get_run', {
      runId: 'r-bravo-seed',
      workspace: ws['bravo']!,
    })
    expect(there.found).toBe(true)
  })

  it('a run that exists in another ORG reads found:false', async () => {
    const r = await tool<{ found: boolean }>('get_run', { runId: 'r-charlie-seed' })
    expect(r.found).toBe(false)
    const control = await tool<{ found: boolean }>(
      'get_run',
      { runId: 'r-charlie-seed' },
      { bearer: orgBToken },
    )
    expect(control.found).toBe(true)
  })
})

describe('cache_stats, why_did_rerun and compare_runs', () => {
  it('cache_stats counts only the resolved workspace', async () => {
    // alpha holds 5 executed rows (1 seeded + 4 inserted) of which one is a
    // cache hit; bravo holds exactly 1 and no hits; trend 1. An unclamped read
    // would report 7 — the sum across org A — so the numbers are chosen to make
    // a leak arithmetically visible rather than merely "non-empty".
    const a = await tool<{
      stats: { runCountLast24h: number; hitCountLast24h: number }
      hitSplit: { total: number; hits: number }
    }>('cache_stats', { workspace: ws['alpha']! })
    expect(a.stats.runCountLast24h).toBe(5)
    expect(a.stats.hitCountLast24h).toBe(1)
    expect(a.hitSplit.total).toBe(5)
    expect(a.hitSplit.hits).toBe(1)

    const b = await tool<{ stats: { runCountLast24h: number; hitCountLast24h: number } }>(
      'cache_stats',
      { workspace: ws['bravo']! },
    )
    expect(b.stats.runCountLast24h).toBe(1)
    expect(b.stats.hitCountLast24h).toBe(0)
  })

  it('why_did_rerun reports the key change between consecutive runs', async () => {
    // The taskId arrives JOINED (`project#task`) and is split on the first '#'
    // — the one place a model has to compose an identifier rather than pass a
    // field straight back from get_run.
    const r = await tool<{
      workspace: string
      why: {
        found: boolean
        hashChanged: boolean | null
        thisRun?: { hash: string }
        previousRun?: { hash: string } | null
        note: string
      }
      inputDiff: Record<string, unknown>
    }>('why_did_rerun', {
      runId: 'a-run-2',
      taskId: 'web#build',
      workspace: ws['alpha']!,
    })
    expect(r.workspace).toBe(ws['alpha']!)
    expect(r.why.found).toBe(true)
    expect(r.why.hashChanged).toBe(true)
    expect(r.why.thisRun?.hash).toBe('key-two')
    expect(r.why.previousRun?.hash).toBe('key-one')
    expect(r.why.note).toContain('cache key changed')
    expect(r.inputDiff).toBeDefined()
  })

  it('why_did_rerun on the FIRST run of a task says so, with a NULL verdict', async () => {
    // `hashChanged: null` rather than `false` is the honest third state the
    // 2026-07-27 F7 wave established: with no prior keyed run there is no
    // evidence either way, and `false` would assert "the inputs did not change".
    const r = await tool<{
      why: { found: boolean; previousRun: unknown; hashChanged: boolean | null; note: string }
    }>('why_did_rerun', {
      runId: 'a-run-1',
      taskId: 'web#build',
      workspace: ws['alpha']!,
    })
    expect(r.why.found).toBe(true)
    expect(r.why.previousRun).toBeNull()
    expect(r.why.hashChanged).toBeNull()
    expect(r.why.note).toBe('no prior run for this (project, task)')
  })

  it('why_did_rerun for a run in ANOTHER workspace finds nothing', async () => {
    const r = await tool<{ why: { found: boolean; note: string } }>('why_did_rerun', {
      runId: 'r-bravo-seed',
      taskId: 'seed#build',
      workspace: ws['alpha']!,
    })
    expect(r.why.found).toBe(false)
    expect(r.why.note).toBe('no row matching that runId + taskId')
    // The control: the same pair IS found one workspace over, so the row
    // genuinely exists and the clamp is what hid it.
    const there = await tool<{ why: { found: boolean } }>('why_did_rerun', {
      runId: 'r-bravo-seed',
      taskId: 'seed#build',
      workspace: ws['bravo']!,
    })
    expect(there.why.found).toBe(true)
  })

  it('why_did_rerun never pairs a task with a DIFFERENT task’s history', async () => {
    // The split is on the FIRST '#', and both halves feed the WHERE clause. A
    // dropped `task =` predicate would silently answer about `web#build` when
    // asked about `web#test`.
    const r = await tool<{ why: { found: boolean } }>('why_did_rerun', {
      runId: 'a-run-2',
      taskId: 'web#nosuchtask',
      workspace: ws['alpha']!,
    })
    expect(r.why.found).toBe(false)
  })

  it('compare_runs diffs against the previous invocation and carries the workspace', async () => {
    const r = await tool<{
      workspace: string
      found: boolean
      runId: string
      previousRunId: string | null
    }>('compare_runs', { runId: 'a-run-2', workspace: ws['alpha']! })
    expect(r.workspace).toBe(ws['alpha']!)
    expect(r.found).toBe(true)
    expect(r.runId).toBe('a-run-2')
    expect(r.previousRunId).toBe('a-run-1')
  })

  it('compare_runs on an unknown run answers found:false, still workspace-tagged', async () => {
    const r = await tool<{ workspace: string; found: boolean }>('compare_runs', {
      runId: 'no-such-run',
      workspace: ws['alpha']!,
    })
    expect(r.found).toBe(false)
    expect(r.workspace).toBe(ws['alpha']!)
  })

  it('compare_runs cannot see a run one workspace over', async () => {
    const here = await tool<{ found: boolean }>('compare_runs', {
      runId: 'a-run-2',
      workspace: ws['bravo']!,
    })
    expect(here.found).toBe(false)
  })
})

describe('JSON-RPC protocol', () => {
  it('initialize returns the pinned protocol version and server identity', async () => {
    // The version string is a negotiated constant: a client that does not
    // recognise it may refuse the session outright, so a bump is a wire change.
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(res.result).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'vx-cloud', version: expect.any(String) },
    })
    expect(MCP_PROTOCOL_VERSION).toBe('2025-03-26')
  })

  it('ping answers an empty result', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })
    expect(res.result).toEqual({})
  })

  it('an unknown method is -32601 and names the method', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' })
    expect(res.error?.code).toBe(-32601)
    expect(res.error?.message).toBe('method not found: resources/list')
  })

  it('tools/call without params.name is -32602', async () => {
    for (const params of [undefined, {}, { name: 5 }, { name: null }]) {
      const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', ...{ params } })
      expect(res.error?.code).toBe(-32602)
      expect(res.error?.message).toBe('tools/call requires params.name')
    }
  })

  it('the id is echoed exactly, including 0 and a string', async () => {
    // `msg.id ?? null` — not `||`, which would turn a client that numbers its
    // requests from 0 into one whose first response cannot be correlated.
    expect((await rpc({ jsonrpc: '2.0', id: 0, method: 'ping' })).id).toBe(0)
    expect((await rpc({ jsonrpc: '2.0', id: 'abc', method: 'ping' })).id).toBe('abc')
    expect((await rpc({ jsonrpc: '2.0', id: null, method: 'ping' })).id).toBeNull()
  })

  it('a wrong jsonrpc version is -32600, with the id preserved', async () => {
    for (const jsonrpc of ['1.0', 2.0, undefined, null]) {
      const res = await rpc({ id: 5, method: 'ping', ...{ jsonrpc } })
      expect(res.error?.code).toBe(-32600)
      expect(res.error?.message).toBe('not a JSON-RPC 2.0 request')
      expect(res.id).toBe(5)
    }
  })

  it('a non-string method is -32600, not -32601', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 6, method: 42 })
    expect(res.error?.code).toBe(-32600)
  })

  it('a notification (no id) gets 202 and an empty body', async () => {
    // JSON-RPC 2.0: a message without an id never gets a response. The two
    // notifications MCP clients actually send (notifications/initialized,
    // notifications/cancelled) need no server action.
    for (const body of [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'ping' },
      { jsonrpc: '2.0', method: 'tools/list' },
    ]) {
      const r = await rpcRaw(body)
      expect(r.status).toBe(202)
      expect(await r.text()).toBe('')
    }
  })

  it('id:null is a REQUEST, not a notification', async () => {
    // The distinction is `msg.id === undefined`, so an explicit null still
    // gets answered. A client using null ids would otherwise hang forever.
    const r = await rpcRaw({ jsonrpc: '2.0', id: null, method: 'ping' })
    expect(r.status).toBe(200)
    expect(((await r.json()) as RpcResponse).result).toEqual({})
  })
})

describe('JSON-RPC — malformed and batched bodies', () => {
  it('a body that is not JSON is -32700, never a 500', async () => {
    for (const body of ['not json at all', '{', '[1,', '']) {
      const { url, init } = rpcInit(body, { bearer: orgToken })
      const r = await fetch(url, init)
      expect(r.status).toBe(200)
      const parsed = (await r.json()) as RpcResponse
      expect(parsed.error?.code).toBe(-32700)
      expect(parsed.error?.message).toBe('parse error: body is not JSON')
      expect(parsed.id).toBeNull()
    }
  })

  it('an empty batch is -32600', async () => {
    const res = await rpc([])
    expect(res.error?.code).toBe(-32600)
    expect(res.error?.message).toBe('empty batch')
  })

  it('a batch answers an ARRAY, a single message answers an OBJECT', async () => {
    // The shape is what a client dispatches on; returning one for the other
    // strands every response in the batch.
    const batch = (await (
      await rpcRaw([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'initialize' },
      ])
    ).json()) as RpcResponse[]
    expect(Array.isArray(batch)).toBe(true)
    expect(batch.map((x) => x.id)).toEqual([1, 2])

    const single = (await (await rpcRaw({ jsonrpc: '2.0', id: 1, method: 'ping' })).json()) as
      | RpcResponse
      | RpcResponse[]
    expect(Array.isArray(single)).toBe(false)
  })

  it('a batch of one message still answers an array', async () => {
    const r = (await (await rpcRaw([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).json()) as unknown
    expect(Array.isArray(r)).toBe(true)
  })

  it('notifications are dropped from a batch response', async () => {
    const r = (await (
      await rpcRaw([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 9, method: 'ping' },
      ])
    ).json()) as RpcResponse[]
    expect(r.map((x) => x.id)).toEqual([9])
  })

  it('a batch of only notifications is 202 with no body', async () => {
    const r = await rpcRaw([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled' },
    ])
    expect(r.status).toBe(202)
    expect(await r.text()).toBe('')
  })

  it('FINDING: valid JSON that is not an object is silently ACCEPTED (202)', async () => {
    // `handleMessage` coerces any non-object to `{}`, whose `id` is undefined —
    // so it is classified as a NOTIFICATION and drops out of the response set,
    // and the request answers 202 with an empty body.
    //
    // JSON-RPC 2.0 §4.2 requires -32600 Invalid Request for exactly this. The
    // practical cost is the usual "an agent cannot tell" one: a client whose
    // serializer emits a bare value, or a proxy that rewrites the body, gets
    // silence indistinguishable from a successfully-delivered notification and
    // waits for a response that will never come. Pinned as CURRENT behaviour;
    // answering -32600 when the parsed body is not an object would be the fix.
    for (const body of ['5', '"hello"', 'null', 'true', '[[1,2]]', '[5]']) {
      const { url, init } = rpcInit(body, { bearer: orgToken })
      const r = await fetch(url, init)
      expect(r.status).toBe(202)
      expect(await r.text()).toBe('')
    }
  })

  it('an object with extra unknown members is still dispatched', async () => {
    // JSON-RPC allows no extra members, but rejecting them would break clients
    // that attach tracing metadata. Pinned so the leniency is deliberate.
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping', meta: { trace: 'x' } })
    expect(res.result).toEqual({})
  })

  it('a tool that throws surfaces as an isError RESULT, not a transport error', async () => {
    // The MCP contract: the model must SEE the failure so it can self-correct.
    // A transport error is swallowed by most clients and shown to nobody.
    const res = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_runs', arguments: { workspace: STRANGER_UUID } },
    })
    expect(res.error).toBeUndefined()
    const result = res.result as unknown as ToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0]!.type).toBe('text')
    expect(result.content[0]!.text).toContain('unknown workspace')
  })

  it('a successful tool result is pretty-printed JSON text', async () => {
    // The payload a model actually reads is a STRING; the shape of that string
    // is the contract.
    const res = await callTool('cache_stats', { workspace: ws['alpha']! })
    expect(res.isError).toBeUndefined()
    expect(res.content).toHaveLength(1)
    expect(res.content[0]!.type).toBe('text')
    expect(res.content[0]!.text).toContain('\n  ') // 2-space indent
    expect(() => JSON.parse(res.content[0]!.text)).not.toThrow()
  })
})

describe('transport — method, auth and the body cap', () => {
  it('every non-POST method is 405 with an Allow header', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const r = await fetch(`${origin}/mcp`, {
        method,
        headers: { authorization: `Bearer ${orgToken}` },
      })
      expect(r.status).toBe(405)
      if (method !== 'HEAD') expect(r.headers.get('Allow')).toBe('POST')
    }
  })

  it('no credential is 401, before any JSON is parsed', async () => {
    const r = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    expect(r.status).toBe(401)
    expect(r.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('a bogus or revoked bearer is 401', async () => {
    for (const bearer of ['vxc_not-a-real-token', 'garbage', '']) {
      expect((await rpcRaw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { bearer })).status).toBe(401)
    }
  })

  it('a browser SESSION reaches MCP and is clamped to the named org', async () => {
    // `/mcp` is deliberately NOT in `isMachineTokenOnly` — the dashboard's own
    // agent tooling authenticates with a cookie. The org comes from `?org=`,
    // never from the body, so a session cannot widen its own scope by asking.
    const r = await tool<{ workspaces: { name: string }[] }>(
      'list_workspaces',
      {},
      {
        sessionOrg: plat.orgId,
      },
    )
    expect(r.workspaces.map((w) => w.name).sort()).toEqual(['alpha', 'bravo', 'bulk', 'trend'])
  })

  it('an untrusted-tier token reads the same analytics as a trusted one', async () => {
    // The trust tier partitions the CACHE (a fork PR must not poison a trusted
    // artifact); it is not a read boundary, and MCP never consults it. Pinned so
    // the two concepts are not accidentally fused.
    const r = await tool<{ runs: { runId: string }[] }>(
      'list_runs',
      { workspace: ws['alpha']! },
      { bearer: plat.untrustedToken },
    )
    expect(r.runs.map((x) => x.runId)).toContain('a-run-2')
  })

  it('responses carry the permissive CORS header', async () => {
    // The dashboard's dev server proxies from another origin. `*` (rather than
    // an echoed Origin) is what keeps a CREDENTIALED cross-origin read from
    // succeeding, so it is load-bearing in both directions.
    const r = await rpcRaw({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
  })
})

// ORDERING, and it cost an hour to find: this block runs LAST, and the control
// inside it runs FIRST, because tripping the cap poisons the connection.
//
// A mid-flight `reader.cancel()` — exactly what the streaming cap does to a
// hostile body — desynchronises HTTP/1.1 keep-alive framing, so the NEXT
// request sent over that connection answers a bare 400 (no CORS header, no
// JSON-RPC envelope) and the one after it recovers. Reproduced OUTSIDE this
// repo against a plain `Bun.serve` with a hand-rolled cap and no vx code in
// sight, so it is a Bun runtime behaviour, not an MCP or `readTextBounded`
// defect — and there is no fix available to the server short of draining every
// oversized body, which is the precise thing the cap exists to avoid.
//
// It is deliberately NOT asserted: pinning a dependency's bug buys nothing and
// would break on the next Bun bump. It IS worth knowing operationally — a
// client that trips the 4 MiB cap on a pooled connection should expect its next
// request to need a retry.
describe('transport — the 4 MiB body cap (runs last; see the note above)', () => {
  it('CONTROL: a chunked body UNDER the cap is read normally', async () => {
    // Without this, a cap that rejected every streamed body would pass the two
    // tests below for entirely the wrong reason.
    const payload = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    )
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // Two chunks, so the reader loop genuinely iterates.
        c.enqueue(payload.slice(0, 10))
        c.enqueue(payload.slice(10))
        c.close()
      },
    })
    const r = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgToken}`, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as unknown as RequestInit)
    expect(r.status).toBe(200)
    expect(((await r.json()) as RpcResponse).result).toEqual({})
  })

  it('a body over the cap is 413, with a JSON-RPC error envelope', async () => {
    const huge = `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${'a'.repeat(4 * 1024 * 1024)}"}`
    const { url, init } = rpcInit(huge, { bearer: orgToken })
    const r = await fetch(url, init)
    expect(r.status).toBe(413)
    expect(((await r.json()) as RpcResponse).error?.message).toBe('request too large')
  })

  it('the cap counts BYTES READ, so a chunked body cannot bypass it', async () => {
    // The documented bypass class in this repo: a cap checked against
    // content-length is defeated by a chunked body, which is the whole reason
    // `readTextBounded` exists. This request carries NO content-length —
    // verified separately that Bun sends `transfer-encoding: chunked` for a
    // stream body — so only the streaming byte counter can refuse it, and it
    // must refuse before the server-wide 512 MiB artifact ceiling buffers it.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(97))
        c.close()
      },
    })
    const r = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgToken}`, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as unknown as RequestInit)
    expect(r.status).toBe(413)
    expect(((await r.json()) as RpcResponse).error?.code).toBe(-32600)
  })
})
