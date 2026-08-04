// The platform's analytics/ingest HTTP surface, served against Postgres
// (docs/design/cloud-platform-2026-07.md §5). `vx-cloud server`'s gate resolves
// the principal → (orgId, workspaceId) clamp and dispatches every analytics,
// ingest, log, catalog, and hermeticity route through here — replacing the
// transitional SQLite IngestStore path. Everything NOT matched here (the native
// cache wire, agents, dist, streaming, the SPA) falls through to the serve's
// remaining machine surfaces.

import { clampInt, isCacheHit, type RunSummaryRecord } from '@vzn/vx'
import { readTextBounded } from '../http-body.js'
import { LOG_WIRE_VERSION, type TaskLogBundle } from '../task-log-capture.js'
import {
  WorkspaceForbiddenError,
  type Analytics,
  type CatalogPush,
  type ListInvocationsArgs,
  type ListRunsArgs,
  type StoredTaskLog,
  type TaskIngestRecord,
} from './analytics.js'

const CORS = { 'Access-Control-Allow-Origin': '*' } as const
const INGEST_BODY_MAX_BYTES = 32 * 1024 * 1024
const LOG_BODY_MAX_BYTES = 16 * 1024 * 1024
const CATALOG_BODY_MAX_BYTES = 8 * 1024 * 1024
// One task: a small result record + a ≤128 KiB log tail. 2 MiB is generous
// headroom; a bigger body is a malformed/hostile push.
const TASK_BODY_MAX_BYTES = 2 * 1024 * 1024
// Wire version of the incremental per-task record (set by the cloud() sink).
// Gated like /v1/ingest/logs + /v1/catalog so a client/serve skew fails loud.
const TASK_WIRE_VERSION = 1
/** Route-level ceiling for `/v1/runs` — see the call site for why it is not
 *  `listRuns`' own 100_000. */
const ROUTE_RUNS_MAX = 5000

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS })
}

function errResponse(err: unknown): Response {
  if (err instanceof WorkspaceForbiddenError) return json({ ok: false, error: err.message }, 403)
  return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
}

/** Read the body with a HARD streaming cap — a chunked (no content-length)
 *  body aborts mid-stream instead of buffering up to the 513 MiB server-wide
 *  limit. `readCapped` is a thin alias so callers read `null → 413`. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  return await readTextBounded(req, max)
}

/**
 * SQLSTATE 22021 (`character_not_in_repertoire`) — bytes Postgres cannot store
 * in `text`, i.e. a NUL the caller sent. Read off `errno`, which Bun's
 * PostgresError carries as the SQLSTATE (`code` is the generic
 * `ERR_POSTGRES_SERVER_ERROR`).
 */
function isUnrepresentableInput(err: unknown): boolean {
  return String((err as { errno?: unknown } | null)?.errno) === '22021'
}

/**
 * A free-text filter param. An EMPTY value means ABSENT, never "match the
 * empty string": `curl ".../v1/runs?project=$PROJECT"` with an unset variable
 * must not answer a confident empty list for a workspace full of runs.
 *
 * `hash` and `search` already decided it this way while `project`/`task`/
 * `runId`/`branch`/`tag*` guarded only `!== null` — so a caller could not know
 * which rule a given param followed. This is the string-side twin of the
 * half-strict numeric knobs fixed on 2026-07-30.
 */
function textParam(v: string | null): string | undefined {
  return v === null || v === '' ? undefined : v
}

function numParam(v: string | null): number | undefined {
  if (v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function logResponse(
  log: StoredTaskLog,
  runId: string,
  taskId: string,
  source: 'executed' | 'cache',
): Record<string, unknown> {
  // NOTE: unlike the serve path, no `artifactHash` download link is advertised
  // — the artifact store lives on the (P3) cache-wire side and isn't reachable
  // from the analytics layer; the log content itself is the payload.
  return {
    runId,
    taskId,
    source,
    status: log.status,
    content: log.content,
    charsFull: log.charsFull,
    truncatedHeadChars: log.truncatedHeadChars,
  }
}

export interface AnalyticsRouteCtx {
  analytics: Analytics
  orgId: string
  /** The resolved read workspace (a nil-uuid when the org has none yet). */
  workspaceId: string
  /** Set when the presenting token is workspace-scoped — the write clamp. */
  tokenWorkspaceId?: string | undefined
  tokenId?: string | undefined
  /** True when the principal is a ci token — writes require it. */
  isToken: boolean
}

/**
 * Dispatch one request against Postgres analytics. Returns a Response for a
 * matched route or null to fall through to the serve's machine surfaces.
 */
export async function handleAnalyticsRequest(
  ctx: AnalyticsRouteCtx,
  req: Request,
  url: URL,
): Promise<Response | null> {
  try {
    return await handleAnalyticsRequestInner(ctx, req, url)
  } catch (err) {
    // A malformed percent-encoding in a path segment (`/v1/tasks/%`) throws
    // URIError from decodeURIComponent — a client fault (400), not a 500.
    if (err instanceof URIError) return json({ ok: false, error: 'malformed request path' }, 400)
    if (err instanceof WorkspaceForbiddenError) return json({ ok: false, error: err.message }, 403)
    // A NUL byte is a WELL-FORMED escape (`%00`) that decodes to a valid JS
    // string, so it sails past the URIError guard above — and then Postgres
    // refuses it in `text` (SQLSTATE 22021, character_not_in_repertoire). Those
    // are the caller's bytes, not a server fault, and the WRITE routes in this
    // same file already answer 400 for exactly this input (`errResponse`); the
    // read side answering 500 was the file disagreeing with itself. Mapped at
    // the one choke point rather than per-param, because that covers query
    // params, path segments and any future param BY CONSTRUCTION — a list of
    // guarded params is the drift this router has already had three times.
    if (isUnrepresentableInput(err)) {
      return json({ ok: false, error: 'malformed request parameter' }, 400)
    }
    // Anything else uncaught on a read route is a genuine server fault; answer
    // a clean 500 (Bun would otherwise return a bare 500 with no body).
    return json({ ok: false, error: 'internal error' }, 500)
  }
}

async function handleAnalyticsRequestInner(
  ctx: AnalyticsRouteCtx,
  req: Request,
  url: URL,
): Promise<Response | null> {
  const p = url.pathname
  const a = ctx.analytics
  const ws = ctx.workspaceId
  const q = url.searchParams

  // ---- writes (ci token only) --------------------------------------------
  if (p === '/v1/ingest' && req.method === 'POST') {
    if (!ctx.isToken) return json({ ok: false, error: 'ci token required' }, 403)
    const raw = await readCapped(req, INGEST_BODY_MAX_BYTES)
    if (raw === null) return json({ ok: false, error: 'summary too large' }, 413)
    try {
      const summary = JSON.parse(raw) as RunSummaryRecord
      if (summary?.run?.runId === undefined) {
        return json({ ok: false, error: 'not a RunSummaryRecord' }, 400)
      }
      const res = await a.ingest({
        orgId: ctx.orgId,
        tokenWorkspaceId: ctx.tokenWorkspaceId,
        summary,
        tokenId: ctx.tokenId,
      })
      return json({ ok: true, stored: res.stored })
    } catch (err) {
      return errResponse(err)
    }
  }
  if (p === '/v1/ingest/logs' && req.method === 'POST') {
    if (!ctx.isToken) return json({ ok: false, error: 'ci token required' }, 403)
    const raw = await readCapped(req, LOG_BODY_MAX_BYTES)
    if (raw === null) return json({ ok: false, error: 'log bundle too large' }, 413)
    try {
      const bundle = JSON.parse(raw) as TaskLogBundle
      if (bundle?.v !== LOG_WIRE_VERSION) {
        const got = String((bundle as { v?: unknown } | null)?.v)
        return json(
          {
            ok: false,
            error: `log wire version mismatch: body v${got}, serve v${String(LOG_WIRE_VERSION)}`,
          },
          400,
        )
      }
      if (typeof bundle.workspaceId !== 'string' || !Array.isArray(bundle.tasks)) {
        return json({ ok: false, error: 'not a TaskLogBundle' }, 400)
      }
      const res = await a.ingestLogs({
        orgId: ctx.orgId,
        tokenWorkspaceId: ctx.tokenWorkspaceId,
        bundle,
      })
      return json({ ok: true, stored: res.stored })
    } catch (err) {
      return errResponse(err)
    }
  }
  if (p === '/v1/ingest/task' && req.method === 'POST') {
    if (!ctx.isToken) return json({ ok: false, error: 'ci token required' }, 403)
    const raw = await readCapped(req, TASK_BODY_MAX_BYTES)
    if (raw === null) return json({ ok: false, error: 'task record too large' }, 413)
    try {
      const record = JSON.parse(raw) as TaskIngestRecord
      if (record?.v !== TASK_WIRE_VERSION) {
        const got = typeof record?.v === 'number' ? record.v : 'none'
        return json(
          {
            ok: false,
            error: `task wire version mismatch: body v${String(got)}, serve v${String(TASK_WIRE_VERSION)}`,
          },
          400,
        )
      }
      if (
        typeof record.runId !== 'string' ||
        typeof record.workspaceId !== 'string' ||
        typeof record.runStartedAt !== 'number' ||
        record.task?.taskId === undefined ||
        typeof record.task.project !== 'string' ||
        typeof record.task.task !== 'string'
      ) {
        return json({ ok: false, error: 'not a TaskIngestRecord' }, 400)
      }
      const res = await a.ingestTask({
        orgId: ctx.orgId,
        tokenWorkspaceId: ctx.tokenWorkspaceId,
        record,
      })
      return json({ ok: true, stored: res.stored })
    } catch (err) {
      return errResponse(err)
    }
  }
  if (p === '/v1/catalog' && req.method === 'POST') {
    if (!ctx.isToken) return json({ ok: false, error: 'ci token required' }, 403)
    const raw = await readCapped(req, CATALOG_BODY_MAX_BYTES)
    if (raw === null) return json({ ok: false, error: 'catalog too large' }, 413)
    try {
      const push = JSON.parse(raw) as CatalogPush
      if (push?.v !== 1 || typeof push.workspaceId !== 'string' || !Array.isArray(push.projects)) {
        return json({ ok: false, error: 'not a catalog push' }, 400)
      }
      const res = await a.ingestCatalog({
        orgId: ctx.orgId,
        tokenWorkspaceId: ctx.tokenWorkspaceId,
        push,
      })
      return json({ ok: true, workspaceId: res.workspaceId })
    } catch (err) {
      return errResponse(err)
    }
  }

  // ---- reads (session viewer+ or ci token; workspace-clamped) -------------
  if (p === '/v1/workspaces') {
    const all = await a.workspacesForOrg(ctx.orgId)
    // A workspace-scoped token is PINNED to one workspace — every other read
    // route honours that pin, so enumerating its siblings' ids/names/slugs and
    // run counts here was a widening nobody chose. Intra-org, so never a
    // tenant-boundary break; a session and an org-wide token still see all,
    // which is what the dashboard's workspace switcher needs.
    const pin = ctx.tokenWorkspaceId
    return json({ workspaces: pin === undefined ? all : all.filter((w) => w.id === pin) })
  }
  if (p === '/v1/hermeticity') {
    // `clampInt`, like every sibling: the hand-rolled clamp this replaces
    // ROUNDED a fractional limit (2.7 -> 3) where clampInt floors (-> 2), and
    // read '' / 0 / -1 as "use the default 50" where clampInt reads them as 1.
    // Same input, two answers, in one file.
    return json(await a.hermeticity(ws, clampInt(numParam(q.get('limit')) ?? 50, 1, 500)))
  }
  if (p === '/v1/runs') {
    const args: ListRunsArgs = {}
    const limit = numParam(q.get('limit'))
    // `listRuns` clamps at 100_000 because `getRun` REUSES it to fetch a whole
    // run's tasks (the 2026-07-13 truncation fix). That ceiling is an internal
    // requirement of getRun, not something a caller of "a page of run rows"
    // should be able to ask for — unbounded, a single viewer materialises ~26
    // MB server-side (measured). Capped for the ROUTE only, well above the
    // largest request any shipped client makes (2000, the Runs project facet);
    // getRun's internal call goes through the method and is untouched.
    if (limit !== undefined) args.limit = clampInt(limit, 1, ROUTE_RUNS_MAX)
    const project = textParam(q.get('project'))
    if (project !== undefined) args.project = project
    const task = textParam(q.get('task'))
    if (task !== undefined) args.task = task
    const runId = textParam(q.get('runId'))
    if (runId !== undefined) args.runId = runId
    const hash = textParam(q.get('hash'))
    if (hash !== undefined) args.hash = hash
    return json({ runs: await a.listRuns(ws, args) })
  }
  if (p === '/v1/invocations') {
    const args: ListInvocationsArgs = {}
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    const branch = textParam(q.get('branch'))
    if (branch !== undefined) args.branch = branch
    const ci = q.get('ci')
    if (ci !== null) args.ci = ci === '1' || ci === 'true'
    const tagKey = textParam(q.get('tagKey'))
    if (tagKey !== undefined) args.tagKey = tagKey
    const tagValue = textParam(q.get('tagValue'))
    if (tagValue !== undefined) args.tagValue = tagValue
    return json({ invocations: await a.listInvocations(ws, args) })
  }
  {
    const m = /^\/v1\/invocations\/([^/]+)$/.exec(p)
    if (m) {
      const detail = await a.getInvocation(ws, decodeURIComponent(m[1]!))
      return detail === null ? json({ error: 'not found' }, 404) : json(detail)
    }
  }
  {
    const m = /^\/v1\/runs\/([^/]+)\/logs\/(.+)$/.exec(p)
    if (m) return this_logs(ctx, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!))
  }
  {
    const m = /^\/v1\/runs\/([^/]+)$/.exec(p)
    if (m) {
      const detail = await a.getRun(ws, decodeURIComponent(m[1]!))
      return detail === null ? json({ error: 'not found' }, 404) : json(detail)
    }
  }
  {
    const m = /^\/v1\/compare\/([^/]+)$/.exec(p)
    if (m) return json(await a.compareRuns(ws, decodeURIComponent(m[1]!)))
  }
  if (p === '/v1/cache/stats')
    return json(await a.getCacheStatsSql(ws, numParam(q.get('windowDays')) ?? 1))
  if (p === '/v1/cache/hit-split') return json(await a.getHitRateSplit(ws))
  if (p === '/v1/cache/breakdown') {
    return json({ projects: await a.getCacheBreakdown(ws, numParam(q.get('limit')) ?? 20) })
  }
  if (p === '/v1/cache/savings') return json(await a.getCacheSavings(ws))
  if (p === '/v1/cache/entries') return json({ entries: await a.listCacheEntries(ws) })
  if (p === '/v1/cache/prunable') {
    return json({
      minAgeDays: numParam(q.get('minAgeDays')) ?? 7,
      entries: await a.getPrunableEntries(ws),
    })
  }
  if (p === '/v1/top-tasks') {
    return json({ tasks: await a.getTopTimeBurners(ws, numParam(q.get('limit')) ?? 10) })
  }
  if (p === '/v1/failures') {
    return json({ failures: await a.getRecentFailures(ws, numParam(q.get('limit')) ?? 25) })
  }
  if (p === '/v1/notifications') {
    return json({ notifications: await a.getNotifications(ws, numParam(q.get('limit')) ?? 20) })
  }
  if (p === '/v1/projects') {
    // `total` is the TRUE project count, not the page length — a 1000-project
    // workspace must never be described by the size of one page.
    const args: { limit?: number; search?: string; projects?: string[] } = {}
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    const search = textParam(q.get('search'))
    if (search !== undefined) args.search = search
    const project = q.getAll('project').filter((x) => x !== '')
    if (project.length > 0) args.projects = project
    const [projects, total] = await Promise.all([a.listProjects(ws, args), a.countProjects(ws)])
    return json({ projects, total })
  }
  if (p === '/v1/projects/rank') {
    const project = textParam(q.get('project'))
    if (project === undefined) return json({ ok: false, error: 'project required' }, 400)
    return json(await a.rankProject(ws, project, numParam(q.get('top')) ?? 8))
  }
  if (p === '/v1/trends/runs') {
    const bucketRaw = q.get('bucket')
    const bucket = bucketRaw === 'day' || bucketRaw === 'hour' ? bucketRaw : 'hour'
    const args: { bucket: 'hour' | 'day'; from?: number; to?: number; project?: string } = {
      bucket,
    }
    const from = numParam(q.get('from'))
    if (from !== undefined) args.from = from
    const to = numParam(q.get('to'))
    if (to !== undefined) args.to = to
    const project = textParam(q.get('project'))
    if (project !== undefined) args.project = project
    return json({ bucket, points: await a.getRunTrends(ws, args) })
  }
  if (p === '/v1/trends/tasks') {
    const project = textParam(q.get('project'))
    if (project === undefined) return json({ ok: false, error: 'project required' }, 400)
    const bucketRaw = q.get('bucket')
    const bucket = bucketRaw === 'hour' || bucketRaw === 'day' ? bucketRaw : 'day'
    const args: { bucket: 'hour' | 'day'; from?: number; to?: number; limit?: number } = { bucket }
    const from = numParam(q.get('from'))
    if (from !== undefined) args.from = from
    const to = numParam(q.get('to'))
    if (to !== undefined) args.to = to
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    return json({ bucket, points: await a.getProjectTaskTrends(ws, project, args) })
  }
  if (p === '/v1/trends/heatmap') {
    const days = numParam(q.get('days')) ?? 30
    return json({ days, cells: await a.getRunHeatmap(ws, days) })
  }
  if (p === '/v1/trends/storage') {
    const days = numParam(q.get('days')) ?? 30
    return json({ days, points: await a.getStorageGrowth(ws, days) })
  }
  if (p === '/v1/trends/parallelism') {
    return json({ points: await a.getParallelismHistory(ws, numParam(q.get('limit')) ?? 50) })
  }
  if (p === '/v1/flakiness') {
    // `project`+`task` narrows to a point lookup — the task-detail badge must
    // not depend on the task ranking inside a top-N page.
    const args: { limit?: number; project?: string; task?: string } = {}
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    const project = textParam(q.get('project'))
    const task = textParam(q.get('task'))
    if (project !== undefined && task !== undefined) {
      args.project = project
      args.task = task
    }
    return json(await a.getFlakiestTasks(ws, args))
  }
  if (p === '/v1/regressions') {
    const args: { sinceDays?: number; minBranches?: number; limit?: number } = {}
    const sinceDays = numParam(q.get('sinceDays'))
    if (sinceDays !== undefined) args.sinceDays = sinceDays
    const minBranches = numParam(q.get('minBranches'))
    if (minBranches !== undefined) args.minBranches = minBranches
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    return json({ tasks: await a.getRegressions(ws, args) })
  }
  if (p === '/v1/branch-failures') {
    const project = textParam(q.get('project'))
    if (project === undefined) return json({ ok: false, error: 'project required' }, 400)
    const args: { sinceDays?: number; limit?: number } = {}
    const sinceDays = numParam(q.get('sinceDays'))
    if (sinceDays !== undefined) args.sinceDays = sinceDays
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    return json({ tasks: await a.getProjectBranchFailures(ws, project, args) })
  }
  if (p === '/v1/stability/least') {
    const args: { sinceDays?: number; limit?: number; minRuns?: number } = {}
    const sinceDays = numParam(q.get('sinceDays'))
    if (sinceDays !== undefined) args.sinceDays = sinceDays
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    const minRuns = numParam(q.get('minRuns'))
    if (minRuns !== undefined) args.minRuns = minRuns
    return json({ tasks: await a.getLeastStableTasks(ws, args) })
  }
  if (p === '/v1/stability') {
    const project = textParam(q.get('project'))
    const task = textParam(q.get('task'))
    if (project === undefined || task === undefined) {
      return json({ ok: false, error: 'project and task required' }, 400)
    }
    const args: { sinceDays?: number; limit?: number } = {}
    const sinceDays = numParam(q.get('sinceDays'))
    if (sinceDays !== undefined) args.sinceDays = sinceDays
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    return json(await a.getTaskStability(ws, project, task, args))
  }
  if (p === '/v1/flake-trend') {
    const project = textParam(q.get('project'))
    const task = textParam(q.get('task'))
    if (project === undefined || task === undefined) {
      return json({ ok: false, error: 'project and task required' }, 400)
    }
    const args: { sinceDays?: number } = {}
    const sinceDays = numParam(q.get('sinceDays'))
    if (sinceDays !== undefined) args.sinceDays = sinceDays
    return json(await a.getFlakeTrend(ws, project, task, args))
  }
  if (p === '/v1/analysis') {
    const args: {
      windowDays?: number
      minRuns?: number
      limit?: number
      project?: string
      task?: string
    } = {}
    const window = numParam(q.get('window'))
    if (window !== undefined) args.windowDays = window
    const minRuns = numParam(q.get('minRuns'))
    if (minRuns !== undefined) args.minRuns = minRuns
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    const project = textParam(q.get('project'))
    if (project !== undefined) args.project = project
    const task = textParam(q.get('task'))
    if (task !== undefined) args.task = task
    return json(await a.getPeriodComparison(ws, args))
  }
  if (p === '/v1/bottlenecks') {
    return json({
      lookbackDays: numParam(q.get('days')) ?? 14,
      bottlenecks: await a.getBottlenecks(
        ws,
        numParam(q.get('days')) ?? 14,
        numParam(q.get('limit')) ?? 15,
      ),
    })
  }
  if (p === '/v1/history') {
    const args: { project?: string; task?: string; search?: string; limit?: number } = {}
    const limit = numParam(q.get('limit'))
    if (limit !== undefined) args.limit = limit
    const project = textParam(q.get('project'))
    if (project !== undefined) args.project = project
    const task = textParam(q.get('task'))
    if (task !== undefined) args.task = task
    const search = textParam(q.get('search'))
    if (search !== undefined) args.search = search
    return json({ history: await a.getHistory(ws, args) })
  }
  {
    const m = /^\/v1\/tasks\/(.+)$/.exec(p)
    if (m) {
      const detail = await a.getTaskDetail(ws, decodeURIComponent(m[1]!))
      return detail === null ? json({ error: 'not found' }, 404) : json(detail)
    }
  }
  {
    const m = /^\/v1\/explain\/(.+)$/.exec(p)
    if (m) return json(await a.explainCacheKey(ws, decodeURIComponent(m[1]!)))
  }
  {
    // Batched: every executed task's re-run verdict in one round-trip. Must be
    // tried BEFORE the per-task `/v1/why/:runId/:taskId` (single segment only).
    const m = /^\/v1\/why\/([^/]+)$/.exec(p)
    if (m) return json({ rows: await a.whyRunReran(ws, decodeURIComponent(m[1]!)) })
  }
  {
    // Batched failure triage: every failed task's "is this failure mine?"
    // verdict (flaky / pre-existing / new-failure) in one round-trip.
    const m = /^\/v1\/triage\/([^/]+)$/.exec(p)
    if (m) return json({ rows: await a.triageRun(ws, decodeURIComponent(m[1]!)) })
  }
  {
    const m = /^\/v1\/why\/([^/]+)\/(.+)$/.exec(p)
    if (m)
      return json(await a.whyDidThisRerun(ws, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)))
  }
  {
    const m = /^\/v1\/diff\/([^/]+)\/(.+)$/.exec(p)
    if (m)
      return json(await a.cacheKeyDiff(ws, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)))
  }

  return null
}

/** `/v1/runs/:id/logs/:taskId` — direct row, else cache-hit-by-hash, else 404. */
async function this_logs(ctx: AnalyticsRouteCtx, runId: string, taskId: string): Promise<Response> {
  const a = ctx.analytics
  const ws = ctx.workspaceId
  const direct = await a.logFor(ws, runId, taskId)
  if (direct !== undefined) return json(logResponse(direct, runId, taskId, 'executed'))
  const run = await a.getRun(ws, runId)
  const row = run?.tasks.find((t) => `${t.project}#${t.task}` === taskId)
  if (row?.hash && (row.cacheHit === true || isCacheHit(row.status))) {
    const producer = await a.logByHash(ws, row.hash)
    if (producer !== undefined) {
      return json({ ...logResponse(producer, runId, taskId, 'cache'), refRunId: producer.runId })
    }
  }
  return json({ error: 'no logs captured for this task' }, 404)
}
