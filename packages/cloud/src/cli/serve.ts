// `vx-cloud serve` — the foreground execution service. Clients (`vx run`)
// connect over WebSocket, submit a RunRequest, and the service executes it
// in-process via the same `run()` the CLI uses, streaming WireEvents back
// and returning a RunResult. The transport is Bun-native (Bun.serve + ws),
// so the exact same protocol serves a local socket today or a hosted
// `wss://` link later. Foreground only: Ctrl-C stops it.

import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, unlink } from 'node:fs/promises'
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
  getPeriodComparison,
  getPrunableEntries,
  getRecentFailures,
  getRegressions,
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
import {
  ArtifactStore,
  DEFAULT_PRINCIPAL,
  MAX_ARTIFACT_BYTES,
  type Principal,
} from '../artifact-store.js'
import { IngestStore } from '../ingest-store.js'
import { LOG_WIRE_VERSION, TaskLogBuffer, type TaskLogBundle } from '../task-log-capture.js'
import type { StoredTaskLog } from '../log-store.js'
import {
  AgentRegistry,
  AGENT_STALE_MS,
  AGENT_SWEEP_INTERVAL_MS,
  SESSION_GC_INTERVAL_MS,
  type RegisteredAgent,
} from '../dist/registry.js'
import { DistScheduler } from '../dist/scheduler.js'
import {
  DIST_PROTOCOL_VERSION,
  type DistClientMessage,
  type DistServerMessage,
  type DistSubmitMessage,
} from '../protocol-dist.js'
import {
  QUEUE_PROTOCOL_VERSION,
  type QueueCancelMessage,
  type QueueServerMessage,
  type QueueSubmitMessage,
} from '../protocol-queue.js'
import { RunQueue } from '../run-queue.js'
import { WorkspaceCatalog } from '../workspace-catalog.js'
import { handleMcpHttp } from './mcp-serve.js'

/**
 * Per-socket role, set at upgrade time. `run` sockets speak the core
 * submission protocol (+ `dist:submit`); `agent` sockets speak the
 * `agent:*` family from protocol-dist.ts and are registered after their
 * `agent:hello`.
 */
type ServeWsData =
  | { role: 'run'; principal: Principal; scheduler?: DistScheduler; jobIds?: Set<string> }
  | { role: 'agent'; principal: Principal; agent?: RegisteredAgent }

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
 * Default unix-socket path for `serve --socket` (overridable per invocation):
 * `$XDG_RUNTIME_DIR/vx-cloud/serve.sock` when set (auto-cleared on logout),
 * else a per-uid temp subdir so a multi-user machine never collides on one
 * shared path.
 */
export function defaultServeSocketPath(): string {
  const xdg = process.env['XDG_RUNTIME_DIR']
  const base =
    xdg !== undefined && xdg !== ''
      ? path.join(xdg, 'vx-cloud')
      : path.join(os.tmpdir(), `vx-cloud-${userTag()}`)
  return path.join(base, 'serve.sock')
}

function userTag(): string {
  try {
    return String(process.getuid?.() ?? 'user')
  } catch {
    return 'user'
  }
}

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

/** Cap for a `POST /v1/ingest/logs` body — bounded before reading (413). */
const LOG_BODY_MAX_BYTES = 16 * 1024 * 1024

/** Cap for a `POST /v1/ingest` body — a summary now carries fingerprint file
 *  maps, so bound it before reading like the log bundle (413). */
const INGEST_BODY_MAX_BYTES = 32 * 1024 * 1024

/** Shape a stored tail into the `TaskLogResponse` (the route strips `hash`
 *  after the trust-scoped artifact check, and adds `refRunId` for hits). */
function logResponse(
  log: StoredTaskLog,
  runId: string,
  taskId: string,
  source: 'executed' | 'cache',
): Record<string, unknown> {
  return {
    runId,
    taskId,
    source,
    status: log.status,
    content: log.content,
    charsFull: log.charsFull,
    truncatedHeadChars: log.truncatedHeadChars,
    ...(log.hash !== undefined ? { hash: log.hash } : {}),
  }
}

/**
 * Mean execution ms per `project#task` from a workspace's recent EXECUTED
 * (non-cache-hit, successful) runs — the duration-aware dispatch signal. One
 * grouped scan; an unknown workspace (no store yet) → empty map (FIFO).
 */
function taskDurationHints(db: Database | undefined): Map<string, number> {
  const hints = new Map<string, number>()
  if (db === undefined) return hints
  try {
    const rows = db
      .query(
        `SELECT project, task, AVG(duration_ms) AS avg FROM runs
         WHERE status = 'success' AND (cache_hit IS NULL OR cache_hit = 0)
         GROUP BY project, task`,
      )
      .all() as { project: string; task: string; avg: number }[]
    for (const r of rows) hints.set(`${r.project}#${r.task}`, r.avg)
  } catch {
    // no runs table / fresh store — no hints, plain FIFO
  }
  return hints
}

/** How long an un-summarized delegated-run log buffer is held before sweep. */
const LOG_BUFFER_TTL_MS = 15 * 60 * 1000

/**
 * A serve-owned telemetry sink capturing DELEGATED runs' task logs server-side
 * (no client push, no double-shipping). One instance for the serve's lifetime;
 * records carry runId, so concurrent delegated runs multiplex into per-run
 * buffers, drained into the store on each run's summary. A run that crashes
 * before its summary leaves an orphan buffer, swept after `LOG_BUFFER_TTL_MS`.
 */
function makeServeLogSink(ingest: IngestStore, now: () => number = Date.now): TelemetrySink {
  const buffers = new Map<string, { buffer: TaskLogBuffer; createdAt: number }>()
  const bufFor = (runId: string): TaskLogBuffer => {
    let b = buffers.get(runId)
    if (b === undefined) {
      b = { buffer: new TaskLogBuffer(), createdAt: now() }
      buffers.set(runId, b)
    }
    return b.buffer
  }
  const sweep = (): void => {
    const cutoff = now() - LOG_BUFFER_TTL_MS
    for (const [runId, b] of buffers) if (b.createdAt < cutoff) buffers.delete(runId)
  }
  return {
    name: 'vx-cloud/serve-logs',
    wants: ['task.log', 'task.end'],
    onRecord(record) {
      if (record.kind === 'task.log') bufFor(record.runId).append(record.taskId, record.chunk)
      else if (record.kind === 'task.end') {
        bufFor(record.runId).finish(record.taskId, record.status, record.cacheSource, record.hash)
      }
    },
    onRunSummary(summary) {
      const runId = summary.run.runId
      const workspaceId = (summary.run as { workspaceId?: string }).workspaceId
      const entry = buffers.get(runId)
      buffers.delete(runId)
      sweep()
      if (entry === undefined || workspaceId === undefined) return
      const bundle = entry.buffer.drain(runId, workspaceId)
      if (bundle.tasks.length > 0) {
        try {
          ingest.ingestLogs(bundle)
        } catch {
          // log capture is best-effort — never fail a delegated run over it
        }
      }
    },
  }
}

function isLoopbackHost(h: string): boolean {
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
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
  /**
   * The UNTRUSTED (fork-PR) bearer. A holder reads the trusted + untrusted
   * scopes but writes ONLY the untrusted scope, so a fork-PR CI job can warm
   * off `main`'s cache without being able to poison it. Safe to expose (env:
   * VX_CLOUD_PR_TOKEN).
   */
  prToken?: string
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
  /**
   * TCP bind address. Defaults to `127.0.0.1` (loopback) — an
   * unauthenticated serve must never be reachable from the network, since the
   * `run`/`agent` WS channels execute arbitrary workspace tasks. Binding a
   * non-loopback host (e.g. `0.0.0.0` for a hosted deployment) REQUIRES a
   * token; startServe throws otherwise.
   */
  host?: string
  /**
   * Extra browser origins permitted to open the run/agent WS channels and the
   * SSE streams (a hosted dashboard on a different origin than the serve).
   * Same-origin and non-browser (no `Origin` header) clients are always
   * allowed; every other cross-origin browser handshake is refused (CSWSH
   * defense).
   */
  allowedOrigins?: readonly string[]
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
  // Two tokens, two tiers (docs/design/cache-trust-scopes-2026-07.md): the
  // main token is TRUSTED (read/write the trusted scope); the PR token is
  // UNTRUSTED (read trusted+untrusted, write only untrusted). Both compare in
  // constant time. No tokens → open serve, everyone is the default trusted
  // principal (byte-identical to the pre-trust-scopes single scope).
  const trustedDigest = opts.token !== undefined ? sha256(opts.token) : undefined
  const prDigest = opts.prToken !== undefined ? sha256(opts.prToken) : undefined
  const hasAuth = trustedDigest !== undefined || prDigest !== undefined
  const digestEq = (candidate: string, expected: Buffer | undefined): boolean =>
    expected !== undefined && timingSafeEqual(sha256(candidate), expected)
  /** Map a presented token to its principal, or null when it matches none. */
  const principalForToken = (candidate: string): Principal | null => {
    if (digestEq(candidate, trustedDigest)) return { tier: 'trusted', bucket: 'default' }
    if (digestEq(candidate, prDigest)) return { tier: 'untrusted', bucket: 'default' }
    return null
  }

  // Loopback by default: an open (tokenless) serve is only reachable from the
  // local machine, so a LAN attacker can't drive the run/agent channels. A
  // non-loopback bind is a deliberate hosted deployment and MUST carry a token.
  const host = opts.host ?? '127.0.0.1'
  if (!isLoopbackHost(host) && !hasAuth) {
    throw new Error(
      `refusing to bind a non-loopback host (${host}) without a token: an unauthenticated serve on a reachable interface exposes arbitrary task execution — set --token / VX_CLOUD_TOKEN`,
    )
  }

  // Cross-origin WebSocket handshakes are NOT gated by the same-origin policy
  // (CSWSH), so a malicious page a user visits could open ws://localhost:PORT
  // and drive the run/agent channels = drive-by RCE. Browsers ALWAYS send an
  // `Origin` on a WS/EventSource handshake; a CLI client (vx run delegation,
  // an agent) sends none. Allow: no Origin (CLI), same-origin, or an
  // explicitly configured origin. Reject every other cross-origin browser
  // handshake.
  const allowedOrigins = new Set<string>(opts.allowedOrigins ?? [])
  const originAllowed = (req: Request, url: URL): boolean => {
    const origin = req.headers.get('origin')
    if (origin === null) return true
    if (allowedOrigins.has(origin)) return true
    try {
      return new URL(origin).host === url.host
    } catch {
      return false
    }
  }

  // The single auth gate. Exempt: /health (probes/k8s) and /v1/meta (the
  // identity handshake `connect` needs BEFORE the user has proven a token —
  // it carries no secrets and no workspace path). The UI catch-all also stays
  // open: the SPA is static code and must load to show its token prompt; every
  // data surface it calls is gated below. Requests arriving over the unix
  // socket bypass the token entirely: the socket is chmod 0600, so the OS
  // file permissions ARE the auth (only this user can even open it).
  // Returns the request's authenticated Principal, or null (→ 401). A socket
  // request or an open (no-token) serve is the default trusted principal;
  // exempt/ungated paths (static UI, /health, /v1/meta) don't consume the
  // principal so they also resolve to the default.
  function authorized(req: Request, url: URL, viaSocket: boolean): Principal | null {
    if (viaSocket) return DEFAULT_PRINCIPAL
    if (!hasAuth) return DEFAULT_PRINCIPAL
    if (url.pathname === '/health' || url.pathname === '/v1/meta') return DEFAULT_PRINCIPAL
    const isUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    const gated =
      isUpgrade ||
      url.pathname === '/version' ||
      url.pathname === '/events' ||
      url.pathname === '/stream' ||
      url.pathname === '/mcp' ||
      url.pathname.startsWith('/v1/')
    if (!gated) return DEFAULT_PRINCIPAL
    const header = req.headers.get('authorization')
    if (header !== null && header.startsWith('Bearer ')) {
      const p = principalForToken(header.slice(7))
      if (p !== null) return p
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
      if (qt !== null) {
        const p = principalForToken(qt)
        if (p !== null) return p
      }
    }
    return null
  }

  // vx-cloud is INDEPENDENT of vx core: it NEVER opens a workspace cache.db.
  // The dashboard's /v1/* analytics read ONLY this service's own SQLite store,
  // fed by the cloud() plugin's telemetry push (POST /v1/ingest). So vx-cloud
  // can be deployed anywhere — it has no access to, and no need for, the
  // machine(s) that produced the runs. One Bun process: SQLite store + the
  // ingest endpoint + the /v1/* API + the embedded UI.
  const ingestDir = opts.ingestDir ?? path.join(opts.root, '.vx', 'cloud-ingest')
  const ingest = new IngestStore(ingestDir, (m) => process.stderr.write(`[vx-cloud] ${m}\n`))

  // The workspace catalog — a colocated-workspace live feature like
  // /v1/graph (cloud-data-model-2026-07 §6): lock-first, live fallback,
  // mtime-keyed memo. Reads only the committed config surface; a remote
  // ingest-only serve has no workspace and 404s the /v1/workspace routes.
  const catalog = new WorkspaceCatalog(opts.root)

  // The serve-hosted artifact store (the vx-native /v1/cache wire) — a
  // connected environment (or an explicit VX_CLOUD_URL) routes the remote
  // cache here, no separate cache server needed.
  const artifacts = new ArtifactStore(path.join(ingestDir, 'artifacts'))
  // One-time: fold a pre-trust-scopes flat store into default/trusted/ so an
  // existing single-tenant deployment keeps its warm cache after upgrade.
  await artifacts.migrateLegacyFlatStore((m) => process.stderr.write(`[vx-cloud] ${m}\n`))

  // The distribution session registry ({workspaceId, session} → agents) +
  // its 60s idle-session sweep. In-memory by design: a serve restart
  // mid-pipeline fails that pipeline loudly and the next one is fine.
  const registry = new AgentRegistry()
  const registryGcTimer = setInterval(() => registry.gc(), SESSION_GC_INTERVAL_MS)
  registryGcTimer.unref?.()
  // Liveness sweep: reap agents that stopped heartbeating (a crashed box / a
  // half-open socket), reassigning their in-flight tasks within seconds.
  const agentSweepTimer = setInterval(
    () => registry.sweepStale(AGENT_STALE_MS),
    AGENT_SWEEP_INTERVAL_MS,
  )
  agentSweepTimer.unref?.()

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
  // Server-side per-task log capture for delegated runs (task-logs-2026-07 §3):
  // the serve hosts the telemetry source for them, so the bytes are born here
  // — no client push, no double-shipping.
  const serveLogSink = makeServeLogSink(ingest)

  // The FIFO run queue (cloud-data-model-2026-07 §7) — EVERY serve-executed
  // run rides it, plain CLI delegation included, closing the pre-existing
  // race where two concurrent delegations could fight over output cleaning.
  // Each job's stream/lifecycle routes to its submitting socket via a
  // binding; `queueWire` marks a `queue:submit` job (speaks queue:* frames)
  // vs a plain delegated `run` (core wire only — it gets one run:status
  // "queued behind N" line instead). `dist:submit` does NOT ride the queue:
  // agents execute in their own checkouts, there is no serve-local output
  // tree to race on.
  interface JobBinding {
    send: (m: ServerMessage) => void
    sendQueue: (m: QueueServerMessage) => void
    queueWire: boolean
  }
  const jobBindings = new Map<string, JobBinding>()
  const queue = new RunQueue({
    execute: async (job) => {
      const binding = jobBindings.get(job.jobId)
      // A canceled-socket binding may be gone; the run still executes and
      // its events drop (today's stop-watching semantics).
      const send = binding?.send ?? ((): void => {})
      if (binding?.queueWire) binding.sendQueue({ t: 'queue:start', jobId: job.jobId })
      // Per-job runId sink: the queue learns the executed run's id from the
      // summary the run itself captured — zero core change.
      const jobSink: TelemetrySink = {
        name: 'vx-cloud/queue-job',
        onRunSummary: (summary) => {
          job.runId = summary.run.runId
        },
      }
      const ok = await executeRequest(send, job.request, inflight, [
        selfIngestSink,
        serveLogSink,
        jobSink,
      ])
      if (binding?.queueWire) {
        binding.sendQueue({
          t: 'queue:done',
          jobId: job.jobId,
          ...(job.runId !== undefined ? { runId: job.runId } : {}),
          ok,
        })
      }
      jobBindings.delete(job.jobId)
      opts.onRun?.(job.request, ok)
      return ok
    },
    onUpdate: (jobs) => {
      for (const j of jobs) {
        if (j.state !== 'queued') continue
        jobBindings.get(j.jobId)?.sendQueue({
          t: 'queue:update',
          jobId: j.jobId,
          position: j.position,
        })
      }
    },
  })

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
      srv: { upgrade(req: Request, opts?: { data: ServeWsData }): boolean },
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
        return (async () =>
          jsonResponse({
            v: 1,
            name: serveName,
            vx: VERSION,
            auth: hasAuth ? 'token' : 'open',
            startedAt,
            // Count only — a pre-auth endpoint must not leak workspace names.
            workspaces: ingest.workspaceCount(),
            // Capability advertisement: this serve hosts the artifact store
            // on the vx-native /v1/cache wire (version 1), so a connected
            // environment can auto-wire the remote-cache rung.
            artifacts: true,
            cacheWire: 1,
            // Trust tiers are honored — a client can present a PR token.
            trustTiers: true,
            // A colocated workspace makes the /v1/workspace/* catalog live.
            catalog: await catalog.available(),
          }))()
      }
      const principal = authorized(req, url, viaSocket)
      if (principal === null) {
        return jsonResponse(
          { error: 'unauthorized' },
          { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
        )
      }
      // CSWSH / drive-by defense: gate the state-changing WS channels and the
      // live SSE streams on the Origin (a token, when set, is a second gate;
      // this stands even for the tokenless local default a browser can reach).
      // A socket request has no browser origin to check.
      if (!viaSocket) {
        const isUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
        const isStream =
          url.pathname === '/events' || url.pathname === '/v1/events' || url.pathname === '/stream'
        if ((isUpgrade || isStream) && !originAllowed(req, url)) {
          return jsonResponse({ error: 'origin not allowed' }, { status: 403 })
        }
      }
      // Distribution agents rendezvous here (bearer-gated above like every
      // WS upgrade). The socket's role rides `ws.data`; the first message
      // must be `agent:hello`.
      if (url.pathname === '/v1/agents') {
        if (srv.upgrade(req, { data: { role: 'agent', principal } })) return undefined
        // Not a WS upgrade → a capacity read: how big is this
        // {workspaceId, session} pool right now, and how many REMOTE helpers
        // does it hold. An ambient `vx run` reads this to decide whether
        // distributing is worth it (vs. staying a fast local run); an
        // autoscaler reads the same counts. Bearer-gated above.
        return jsonResponse(
          registry.availableCapacity(
            url.searchParams.get('ws') ?? '',
            url.searchParams.get('session') ?? '',
            url.searchParams.get('commit') ?? undefined,
          ),
        )
      }
      // MCP — the AI-agent control plane (dev-flows design §10.3): JSON-RPC
      // 2.0 over streamable HTTP, tools adapting the same metrics queries
      // the /v1/* routes serve. Bearer-gated above like every /v1 read.
      if (url.pathname === '/mcp') {
        return handleMcpHttp(req, ingest).then(withCors)
      }
      // The artifact store (the vx-native cache wire). Hex-only in the route
      // so it can never shadow the named /v1/cache/* analytics endpoints
      // (stats, entries, …) — a real cache key is 16-hex; wider widths are
      // reserved for future hash algorithms.
      {
        const m = /^\/v1\/cache\/([0-9a-f]{16,64})$/.exec(url.pathname)
        if (m) return artifacts.handle(req, m[1]!, principal).then(withCors)
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
        const len = Number(req.headers.get('content-length') ?? '0')
        if (Number.isFinite(len) && len > INGEST_BODY_MAX_BYTES) {
          return jsonResponse({ ok: false, error: 'summary too large' }, { status: 413 })
        }
        return (async () => {
          try {
            // Re-check the ACTUAL body size, not the (spoofable, absent under
            // chunked transfer) content-length header — mirror the artifact
            // PUT's byteLength re-check so a chunked body can't bypass the cap.
            const raw = await req.text()
            if (Buffer.byteLength(raw, 'utf8') > INGEST_BODY_MAX_BYTES) {
              return jsonResponse({ ok: false, error: 'summary too large' }, { status: 413 })
            }
            const summary = JSON.parse(raw) as RunSummaryRecord
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
      // Per-task log tails (task-logs-2026-07). Bearer-gated like /v1/ingest;
      // workspace routed by the body's own id. Bounded: a 16 MiB body cap
      // (413 before reading), an unknown wire version 400s naming both, and
      // the store re-truncates every tail regardless of what the body claims.
      if (url.pathname === '/v1/ingest/logs' && req.method === 'POST') {
        const len = Number(req.headers.get('content-length') ?? '0')
        if (Number.isFinite(len) && len > LOG_BODY_MAX_BYTES) {
          return jsonResponse({ ok: false, error: 'log bundle too large' }, { status: 413 })
        }
        return (async () => {
          try {
            // Actual-byte re-check — see /v1/ingest above (chunked bypass).
            const raw = await req.text()
            if (Buffer.byteLength(raw, 'utf8') > LOG_BODY_MAX_BYTES) {
              return jsonResponse({ ok: false, error: 'log bundle too large' }, { status: 413 })
            }
            const bundle = JSON.parse(raw) as TaskLogBundle
            if (bundle?.v !== LOG_WIRE_VERSION) {
              const got = String((bundle as { v?: unknown } | null)?.v)
              return jsonResponse(
                {
                  ok: false,
                  error: `log wire version mismatch: body v${got}, serve v${String(LOG_WIRE_VERSION)}`,
                },
                { status: 400 },
              )
            }
            if (typeof bundle.workspaceId !== 'string' || !Array.isArray(bundle.tasks)) {
              return jsonResponse({ ok: false, error: 'not a TaskLogBundle' }, { status: 400 })
            }
            const stored = ingest.ingestLogs(bundle)
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
      // The artifact-store list (cloud-data-model-2026-07 §8) — the artifact
      // store made visible. NOT workspace-gated (artifacts exist on remote
      // serves too), so it sits above the unknown-workspace guard. The
      // listing walks ONLY the principal's read scopes — it can never show
      // an entry a GET couldn't fetch. Provenance (which task/run produced
      // a hash) is a best-effort join against the workspace-resolved
      // ingest db; absent for workspaces this serve never ingested.
      if (url.pathname === '/v1/artifacts') {
        return (async () => {
          const limitRaw = url.searchParams.get('limit')
          const limitNum = limitRaw !== null ? Number(limitRaw) : NaN
          const limit = Number.isInteger(limitNum) && limitNum > 0 ? Math.min(limitNum, 1000) : 200
          const entries = await artifacts.list(
            principal,
            req.headers.get('x-vx-cache-scope'),
            limit,
          )
          const provenance = new Map<
            string,
            { project: string; task: string; runId: string | null }
          >()
          try {
            const db = ingest.db(wsParam ?? ingest.defaultWorkspaceId())
            if (db !== undefined && entries.length > 0) {
              const hashes = entries.map((e) => e.hash)
              // IN-lists chunked at 900 (SQLite's parameter ceiling — the
              // prune precedent); ORDER BY started_at DESC + first-wins
              // resolves each hash to its most recent producing row.
              for (let i = 0; i < hashes.length; i += 900) {
                const chunk = hashes.slice(i, i + 900)
                const rows = db
                  .query<
                    { hash: string; project: string; task: string; run_id: string | null },
                    string[]
                  >(
                    `SELECT hash, project, task, run_id FROM runs
                     WHERE hash IN (${chunk.map(() => '?').join(',')})
                     ORDER BY started_at DESC`,
                  )
                  .all(...chunk)
                for (const r of rows) {
                  if (!provenance.has(r.hash)) {
                    provenance.set(r.hash, { project: r.project, task: r.task, runId: r.run_id })
                  }
                }
              }
            }
          } catch {
            // no ingest db yet / schema drift — provenance stays absent
          }
          return jsonResponse({
            artifacts: entries.map((e) => {
              const p = provenance.get(e.hash)
              return p !== undefined
                ? {
                    ...e,
                    task: {
                      project: p.project,
                      task: p.task,
                      ...(p.runId !== null ? { runId: p.runId } : {}),
                    },
                  }
                : e
            }),
          })
        })()
      }
      // The workspace catalog (cloud-data-model-2026-07 §6.3) — the lock/live
      // project + task index of the COLOCATED workspace. `?ws=` is ignored:
      // the catalog is inherently single-workspace (§13.3), so these routes
      // sit above the unknown-workspace guard. Bearer-gated like every /v1.
      if (url.pathname.startsWith('/v1/workspace/')) {
        return (async () => {
          try {
            const resolved = await catalog.resolve()
            if (resolved === null) {
              return jsonResponse({ error: 'no colocated workspace' }, { status: 404 })
            }
            if (url.pathname === '/v1/workspace/projects') {
              return jsonResponse(catalog.projectsResponse(resolved))
            }
            if (url.pathname === '/v1/workspace/tasks') {
              return jsonResponse(catalog.tasksResponse(resolved))
            }
            const m = /^\/v1\/workspace\/projects\/(.+)$/.exec(url.pathname)
            if (m) {
              const name = decodeURIComponent(m[1]!)
              const detail = catalog.projectResponse(resolved, name)
              if (detail === null) {
                return jsonResponse({ error: `unknown project: ${name}` }, { status: 404 })
              }
              return jsonResponse(detail)
            }
            return jsonResponse({ error: 'not found' }, { status: 404 })
          } catch (err) {
            return jsonResponse(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400 },
            )
          }
        })()
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
      // Cross-machine hermeticity (verify-cross-machine §4): cache keys whose
      // fingerprinted output trees DIVERGE across reports, diffed at read
      // time from the workspace's fingerprint sidecar. Fed by `--verify*`
      // runs' summaries; the Insights Hermeticity card reads this.
      if (url.pathname === '/v1/hermeticity') {
        const limitRaw = url.searchParams.get('limit')
        const limitNum = limitRaw !== null ? Number(limitRaw) : NaN
        const limit = Number.isInteger(limitNum) && limitNum > 0 ? Math.min(limitNum, 500) : 50
        return jsonResponse(ingest.hermeticity(wsParam ?? ingest.defaultWorkspaceId(), limit))
      }
      // The run queue's live state (queued + running jobs, positions,
      // timestamps) — the unified Runs view polls this while non-empty.
      // Matched before the /v1/runs/:id regex below.
      if (url.pathname === '/v1/runs/queue') {
        return jsonResponse({ jobs: queue.jobs() })
      }
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
      // A task's persisted log tail (task-logs-2026-07 §6). Resolution: (1) a
      // direct row for this (run, task); (2) else, if the task was a cache hit
      // with a hash, the log of the run that produced those bytes
      // (`source: 'cache'`); (3) else 404. `artifactHash` is advertised only
      // when the requester's principal can actually fetch it from /v1/cache.
      {
        const m = /^\/v1\/runs\/([^/]+)\/logs\/(.+)$/.exec(url.pathname)
        if (m) {
          const ws = wsParam ?? ingest.defaultWorkspaceId()
          const runId = decodeURIComponent(m[1]!)
          const taskId = decodeURIComponent(m[2]!)
          const direct = ingest.logFor(ws, runId, taskId)
          let body: Record<string, unknown> | undefined
          if (direct !== undefined) {
            body = { ...logResponse(direct, runId, taskId, 'executed') }
          } else {
            // Resolve the task's row in this run to find its hash + hit status.
            const run = getRun(readDb(), runId)
            const row = run?.tasks.find((t) => `${t.project}#${t.task}` === taskId)
            if (row?.hash && (row.cacheHit === true || row.status.startsWith('cache-hit'))) {
              const producer = ingest.logByHash(ws, row.hash)
              if (producer !== undefined) {
                body = {
                  ...logResponse(producer, runId, taskId, 'cache'),
                  refRunId: producer.runId,
                }
              }
            }
          }
          if (body === undefined) {
            return jsonResponse({ error: 'no logs captured for this task' }, { status: 404 })
          }
          const resolved = body
          const hash = resolved['hash'] as string | undefined
          return (async () => {
            // artifactHash advertised only when the requester's principal can
            // actually fetch it from /v1/cache (trust-scoped).
            if (hash !== undefined && (await artifacts.has(hash, principal))) {
              resolved['artifactHash'] = hash
            }
            delete resolved['hash']
            return jsonResponse(resolved)
          })()
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
      // Regressions — tasks that started failing across branches (used to
      // pass, now failing on >= minBranches distinct branches). The "what
      // just broke everywhere?" surface, distinct from flaky/nondeterministic.
      if (url.pathname === '/v1/regressions') {
        const params = url.searchParams
        const args: Parameters<typeof getRegressions>[1] = {}
        const sinceDays = params.get('sinceDays')
        if (sinceDays !== null) args.sinceDays = Number(sinceDays)
        const minBranches = params.get('minBranches')
        if (minBranches !== null) args.minBranches = Number(minBranches)
        const limit = params.get('limit')
        if (limit !== null) args.limit = Number(limit)
        return jsonResponse({ tasks: getRegressions(readDb(), args) })
      }
      // Period-over-period analysis — this window vs the previous equal-length
      // window (default 7d): headline stats deltas + the tasks whose average
      // duration moved the most. The "how is CI trending?" surface.
      if (url.pathname === '/v1/analysis') {
        const params = url.searchParams
        const args: Parameters<typeof getPeriodComparison>[1] = {}
        const window = params.get('window')
        if (window !== null) args.windowDays = Number(window)
        const minRuns = params.get('minRuns')
        if (minRuns !== null) args.minRuns = Number(minRuns)
        const limit = params.get('limit')
        if (limit !== null) args.limit = Number(limit)
        // Per-project / per-task scoping — the entity pages' "did MY
        // performance improve or decrease?" trend.
        const project = params.get('project')
        if (project !== null) args.project = project
        const task = params.get('task')
        if (task !== null) args.task = task
        return jsonResponse(getPeriodComparison(readDb(), args))
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
      if (srv.upgrade(req, { data: { role: 'run', principal } })) return undefined
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

  // Agent-socket protocol: first message must be `agent:hello` (anything
  // else → close); after registration every message routes through the
  // registry to the session's live submission.
  const handleAgentSocket = (ws: Bun.ServerWebSocket<ServeWsData>, text: string): void => {
    const data = ws.data as { role: 'agent'; agent?: RegisteredAgent }
    let msg: DistClientMessage
    try {
      msg = JSON.parse(text) as DistClientMessage
    } catch {
      return
    }
    if (data.agent === undefined) {
      if (msg.t !== 'agent:hello') {
        try {
          ws.close()
        } catch {
          // already closed
        }
        return
      }
      const agent = registry.hello(msg, {
        send: (m: DistServerMessage) => {
          try {
            ws.send(JSON.stringify(m))
          } catch {
            // agent vanished; cleanup happens on close
          }
        },
        close: () => {
          try {
            ws.close()
          } catch {
            // already closed
          }
        },
      })
      if (agent !== null) data.agent = agent
      return
    }
    if (msg.t === 'agent:bye') return // the close handler unregisters
    if (msg.t === 'agent:heartbeat') {
      registry.heartbeat(data.agent)
      return
    }
    registry.dispatch(data.agent, msg)
  }

  const websocket: Bun.WebSocketHandler<ServeWsData> = {
    async message(ws, raw) {
      const text = String(raw)
      if (ws.data?.role === 'agent') {
        handleAgentSocket(ws, text)
        return
      }
      // Parse once; classify into legacy ClientMessage or new envelope.
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      const send = (m: ServerMessage): void => {
        broadcast(m)
        try {
          ws.send(JSON.stringify(m))
        } catch {
          // client vanished mid-run; the run still completes server-side
        }
      }
      // A distributed submission: pair with the session registry, prune
      // against the artifact store, dispatch to agents. Answered by the
      // same ServerMessage stream a delegated run uses.
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { t?: unknown }).t === 'dist:submit'
      ) {
        const submit = parsed as DistSubmitMessage
        if (submit.protocol !== DIST_PROTOCOL_VERSION) {
          send({
            t: 'error',
            message: `dist protocol mismatch: submitter speaks v${submit.protocol}, serve speaks v${DIST_PROTOCOL_VERSION}`,
          })
          return
        }
        // Scope the store probe to the submitter's principal: a trusted
        // submission prunes on trusted/<hash>; an untrusted one on
        // untrusted ∪ trusted. The prune must never treat a hash warm in a
        // scope this submission can't read as already-done.
        const principal = ws.data?.role === 'run' ? ws.data.principal : DEFAULT_PRINCIPAL
        const scopedStore = {
          has: (h: string) => artifacts.has(h, principal),
          storedDurationMs: (h: string) => artifacts.storedDurationMs(h, principal),
        }
        // Duration-aware dispatch: the ready queue starts the longest task
        // first (LPT makespan heuristic). The hints come from THIS serve's
        // ingest history for the workspace — the right source in CI, where the
        // submitter's own checkout is an ephemeral empty runner. Absent
        // history → an empty map → byte-identical FIFO dispatch.
        const durationHints = taskDurationHints(ingest.db(submit.workspaceId))
        const scheduler = new DistScheduler({ submit, store: scopedStore, send, durationHints })
        const bound = registry.beginSubmission(submit.workspaceId, submit.session, scheduler)
        if ('error' in bound) {
          send({ t: 'error', message: bound.error })
          return
        }
        scheduler.attach(bound)
        if (ws.data?.role === 'run') ws.data.scheduler = scheduler
        await scheduler.start()
        return
      }
      // The queue family (cloud-owned, like dist:* — core's ClientMessage is
      // untouched): explicit multi-trigger submissions from the dashboard.
      if (parsed !== null && typeof parsed === 'object') {
        const t = (parsed as { t?: unknown }).t
        const sendQueue = (m: QueueServerMessage): void => {
          try {
            ws.send(JSON.stringify(m))
          } catch {
            // client vanished; queued jobs cancel on close
          }
        }
        if (t === 'queue:submit') {
          const msg = parsed as QueueSubmitMessage
          if (msg.v !== QUEUE_PROTOCOL_VERSION) {
            sendQueue({
              t: 'queue:refused',
              message: `queue protocol mismatch: client speaks v${String(msg.v)}, serve speaks v${QUEUE_PROTOCOL_VERSION}`,
            })
            return
          }
          if (typeof msg.request !== 'object' || !Array.isArray(msg.request?.tasks)) {
            sendQueue({ t: 'queue:refused', message: 'not a RunRequest' })
            return
          }
          const res = queue.submit(msg.request)
          if ('error' in res) {
            sendQueue({ t: 'queue:refused', message: res.error })
            return
          }
          jobBindings.set(res.jobId, { send, sendQueue, queueWire: true })
          if (ws.data?.role === 'run') (ws.data.jobIds ??= new Set()).add(res.jobId)
          sendQueue({ t: 'queue:accepted', jobId: res.jobId, position: res.position })
          return
        }
        if (t === 'queue:cancel') {
          const msg = parsed as QueueCancelMessage
          if (queue.cancel(msg.jobId)) jobBindings.delete(msg.jobId)
          return
        }
      }
      let message: ClientMessage | null = null
      if (isEnvelope(parsed)) {
        message = envelopeToClientMessage(parsed)
      } else if (parsed && typeof parsed === 'object' && 't' in (parsed as object)) {
        message = parsed as ClientMessage
      }
      if (!message || message.t !== 'run') return
      // Plain CLI delegation rides the SAME queue (serialized execution —
      // the concurrent-delegation output race is closed). The client speaks
      // only the core wire, so a non-immediate start surfaces as one
      // run:status line the wire renderer already prints, ahead of run:start.
      const res = queue.submit(message.request)
      if ('error' in res) {
        send({ t: 'error', message: res.error })
        return
      }
      jobBindings.set(res.jobId, { send, sendQueue: () => {}, queueWire: false })
      if (ws.data?.role === 'run') (ws.data.jobIds ??= new Set()).add(res.jobId)
      if (res.position > 0) {
        send({
          t: 'event',
          event: {
            kind: 'run:status',
            line: `vx: queued behind ${res.position} run(s) on this serve`,
          },
        })
      }
    },
    close(ws) {
      if (ws.data?.role === 'agent') {
        if (ws.data.agent !== undefined) registry.drop(ws.data.agent)
        return
      }
      // A submitter that dies mid-run: the scheduler finishes the graph
      // with the remaining agents, then drains them.
      ws.data?.scheduler?.onSubmitterGone()
      // Closing the socket of a QUEUED job cancels it; a RUNNING job
      // completes server-side (stop-watching semantics, unchanged) and its
      // binding is dropped when it finishes.
      if (ws.data?.jobIds !== undefined) {
        for (const jobId of ws.data.jobIds) {
          if (queue.cancel(jobId)) jobBindings.delete(jobId)
        }
      }
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
    hostname: host,
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

  return {
    origin,
    name: serveName,
    ...(opts.socketPath !== undefined ? { socketPath: opts.socketPath } : {}),
    stop: async () => {
      clearInterval(registryGcTimer)
      clearInterval(agentSweepTimer)
      await server.stop(true)
      await socketServer?.stop(true)
      try {
        ingest.close()
      } catch {
        // already closed
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
  prToken?: string
  name?: string
  host?: string
  allowOrigins?: string[]
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
    const ptv =
      a === '--pr-token' ? args[++i] : a?.startsWith('--pr-token=') ? a.slice(11) : undefined
    if (ptv !== undefined) {
      if (ptv === '') return { ...out, error: 'invalid --pr-token: empty' }
      out.prToken = ptv
      continue
    }
    const nv = a === '--name' ? args[++i] : a?.startsWith('--name=') ? a.slice(7) : undefined
    if (nv !== undefined) {
      if (nv === '') return { ...out, error: 'invalid --name: empty' }
      out.name = nv
      continue
    }
    const hv = a === '--host' ? args[++i] : a?.startsWith('--host=') ? a.slice(7) : undefined
    if (hv !== undefined) {
      if (hv === '') return { ...out, error: 'invalid --host: empty' }
      out.host = hv
      continue
    }
    const aov =
      a === '--allow-origin'
        ? args[++i]
        : a?.startsWith('--allow-origin=')
          ? a.slice(15)
          : undefined
    if (aov !== undefined) {
      if (aov === '') return { ...out, error: 'invalid --allow-origin: empty' }
      ;(out.allowOrigins ??= []).push(aov)
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
  const envPrToken = process.env['VX_CLOUD_PR_TOKEN']
  const prToken =
    parsed.prToken ?? (envPrToken !== undefined && envPrToken !== '' ? envPrToken : undefined)
  const envName = process.env['VX_CLOUD_NAME']
  const name = parsed.name ?? (envName !== undefined && envName !== '' ? envName : undefined)

  // Bind host: --host > VX_CLOUD_HOST > 127.0.0.1 (loopback). A non-loopback
  // bind without a token is refused inside startServe.
  const envHost = process.env['VX_CLOUD_HOST']
  const host = parsed.host ?? (envHost !== undefined && envHost !== '' ? envHost : undefined)
  // Extra allowed browser origins for the WS/SSE channels (a hosted dashboard
  // on a different origin): --allow-origin (repeatable) + VX_CLOUD_ALLOW_ORIGIN
  // (comma-separated).
  const envOrigins = (process.env['VX_CLOUD_ALLOW_ORIGIN'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const allowedOrigins = [...(parsed.allowOrigins ?? []), ...envOrigins]

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
      ...(prToken !== undefined ? { prToken } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
      ...(socketPath !== undefined ? { socketPath } : {}),
      onRun: (request, ok) => {
        process.stdout.write(`  ${ok ? '✓' : '✗'} ${request.tasks.join(', ')}\n`)
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // A configuration refusal (e.g. non-loopback host without a token) carries
    // its own actionable message; don't dress it up as a port-bind failure.
    if (msg.startsWith('refusing to bind')) {
      process.stderr.write(`vx serve: ${msg}\n`)
      return 1
    }
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
