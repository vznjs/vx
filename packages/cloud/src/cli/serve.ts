// `vx-cloud serve` — the foreground execution service. Clients (`vx run`)
// connect over WebSocket, submit a RunRequest, and the service executes it
// in-process via the same `run()` the CLI uses, streaming WireEvents back
// and returning a RunResult. The transport is Bun-native (Bun.serve + ws),
// so the exact same protocol serves a local socket today or a hosted
// `wss://` link later. Foreground only: Ctrl-C stops it.

import os from 'node:os'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import {
  cacheKeyDiff,
  compareRuns,
  run as runOrchestrator,
  planRun,
  createEventBus,
  wireForwarder,
  requestToOptions,
  projectOutcome,
  encodeForNDJSON,
  encodeForSSE,
  envelopeToClientMessage,
  explainCacheKeyQuery,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStatsSql,
  getFlakiestTasks,
  getHistory,
  getHitRateSplit,
  getInvocation,
  getParallelismHistory,
  getPrunableEntries,
  getRecentFailures,
  getRun,
  getRunHeatmap,
  getRunTrends,
  getStorageGrowth,
  getTaskDetail,
  getTopTimeBurners,
  isEnvelope,
  listCacheEntries,
  listInvocations,
  listProjects,
  listRuns,
  serverMessageToEnvelope,
  whyDidThisRerunQuery,
  WIRE_CHANNELS,
  WIRE_PROTOCOL_VERSION,
  VERSION,
  findWorkspaceRoot,
  type ClientMessage,
  type Envelope,
  type Logger,
  type RunRequest,
  type RunSummaryRecord,
  type ServerMessage,
  type TelemetrySink,
} from '@vzn/vx'
import { ArtifactStore, MAX_ARTIFACT_BYTES } from '../artifact-store.js'
import { IngestStore } from '../ingest-store.js'
import { defaultServeSocketPath, serveInfoPath } from '../serve-info.js'
import { handleMcpHttp } from './mcp-serve.js'

/**
 * Default port for `vx-cloud serve`, used when neither `--port` nor the
 * `VX_CLOUD_PORT` env var is set. A STABLE default (matching the dashboard
 * SPA's own default origin) so the URL is the same across restarts. The port
 * is now DETERMINISTIC — we no longer silently fall back to a random ephemeral
 * port when it's taken (that's exactly what made the URL move); a busy port
 * surfaces a clear error telling the user to free it or set `VX_CLOUD_PORT`.
 */
export const DEFAULT_SERVE_PORT = 4321

/** Env var overriding the serve port (below an explicit `--port`). */
export const SERVE_PORT_ENV = 'VX_CLOUD_PORT'

/** Env var enabling (and naming) the unix-socket listener (below `--socket`). */
export const SERVE_SOCKET_ENV = 'VX_CLOUD_SOCKET'

/**
 * Resolve the serve port for the CLI: an explicit `--port` wins, then
 * `VX_CLOUD_PORT`, then the stable default. Returns an error string for a
 * malformed env value (a bad `--port` is already caught in parseServeArgs).
 */
export function resolveServePort(
  flagPort: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { port: number } | { error: string } {
  if (flagPort !== undefined) return { port: flagPort }
  const raw = env[SERVE_PORT_ENV]
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      return { error: `invalid ${SERVE_PORT_ENV}: ${raw}` }
    }
    return { port: n }
  }
  return { port: DEFAULT_SERVE_PORT }
}

// The service renders nothing to its own terminal for delegated runs — the
// CLIENT renders the streamed events. A no-op Logger keeps `run()` quiet.
const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

/** Execute one delegated request, streaming events + a final result. */
async function executeRequest(
  send: (message: ServerMessage) => void,
  request: RunRequest,
  inflight: Map<string, Promise<void>>,
  telemetrySinks: readonly TelemetrySink[],
): Promise<boolean> {
  const bus = createEventBus()
  bus.subscribe(wireForwarder((event) => send({ t: 'event', event })))
  try {
    const summary = await runOrchestrator({
      ...requestToOptions(request),
      bus,
      log: silentLogger,
      // The shared registry that lets concurrent delegated runs dedup
      // in-flight work — the service's reason to exist.
      inflight,
      // The service owns signal disposition for its whole lifetime; a
      // delegated run must never exit the process out from under it.
      handleSignals: false,
      telemetrySinks,
    })
    send({
      t: 'result',
      result: { ok: summary.ok, outcomes: summary.outcomes.map(projectOutcome) },
    })
    return summary.ok
  } catch (err) {
    send({ t: 'error', message: err instanceof Error ? err.message : String(err) })
    return false
  }
}

export interface ServeServer {
  origin: string
  /** The server's runtime identity (the `/v1/meta` name). */
  name: string
  /** The unix-socket path when the serve also listens on one. */
  socketPath?: string
  stop: () => Promise<void>
}

// CORS is wide-open: a hosted dashboard needs to reach localhost from a
// foreign origin, and the surface is read-only metrics + an authenticated WS
// run submission. Any tighter policy would break the "host the SPA once,
// point it at any vx serve" UX.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Authorization so the SPA on a foreign origin can send the bearer token.
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
  return res
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return withCors(Response.json(body, init))
}

export async function startServe(opts: {
  root: string
  port?: number
  /**
   * Path to the single-file dashboard HTML (the embedded `packages/cloud/ui` build).
   * When set, every non-API GET serves it — the SPA is one self-contained
   * file with a hash router, so all routes return the same bytes.
   */
  uiHtmlPath?: string
  /**
   * Directory for the cloud-owned SQLite ingest store (the dashboard's sole
   * data source). Defaults to `<root>/.vx/cloud-ingest`; point it at a
   * persistent volume for a hosted deployment.
   */
  ingestDir?: string
  /**
   * Shared bearer token. When set, every request except `/health` and
   * `/v1/meta` requires `Authorization: Bearer <token>` (401 otherwise); the
   * WS upgrade and the stream endpoints also accept `?token=` since browser
   * transports can't set headers. No token → fully open (localhost default).
   */
  token?: string
  /** Server identity reported by `/v1/meta`. Defaults to the hostname. */
  name?: string
  /**
   * Also listen on this unix socket (docker-parity local transport,
   * dev-flows design §10.2). The SAME fetch handler serves both listeners,
   * but socket-served requests bypass the token gate: the socket is chmod
   * 0600 after bind, so the OS file permissions ARE the auth. A stale
   * socket left by a crashed serve is unlinked before binding.
   */
  socketPath?: string
  onRun?: (request: RunRequest, ok: boolean) => void
}): Promise<ServeServer> {
  // One registry for the service's whole lifetime — concurrent runs share
  // it to dedup in-flight task execution.
  const inflight = new Map<string, Promise<void>>()

  const startedAt = Date.now()
  const serveName = opts.name ?? os.hostname()
  // Constant-time compare: hash both sides to a fixed length, then
  // timingSafeEqual — no length leak, no early exit.
  const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest()
  const expectedDigest = opts.token !== undefined ? sha256(opts.token) : undefined
  const tokenMatches = (candidate: string): boolean =>
    expectedDigest !== undefined && timingSafeEqual(sha256(candidate), expectedDigest)

  // The single auth gate. Exempt: /health (probes/k8s) and /v1/meta (the
  // identity handshake `connect` needs BEFORE the user has proven a token —
  // it carries no secrets and no workspace path). The UI catch-all also stays
  // open: the SPA is static code and must load to show its token prompt; every
  // data surface it calls is gated below. Requests arriving over the unix
  // socket bypass the token entirely: the socket is chmod 0600, so the OS
  // file permissions ARE the auth (only this user can even open it).
  function authorized(req: Request, url: URL, viaSocket: boolean): boolean {
    if (viaSocket) return true
    if (expectedDigest === undefined) return true
    if (url.pathname === '/health' || url.pathname === '/v1/meta') return true
    const isUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    const gated =
      isUpgrade ||
      url.pathname === '/version' ||
      url.pathname === '/events' ||
      url.pathname === '/stream' ||
      url.pathname === '/mcp' ||
      url.pathname.startsWith('/v1/') ||
      url.pathname.startsWith('/v8/')
    if (!gated) return true
    const header = req.headers.get('authorization')
    if (header !== null && header.startsWith('Bearer ') && tokenMatches(header.slice(7))) {
      return true
    }
    // Browser EventSource/WebSocket can't set headers, so ?token= is an
    // equivalent for the stream endpoints + the WS upgrade ONLY (the header
    // form stays canonical everywhere else).
    if (
      isUpgrade ||
      url.pathname === '/events' ||
      url.pathname === '/v1/events' ||
      url.pathname === '/stream'
    ) {
      const qt = url.searchParams.get('token')
      if (qt !== null && tokenMatches(qt)) return true
    }
    return false
  }

  // vx-cloud is INDEPENDENT of vx core: it NEVER opens a workspace cache.db.
  // The dashboard's /v1/* analytics read ONLY this service's own SQLite store,
  // fed by the cloud() plugin's telemetry push (POST /v1/ingest). So vx-cloud
  // can be deployed anywhere — it has no access to, and no need for, the
  // machine(s) that produced the runs. One Bun process: SQLite store + the
  // ingest endpoint + the /v1/* API + the embedded UI.
  const ingestDir = opts.ingestDir ?? path.join(opts.root, '.vx', 'cloud-ingest')
  const ingest = new IngestStore(ingestDir, (m) => process.stderr.write(`[vx-cloud] ${m}\n`))

  // The serve-hosted artifact store (Turbo /v8/artifacts wire) — point
  // core's VX_REMOTE_CACHE_URL (or a connected environment) at this serve
  // and the remote cache works with no separate cache server.
  const artifacts = new ArtifactStore(path.join(ingestDir, 'artifacts'))

  // Delegated runs land in the serve's OWN history — before this sink they
  // never did (the plugin's pid-guard rightly declines the HTTP self-push,
  // and nothing replaced it). An observe-only option sink records the
  // summary the executed run itself captured; workspace routing rides the
  // summary's own identity. emitSummary is crash-isolated in core, so an
  // ingest failure can never fail a delegated run.
  const selfIngestSink: TelemetrySink = {
    name: 'vx-cloud/self-ingest',
    onRunSummary: (summary) => void ingest.ingest(summary),
  }

  // Read-only event subscribers (SSE / NDJSON). Each callback gets every
  // event from every concurrent run as a notification envelope so a `curl`
  // user sees activity across the service.
  type ReadSubscriber = (env: Envelope) => void
  const readSubscribers = new Set<ReadSubscriber>()
  const broadcast = (msg: ServerMessage): void => {
    if (readSubscribers.size === 0) return
    const env = serverMessageToEnvelope(msg)
    for (const fn of readSubscribers) {
      try {
        fn(env)
      } catch {
        // a wedged subscriber can't break the run; drop silently
      }
    }
  }

  // ONE fetch handler shared by both listeners (TCP + optional unix socket);
  // the closure flag marks socket-served requests so `authorized` can skip
  // the token gate for them.
  const makeFetch =
    (viaSocket: boolean) =>
    (
      req: Request,
      srv: { upgrade(req: Request): boolean },
    ): Response | Promise<Response> | undefined => {
      const url = new URL(req.url)
      // Browser preflight — answer everything with CORS-permissive headers.
      if (req.method === 'OPTIONS') {
        return withCors(new Response(null, { status: 204 }))
      }
      // Liveness probe — `vx run` health-checks this before delegating.
      if (url.pathname === '/health') return withCors(new Response('ok'))
      // Server identity — pre-auth by design (the `connect` handshake reads
      // it before the user has proven a token). No secrets, no workspace
      // path (/version keeps that, behind the token).
      if (url.pathname === '/v1/meta') {
        return jsonResponse({
          v: 1,
          name: serveName,
          vx: VERSION,
          auth: expectedDigest !== undefined ? 'token' : 'open',
          startedAt,
          // Count only — a pre-auth endpoint must not leak workspace names.
          workspaces: ingest.workspaceCount(),
          // Capability advertisement: this serve hosts /v8/artifacts, so a
          // connected environment can auto-wire the remote-cache rung.
          artifacts: true,
        })
      }
      if (!authorized(req, url, viaSocket)) {
        return jsonResponse(
          { error: 'unauthorized' },
          { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
        )
      }
      // MCP — the AI-agent control plane (dev-flows design §10.3): JSON-RPC
      // 2.0 over streamable HTTP, tools adapting the same metrics queries
      // the /v1/* routes serve. Bearer-gated above like every /v1 read.
      if (url.pathname === '/mcp') {
        return handleMcpHttp(req, ingest).then(withCors)
      }
      // The artifact store (Turbo wire; ?teamId/slug accepted by ignoring).
      {
        const m = /^\/v8\/artifacts\/([^/]+)$/.exec(url.pathname)
        if (m) return artifacts.handle(req, decodeURIComponent(m[1]!)).then(withCors)
      }
      // Workspace scoping for the analytics routes (`?ws=<id>`, dev-flows
      // design §3.5) — resolved ONCE here. No param → the sole known
      // workspace when exactly one exists, else `default`, so a
      // single-workspace serve behaves exactly like the pre-multi-workspace
      // one and every existing client/bookmark keeps working.
      const wsParam = url.searchParams.get('ws')
      const readDb = () => ingest.db(wsParam ?? ingest.defaultWorkspaceId())!
      // Capability handshake — what protocol version + channels + RPCs.
      if (url.pathname === '/version') {
        return jsonResponse({
          protocol: WIRE_PROTOCOL_VERSION,
          vx: VERSION,
          channels: WIRE_CHANNELS,
          rpc: [
            'getCacheStats',
            'getRunHistory',
            'explainCacheKey',
            'whyDidThisRerun',
            'cacheKeyDiff',
            'compareRuns',
            'getInvocation',
            'getHitRateSplit',
          ],
          workspace: opts.root,
        })
      }
      // Ingest — the push endpoint. A cloud telemetry sink POSTs a
      // canonical RunSummaryRecord; we persist it into the cloud-owned
      // store the hosted dashboard reads from. Idempotent on runId.
      if (url.pathname === '/v1/ingest' && req.method === 'POST') {
        return (async () => {
          try {
            const summary = (await req.json()) as RunSummaryRecord
            if (summary?.run?.runId === undefined) {
              return jsonResponse({ ok: false, error: 'not a RunSummaryRecord' }, { status: 400 })
            }
            const stored = ingest.ingest(summary)
            return jsonResponse({ ok: true, stored })
          } catch (err) {
            return jsonResponse(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              { status: 400 },
            )
          }
        })()
      }
      // The workspace list (id, name, lastSeenAt, runCount) — feeds the UI
      // switcher. Behind the token gate like every /v1 read.
      if (url.pathname === '/v1/workspaces') {
        return jsonResponse({ workspaces: ingest.workspaces() })
      }
      // An explicitly-requested unknown workspace 404s before any route
      // logic runs; a known one is lazily opened by the same probe.
      if (wsParam !== null && url.pathname.startsWith('/v1/') && ingest.db(wsParam) === undefined) {
        return jsonResponse({ error: `unknown workspace: ${wsParam}` }, { status: 404 })
      }
      // -----------------------------------------------------------------
      // Metrics HTTP surface — JSON read APIs over the workspace-resolved
      // ingest store. The dashboard SPA (packages/cloud/ui) calls these
      // directly.
      // -----------------------------------------------------------------
      if (url.pathname === '/v1/runs') {
        const params = url.searchParams
        const args: Parameters<typeof listRuns>[1] = {}
        const limitRaw = params.get('limit')
        if (limitRaw !== null) args.limit = Number(limitRaw)
        const project = params.get('project')
        if (project !== null) args.project = project
        const task = params.get('task')
        if (task !== null) args.task = task
        const runId = params.get('runId')
        if (runId !== null) args.runId = runId
        return jsonResponse({ runs: listRuns(readDb(), args) })
      }
      if (url.pathname === '/v1/invocations') {
        const params = url.searchParams
        const args: {
          limit?: number
          branch?: string
          ci?: boolean
          tagKey?: string
          tagValue?: string
        } = {}
        const limitRaw = params.get('limit')
        if (limitRaw !== null) args.limit = Number(limitRaw)
        const branch = params.get('branch')
        if (branch !== null) args.branch = branch
        const ci = params.get('ci')
        if (ci !== null) args.ci = ci === '1' || ci === 'true'
        const tagKey = params.get('tagKey')
        if (tagKey !== null) args.tagKey = tagKey
        const tagValue = params.get('tagValue')
        if (tagValue !== null) args.tagValue = tagValue
        return jsonResponse({ invocations: listInvocations(readDb(), args) })
      }
      {
        const m = /^\/v1\/invocations\/([^/]+)$/.exec(url.pathname)
        if (m) {
          const detail = getInvocation(readDb(), decodeURIComponent(m[1]!))
          if (!detail) return jsonResponse({ error: 'not found' }, { status: 404 })
          return jsonResponse(detail)
        }
      }
      // The task DAG for a set of requested tasks: nodes + dependency edges +
      // predicted cache status, via a no-exec planRun. The run cockpit lays
      // this out and overlays live status from the WS run stream.
      if (url.pathname === '/v1/graph') {
        // The DAG is computed from a colocated workspace (a no-exec planRun)
        // — the live-cockpit feature. A remote dashboard has no workspace, so
        // planRun throws and the catch below returns a clean error.
        const tasks = (url.searchParams.get('tasks') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        if (tasks.length === 0)
          return jsonResponse({ error: 'tasks query param required' }, { status: 400 })
        return (async () => {
          try {
            const plan = await planRun({ cwd: opts.root, tasks, log: silentLogger })
            return jsonResponse({
              nodes: plan.tasks.map((t) => ({
                id: t.node.id,
                project: t.node.projectName,
                task: t.node.taskName,
                isGroup: t.node.config.exec === undefined,
                deps: t.deps,
                cacheStatus: t.cacheStatus,
              })),
            })
          } catch (err) {
            return jsonResponse(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400 },
            )
          }
        })()
      }
      {
        const m = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname)
        if (m) {
          const detail = getRun(readDb(), decodeURIComponent(m[1]!))
          if (!detail) return jsonResponse({ error: 'not found' }, { status: 404 })
          return jsonResponse(detail)
        }
      }
      // Diff a run against the immediately-previous invocation — the "why is
      // this run different" surface. Always 200 (a missing/no-previous run is
      // a clear shape in the body, not an HTTP error).
      {
        const m = /^\/v1\/compare\/([^/]+)$/.exec(url.pathname)
        if (m) {
          return jsonResponse(compareRuns(readDb(), decodeURIComponent(m[1]!)))
        }
      }
      if (url.pathname === '/v1/cache/stats') {
        return jsonResponse(getCacheStatsSql(readDb()))
      }
      if (url.pathname === '/v1/cache/hit-split') {
        return jsonResponse(getHitRateSplit(readDb()))
      }
      if (url.pathname === '/v1/cache/breakdown') {
        const limit = Number(url.searchParams.get('limit') ?? '20')
        return jsonResponse({ projects: getCacheBreakdown(readDb(), limit) })
      }
      if (url.pathname === '/v1/cache/savings') {
        return jsonResponse(getCacheSavings(readDb()))
      }
      if (url.pathname === '/v1/cache/entries') {
        const params = url.searchParams
        const args: Parameters<typeof listCacheEntries>[1] = {}
        const limitRaw = params.get('limit')
        if (limitRaw !== null) args.limit = Number(limitRaw)
        const orderBy = params.get('orderBy')
        if (
          orderBy === 'created_at' ||
          orderBy === 'accessed_at' ||
          orderBy === 'size_bytes' ||
          orderBy === 'duration_ms'
        ) {
          args.orderBy = orderBy
        }
        const project = params.get('project')
        if (project !== null) args.project = project
        return jsonResponse({ entries: listCacheEntries(readDb(), args) })
      }
      if (url.pathname === '/v1/top-tasks') {
        const limit = Number(url.searchParams.get('limit') ?? '10')
        return jsonResponse({ tasks: getTopTimeBurners(readDb(), limit) })
      }
      if (url.pathname === '/v1/failures') {
        const limit = Number(url.searchParams.get('limit') ?? '25')
        return jsonResponse({ failures: getRecentFailures(readDb(), limit) })
      }
      if (url.pathname === '/v1/projects') {
        const limit = Number(url.searchParams.get('limit') ?? '100')
        return jsonResponse({ projects: listProjects(readDb(), limit) })
      }
      if (url.pathname === '/v1/trends/runs') {
        const params = url.searchParams
        const bucketRaw = params.get('bucket')
        const bucket = bucketRaw === 'day' || bucketRaw === 'hour' ? bucketRaw : 'hour'
        const args: Parameters<typeof getRunTrends>[1] = { bucket }
        const fromRaw = params.get('from')
        if (fromRaw !== null) args.from = Number(fromRaw)
        const toRaw = params.get('to')
        if (toRaw !== null) args.to = Number(toRaw)
        return jsonResponse({ bucket, points: getRunTrends(readDb(), args) })
      }
      if (url.pathname === '/v1/trends/heatmap') {
        const days = Number(url.searchParams.get('days') ?? '30')
        return jsonResponse({ days, cells: getRunHeatmap(readDb(), days) })
      }
      if (url.pathname === '/v1/trends/storage') {
        const days = Number(url.searchParams.get('days') ?? '30')
        return jsonResponse({ days, points: getStorageGrowth(readDb(), days) })
      }
      if (url.pathname === '/v1/trends/parallelism') {
        const limit = Number(url.searchParams.get('limit') ?? '50')
        return jsonResponse({ points: getParallelismHistory(readDb(), limit) })
      }
      if (url.pathname === '/v1/flakiness') {
        const limit = Number(url.searchParams.get('limit') ?? '25')
        return jsonResponse({ tasks: getFlakiestTasks(readDb(), limit) })
      }
      if (url.pathname === '/v1/bottlenecks') {
        const lookbackDays = Number(url.searchParams.get('days') ?? '14')
        const limit = Number(url.searchParams.get('limit') ?? '15')
        return jsonResponse({
          lookbackDays,
          bottlenecks: getBottlenecks(readDb(), lookbackDays, limit),
        })
      }
      if (url.pathname === '/v1/cache/prunable') {
        const minAgeDays = Number(url.searchParams.get('minAgeDays') ?? '7')
        const limit = Number(url.searchParams.get('limit') ?? '50')
        return jsonResponse({
          minAgeDays,
          entries: getPrunableEntries(readDb(), minAgeDays, limit),
        })
      }
      if (url.pathname === '/v1/history') {
        const params = url.searchParams
        const args: Parameters<typeof getHistory>[1] = {}
        const limitRaw = params.get('limit')
        if (limitRaw !== null) args.limit = Number(limitRaw)
        const project = params.get('project')
        if (project !== null) args.project = project
        const task = params.get('task')
        if (task !== null) args.task = task
        return jsonResponse({ history: getHistory(readDb(), args) })
      }
      {
        const m = /^\/v1\/tasks\/(.+)$/.exec(url.pathname)
        if (m) {
          const detail = getTaskDetail(readDb(), decodeURIComponent(m[1]!))
          if (!detail) return jsonResponse({ error: 'not found' }, { status: 404 })
          return jsonResponse(detail)
        }
      }
      {
        const m = /^\/v1\/explain\/(.+)$/.exec(url.pathname)
        if (m) {
          return jsonResponse(explainCacheKeyQuery(readDb(), decodeURIComponent(m[1]!)))
        }
      }
      {
        const m = /^\/v1\/why\/([^/]+)\/(.+)$/.exec(url.pathname)
        if (m) {
          return jsonResponse(
            whyDidThisRerunQuery(readDb(), decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)),
          )
        }
      }
      // The input-fingerprint moat: name the exact cache-key components that
      // differ between this run of a task and its previous run. taskId is
      // `project#task`, URI-encoded. Always 200 (a missing pair / no-previous
      // run is a clear shape in the body, not an HTTP error).
      {
        const m = /^\/v1\/diff\/([^/]+)\/(.+)$/.exec(url.pathname)
        if (m) {
          return jsonResponse(
            cacheKeyDiff(readDb(), decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)),
          )
        }
      }
      // Server-Sent Events — broadcasts the same event envelopes the WS
      // sees, but on a one-way stream. `curl -N http://.../events` works.
      if (url.pathname === '/events' || url.pathname === '/v1/events') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            const sub: ReadSubscriber = (env) => controller.enqueue(enc.encode(encodeForSSE(env)))
            readSubscribers.add(sub)
            req.signal.addEventListener('abort', () => {
              readSubscribers.delete(sub)
              try {
                controller.close()
              } catch {
                // already closed
              }
            })
          },
        })
        return withCors(
          new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-store',
              Connection: 'keep-alive',
            },
          }),
        )
      }
      // NDJSON — one envelope per line, no SSE framing. `jq`-friendly.
      if (url.pathname === '/stream') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            const sub: ReadSubscriber = (env) =>
              controller.enqueue(enc.encode(encodeForNDJSON(env)))
            readSubscribers.add(sub)
            req.signal.addEventListener('abort', () => {
              readSubscribers.delete(sub)
              try {
                controller.close()
              } catch {
                // already closed
              }
            })
          },
        })
        return withCors(
          new Response(stream, {
            headers: {
              'Content-Type': 'application/x-ndjson',
              'Cache-Control': 'no-store',
            },
          }),
        )
      }
      if (srv.upgrade(req)) return undefined
      // When --ui is set, serve the single-file dashboard for every non-API
      // GET. It's one self-contained HTML with a hash router, so every route
      // (/, /tasks, /cache, …) returns the same bytes.
      if (opts.uiHtmlPath !== undefined) {
        return withCors(
          new Response(Bun.file(opts.uiHtmlPath), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          }),
        )
      }
      return withCors(new Response('vx serve'))
    }

  const websocket: Bun.WebSocketHandler<undefined> = {
    async message(ws, raw) {
      const text = String(raw)
      // Parse once; classify into legacy ClientMessage or new envelope.
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      let message: ClientMessage | null = null
      if (isEnvelope(parsed)) {
        message = envelopeToClientMessage(parsed)
      } else if (parsed && typeof parsed === 'object' && 't' in (parsed as object)) {
        message = parsed as ClientMessage
      }
      if (!message || message.t !== 'run') return
      const send = (m: ServerMessage): void => {
        broadcast(m)
        try {
          ws.send(JSON.stringify(m))
        } catch {
          // client vanished mid-run; the run still completes server-side
        }
      }
      const ok = await executeRequest(send, message.request, inflight, [selfIngestSink])
      opts.onRun?.(message.request, ok)
    },
  }

  // Bind exactly the requested port — a busy port throws (the CLI catches it
  // and prints a clean message). When no port is given (tests / embedders),
  // bind an ephemeral one. The STABLE-default policy lives in the CLI
  // (`serveCmd`), so a `vx-cloud serve` always lands on the same URL.
  // Bun's default request-body cap (128 MB) is below the artifact-store
  // limit; raise it just past MAX_ARTIFACT_BYTES so the store's own 413
  // logic (content-length checked before the body is read) governs.
  const maxRequestBodySize = MAX_ARTIFACT_BYTES + 1024 * 1024
  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch: makeFetch(false),
    websocket,
    maxRequestBodySize,
  })

  // The optional unix-socket listener — same fetch handler, socket flag on.
  // A stale socket file (crashed previous serve) blocks the bind, so unlink
  // it first; chmod 0600 after bind makes the file permissions the auth.
  let socketServer: { stop(closeActiveConnections?: boolean): Promise<void> } | undefined
  if (opts.socketPath !== undefined) {
    await mkdir(path.dirname(opts.socketPath), { recursive: true })
    try {
      await unlink(opts.socketPath)
    } catch {
      // not present — fine
    }
    try {
      socketServer = Bun.serve({
        unix: opts.socketPath,
        fetch: makeFetch(true),
        websocket,
        maxRequestBodySize,
      })
      await chmod(opts.socketPath, 0o600)
    } catch (err) {
      await server.stop(true)
      ingest.close()
      throw err
    }
  }

  const origin = `http://localhost:${server.port}`
  // Advertise the local serve at a per-user, MACHINE-LEVEL path so a `vx run`
  // in ANY workspace discovers it (not just one started in this serve's root).
  // Best-effort: a read-only runtime dir must not fail startup over it.
  const infoPath = serveInfoPath()
  try {
    await mkdir(path.dirname(infoPath), { recursive: true })
    await writeFile(
      infoPath,
      JSON.stringify({
        origin,
        pid: process.pid,
        ...(opts.socketPath !== undefined ? { socket: opts.socketPath } : {}),
      }),
    )
  } catch {
    // can't advertise (read-only runtime dir) — explicit config still works
  }

  return {
    origin,
    name: serveName,
    ...(opts.socketPath !== undefined ? { socketPath: opts.socketPath } : {}),
    stop: async () => {
      await server.stop(true)
      await socketServer?.stop(true)
      try {
        ingest.close()
      } catch {
        // already closed
      }
      try {
        await unlink(infoPath)
      } catch {
        // already gone
      }
      if (opts.socketPath !== undefined) {
        try {
          await unlink(opts.socketPath)
        } catch {
          // already gone
        }
      }
    },
  }
}

interface ServeArgs {
  port?: number
  ui?: boolean
  open?: boolean
  ingestDir?: string
  token?: string
  name?: string
  /** `true` = enabled at the default/env path; a string = explicit path. */
  socket?: string | true
  error?: string
}

export function parseServeArgs(args: readonly string[]): ServeArgs {
  const out: ServeArgs = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--ui') {
      out.ui = true
      continue
    }
    if (a === '--open') {
      out.open = true
      continue
    }
    const idv =
      a === '--ingest-dir' ? args[++i] : a?.startsWith('--ingest-dir=') ? a.slice(13) : undefined
    if (idv !== undefined) {
      if (idv === '') return { ...out, error: 'invalid --ingest-dir: empty' }
      out.ingestDir = idv
      continue
    }
    const tv = a === '--token' ? args[++i] : a?.startsWith('--token=') ? a.slice(8) : undefined
    if (tv !== undefined) {
      if (tv === '') return { ...out, error: 'invalid --token: empty' }
      out.token = tv
      continue
    }
    const nv = a === '--name' ? args[++i] : a?.startsWith('--name=') ? a.slice(7) : undefined
    if (nv !== undefined) {
      if (nv === '') return { ...out, error: 'invalid --name: empty' }
      out.name = nv
      continue
    }
    if (a === '--socket' || a?.startsWith('--socket=')) {
      if (a.startsWith('--socket=')) {
        const sv = a.slice(9)
        if (sv === '') return { ...out, error: 'invalid --socket: empty' }
        out.socket = sv
        continue
      }
      // Bare `--socket` takes an OPTIONAL path: consume the next arg only
      // when it isn't another flag.
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.socket = next
        i++
      } else {
        out.socket = true
      }
      continue
    }
    const v = a === '--port' ? args[++i] : a?.startsWith('--port=') ? a.slice(7) : undefined
    if (v === undefined) return { ...out, error: `unknown flag: ${a}` }
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > 65535) return { ...out, error: `invalid --port: ${v}` }
    out.port = n
  }
  return out
}

/**
 * Load the embedded single-file dashboard. The asset module embeds
 * packages/cloud/ui/dist/index.html into the binary; in a source checkout the
 * dynamic import resolves the real file, which only exists after the SPA is
 * built — so a missing build only affects the UI, never the API/ingest.
 */
async function loadUiHtmlPath(): Promise<string | null> {
  try {
    const mod = await import('./ui-asset.js')
    const p = mod.UI_HTML_PATH
    if (!(await Bun.file(p).exists())) return null
    return p
  } catch {
    return null
  }
}

function openInBrowser(url: string): void {
  // Best-effort cross-platform open. Failures are silent — Ctrl-C is fine.
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url]
  try {
    const child = Bun.spawn({ cmd, stdout: 'ignore', stderr: 'ignore' })
    child.unref?.()
  } catch {
    // no opener available — user can paste the URL
  }
}

export async function serveCmd(args: readonly string[]): Promise<number> {
  const parsed = parseServeArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx serve: ${parsed.error}\n`)
    return 1
  }
  // vx-cloud is workspace-independent (it reads only its own ingest store).
  // Discover a workspace best-effort: when colocated, opts.root enables the
  // live-cockpit /v1/graph; when deployed remotely there is none, so fall
  // back to cwd (the ingest store lives under it, or --ingest-dir).
  const root = await findWorkspaceRoot(process.cwd()).catch(() => process.cwd())

  // Serve the embedded dashboard whenever it's available — a compiled binary
  // always has it, so `vx-cloud serve` is one Bun + SQLite + UI process. `--ui`
  // turns a missing build into a hard error (explicit intent) + enables --open.
  const uiHtmlPath = (await loadUiHtmlPath()) ?? undefined
  if (parsed.ui && uiHtmlPath === undefined) {
    // Only reachable in a source checkout that hasn't built the dashboard;
    // a compiled binary embeds it, so this never fires for end users.
    process.stderr.write(
      `vx serve: dashboard not built — run \`bun run --filter @vzn/vx-ui build\` (only needed when running from source)\n`,
    )
    return 1
  }

  // Stable, DETERMINISTIC port: --port > VX_CLOUD_PORT > 4321. No silent
  // ephemeral fallback — a busy port surfaces a clear error so the URL never
  // moves on its own.
  const portResult = resolveServePort(parsed.port)
  if ('error' in portResult) {
    process.stderr.write(`vx serve: ${portResult.error}\n`)
    return 1
  }

  // Auth + identity: flag > env. No token → fully open (localhost default).
  const envToken = process.env['VX_CLOUD_TOKEN']
  const token = parsed.token ?? (envToken !== undefined && envToken !== '' ? envToken : undefined)
  const envName = process.env['VX_CLOUD_NAME']
  const name = parsed.name ?? (envName !== undefined && envName !== '' ? envName : undefined)

  // Unix-socket listener: `--socket [path]` > VX_CLOUD_SOCKET > off. A bare
  // `--socket` uses the env path when set, else the per-user default.
  const envSocket = process.env[SERVE_SOCKET_ENV]
  const socketPath =
    typeof parsed.socket === 'string'
      ? parsed.socket
      : parsed.socket === true
        ? envSocket !== undefined && envSocket !== ''
          ? envSocket
          : defaultServeSocketPath()
        : envSocket !== undefined && envSocket !== ''
          ? envSocket
          : undefined

  let server
  try {
    server = await startServe({
      root,
      port: portResult.port,
      ...(uiHtmlPath !== undefined ? { uiHtmlPath } : {}),
      ...(parsed.ingestDir !== undefined ? { ingestDir: parsed.ingestDir } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(socketPath !== undefined ? { socketPath } : {}),
      onRun: (request, ok) => {
        process.stdout.write(`  ${ok ? '✓' : '✗'} ${request.tasks.join(', ')}\n`)
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `vx serve: could not bind port ${portResult.port}: ${msg}\n` +
        `  free the port, or pick another with --port <n> or ${SERVE_PORT_ENV}=<n>\n`,
    )
    return 1
  }

  const uiLine = uiHtmlPath !== undefined ? `vx serve: UI   ${server.origin}/\n` : ''
  const authLine = token !== undefined ? `vx serve: auth token required (--token)\n` : ''
  const socketLine =
    server.socketPath !== undefined ? `vx serve: sock ${server.socketPath}  (mode 0600)\n` : ''
  process.stdout.write(
    `vx serve: API  ${server.origin}  (${server.name})\n` +
      uiLine +
      authLine +
      socketLine +
      `vx serve: serving pushed runs from the ingest store (POST /v1/ingest)\n` +
      `(press Ctrl-C to stop)\n\n`,
  )

  if (parsed.open && uiHtmlPath !== undefined) openInBrowser(server.origin)

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })

  await server.stop()
  process.stdout.write('\nvx serve: stopped\n')
  return 0
}
