// The platform's machine-surface HTTP host (docs/design/cloud-platform-2026-07.md
// §12 P4). `server.ts` builds the account/token gate + the Postgres analytics
// layer + the S3 artifact store, then hands them here: this owns the single
// `Bun.serve` and every surface the gate DOESN'T resolve to a Postgres Response
// — the vx-native cache wire (`/v1/cache/:hash`), the artifact list
// (`/v1/artifacts`), the AI-agent control plane (`/mcp`, Postgres-backed), the
// distribution channels (`/v1/agents` WS + `dist:submit`), the live streams
// (`/events`, `/stream`), and the dashboard SPA catch-all.
//
// There is no SQLite here and no companion (tokenless / colocated-workspace)
// path: the gate IS the auth, and every data read routes to Postgres or S3.

import {
  encodeForNDJSON,
  encodeForSSE,
  serverMessageToEnvelope,
  type Envelope,
  type ServerMessage,
} from '@vzn/vx'
import { ArtifactStore, MAX_ARTIFACT_BYTES, type Principal } from '../artifact-store.js'
import { S3Backend } from '../blob/s3.js'
import type { Analytics } from '../db/analytics.js'
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
import { handleMcpHttp } from './mcp.js'

/** The resolved S3 artifact-offload config (docs/design/s3-blob-backend-2026-07.md). */
export interface ResolvedS3Config {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
  presignTtlSeconds: number
}

/**
 * Resolve producing-task provenance for a set of artifact hashes — most-recent
 * project/task/runId per hash. The gate binds this to Postgres `task_runs`
 * (workspace-clamped); absent when the request has no resolvable workspace.
 */
export type ArtifactProvenanceResolver = (
  hashes: readonly string[],
) => Promise<Map<string, { project: string; task: string; runId: string | null }>>

/** The gate's decision for a request: a fully-formed Response, or a grant. */
export interface Grant {
  principal: Principal
  provenance?: ArtifactProvenanceResolver
}

/**
 * The account/token gate (server.ts builds it). Consulted for every request
 * past `/health`: it fully handles auth/admin routes, `/v1/meta`, and the
 * Postgres analytics surfaces (returning a Response), or grants the request a
 * machine-surface principal (+ an optional provenance resolver).
 */
export type PlatformGate = (req: Request, url: URL) => Promise<Response | Grant>

export interface PlatformHttpOptions {
  port: number
  host: string
  /** Server identity reported by the SPA / `/v1/meta` (built in the gate). */
  name: string
  /** S3 artifact storage — mandatory on the platform (bytes never on the box). */
  s3: ResolvedS3Config
  /** Postgres analytics — MCP tools + dist duration hints read through it. */
  analytics: Analytics
  gate: PlatformGate
  /** Path to the embedded single-file dashboard; every non-API GET serves it. */
  uiHtmlPath?: string
  log?: (message: string) => void
}

export interface PlatformHttp {
  origin: string
  name: string
  stop(): Promise<void>
}

/**
 * Per-socket role, set at upgrade time. `run` sockets speak the core
 * submission protocol (`dist:submit`); `agent` sockets speak the `agent:*`
 * family from protocol-dist.ts and are registered after their `agent:hello`.
 */
type ServeWsData =
  | { role: 'run'; principal: Principal; scheduler?: DistScheduler }
  | { role: 'agent'; principal: Principal; agent?: RegisteredAgent }

// CORS is wide-open: a hosted dashboard reaches the API from a foreign origin,
// and every mutating surface is bearer- or session-gated by the gate.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, HEAD, OPTIONS',
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

export async function startPlatformHttp(opts: PlatformHttpOptions): Promise<PlatformHttp> {
  const log = opts.log ?? (() => undefined)
  const { analytics } = opts

  // Bytes live in the bucket — GET answers 307 to a presigned URL; PUT proxies
  // through the store's gates (trust scopes, immutability, caps, zstd magic)
  // then uploads. The controller stores no artifact bytes at rest.
  const artifacts = new ArtifactStore(new S3Backend(opts.s3))
  log(`artifact store: s3 ${opts.s3.endpoint}/${opts.s3.bucket}`)

  // The distribution session registry ({orgId, workspaceId, session} → agents)
  // + its idle-session sweep and liveness (heartbeat) sweep. In-memory by
  // design: a restart mid-pipeline fails that pipeline loudly; the next is fine.
  const registry = new AgentRegistry()
  const registryGcTimer = setInterval(() => registry.gc(), SESSION_GC_INTERVAL_MS)
  registryGcTimer.unref?.()
  const agentSweepTimer = setInterval(
    () => registry.sweepStale(AGENT_STALE_MS),
    AGENT_SWEEP_INTERVAL_MS,
  )
  agentSweepTimer.unref?.()

  // Read-only event subscribers (SSE / NDJSON). Each callback gets every event
  // from every concurrent dist run as a notification envelope.
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

  const streamResponse = (
    req: Request,
    encode: (env: Envelope) => string,
    contentType: string,
  ): Response => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        const sub: ReadSubscriber = (env) => controller.enqueue(enc.encode(encode(env)))
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
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
      }),
    )
  }

  const dispatch = (
    req: Request,
    url: URL,
    grant: Grant,
    srv: { upgrade(req: Request, opts?: { data: ServeWsData }): boolean },
  ): Response | Promise<Response> | undefined => {
    const { principal, provenance } = grant
    // Distribution agents rendezvous here (bearer-gated in the gate like every
    // WS upgrade). The socket's role rides `ws.data`; the first message must be
    // `agent:hello`.
    if (url.pathname === '/v1/agents') {
      if (srv.upgrade(req, { data: { role: 'agent', principal } })) return undefined
      // A capacity read: how big is this {orgId, workspaceId, session} pool and
      // how many REMOTE helpers it holds — an ambient `vx run` / an autoscaler.
      return jsonResponse(
        registry.availableCapacity(
          url.searchParams.get('ws') ?? '',
          url.searchParams.get('session') ?? '',
          url.searchParams.get('commit') ?? undefined,
          principal.orgId,
        ),
      )
    }
    // MCP — the AI-agent control plane. JSON-RPC 2.0 over streamable HTTP,
    // tools adapting the Postgres analytics queries, org/workspace-clamped.
    if (url.pathname === '/mcp') {
      return handleMcpHttp(req, {
        analytics,
        orgId: principal.orgId,
        ...(principal.workspaceId !== undefined ? { tokenWorkspaceId: principal.workspaceId } : {}),
      }).then(withCors)
    }
    // The vx-native cache wire. Hex-only so it can never shadow the named
    // `/v1/cache/*` analytics endpoints (a real cache key is 16-hex; wider
    // widths are reserved for future hash algorithms).
    {
      const m = /^\/v1\/cache\/([0-9a-f]{16,64})$/.exec(url.pathname)
      if (m) return artifacts.handle(req, m[1]!, principal).then(withCors)
    }
    // The artifact-store list — the S3 store made visible. Walks ONLY the
    // principal's read scopes (never wider than a GET could reach). Provenance
    // (which task/run produced a hash) is the gate's Postgres `task_runs` join.
    if (url.pathname === '/v1/artifacts') {
      return (async () => {
        const limitRaw = url.searchParams.get('limit')
        const limitNum = limitRaw !== null ? Number(limitRaw) : NaN
        const limit = Number.isInteger(limitNum) && limitNum > 0 ? Math.min(limitNum, 1000) : 200
        const entries = await artifacts.list(principal, req.headers.get('x-vx-cache-scope'), limit)
        let prov = new Map<string, { project: string; task: string; runId: string | null }>()
        const hashes = entries.map((e) => e.hash)
        try {
          if (provenance !== undefined && hashes.length > 0) prov = await provenance(hashes)
        } catch {
          // down pg / schema drift — provenance absent, entries still listed
        }
        return jsonResponse({
          artifacts: entries.map((e) => {
            const p = prov.get(e.hash)
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
    // Live event streams — the same envelopes the WS sees, one-way.
    if (url.pathname === '/events' || url.pathname === '/v1/events') {
      return streamResponse(req, encodeForSSE, 'text/event-stream')
    }
    if (url.pathname === '/stream') {
      return streamResponse(req, encodeForNDJSON, 'application/x-ndjson')
    }
    // A run submitter's WS (dist:submit). Anything else is the SPA catch-all.
    if (srv.upgrade(req, { data: { role: 'run', principal } })) return undefined
    if (opts.uiHtmlPath !== undefined) {
      return withCors(
        new Response(Bun.file(opts.uiHtmlPath), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        }),
      )
    }
    return withCors(new Response('vx-cloud'))
  }

  const fetch = (
    req: Request,
    srv: { upgrade(req: Request, opts?: { data: ServeWsData }): boolean },
  ): Response | Promise<Response | undefined> | undefined => {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }))
    if (url.pathname === '/health') return withCors(new Response('ok'))
    // The SSE/NDJSON readers register on the shared subscriber set; drop them
    // when the request aborts. (Registration itself is inside dispatch's stream
    // body; the abort listener lives here so it survives the response return.)
    return opts.gate(req, url).then((out) => {
      if (out instanceof Response) return withCors(out)
      const res = dispatch(req, url, out, srv)
      return res
    })
  }

  // Agent-socket protocol: first message must be `agent:hello` (anything else →
  // close); after registration every message routes to the session's live
  // submission through the registry.
  const handleAgentSocket = (ws: Bun.ServerWebSocket<ServeWsData>, text: string): void => {
    const data = ws.data as { role: 'agent'; principal: Principal; agent?: RegisteredAgent }
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
      // The org is SERVER-derived from the agent's token (never the wire) and
      // keys the session — a cross-org agent can never join another's pool.
      const agent = registry.hello(
        msg,
        {
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
        },
        data.principal.orgId,
      )
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
      // A distributed submission: pair with the session registry, prune against
      // the artifact store, dispatch to agents. Answered by the core
      // ServerMessage stream (event / result / error) the wire renderer reads.
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
        if (ws.data?.role !== 'run') return
        const { principal } = ws.data
        // Scope the store probe to the submitter's principal: a trusted
        // submission prunes on trusted/<hash>; an untrusted one on
        // untrusted ∪ trusted. The prune must never treat a hash warm in a
        // scope this submission can't read as already-done.
        const scopedStore = {
          has: (h: string) => artifacts.has(h, principal),
          storedDurationMs: (h: string) => artifacts.storedDurationMs(h, principal),
        }
        // Duration-aware dispatch: the ready queue starts the longest task first
        // (LPT). Hints come from THIS org's Postgres history for the submission's
        // workspace — the right source in CI, where the submitter is an
        // ephemeral empty runner. No history (un-ingested) → an empty map →
        // byte-identical FIFO dispatch.
        const wsUuid = await analytics
          .resolveClientWorkspace(principal.orgId, submit.workspaceId)
          .catch(() => null)
        const durationHints =
          wsUuid !== null
            ? await analytics.taskDurationHints(wsUuid).catch(() => new Map<string, number>())
            : new Map<string, number>()
        const scheduler = new DistScheduler({ submit, store: scopedStore, send, durationHints })
        // The submitter's token org keys the session (server-derived), so a pool
        // is isolated per tenant and a `dist:submit` runs under its ci token.
        const bound = registry.beginSubmission(
          submit.workspaceId,
          submit.session,
          scheduler,
          principal.orgId,
        )
        if ('error' in bound) {
          send({ t: 'error', message: bound.error })
          return
        }
        scheduler.attach(bound)
        if (ws.data?.role === 'run') ws.data.scheduler = scheduler
        await scheduler.start()
        return
      }
      // Run delegation ({t:'run'}) was REMOVED (platform §12 P3): the platform
      // has no checkout to execute against. Distribution (`dist:submit`, above)
      // is the replacement. A stray delegation gets a clear wire error.
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { t?: unknown }).t === 'run'
      ) {
        send({
          t: 'error',
          message:
            'run delegation was removed — distribute across agents (VX_CLOUD_DISTRIBUTE) or run locally',
        })
      }
    },
    close(ws) {
      if (ws.data?.role === 'agent') {
        if (ws.data.agent !== undefined) registry.drop(ws.data.agent)
        return
      }
      // A submitter that dies mid-run: the scheduler finishes the graph with the
      // remaining agents, then drains them.
      ws.data?.scheduler?.onSubmitterGone()
    },
  }

  // Bun's default request-body cap (128 MB) is below the artifact-store limit;
  // raise it just past MAX_ARTIFACT_BYTES so the store's own 413 logic governs.
  const maxRequestBodySize = MAX_ARTIFACT_BYTES + 1024 * 1024
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch,
    websocket,
    maxRequestBodySize,
  })

  // Report a loopback origin even when bound on 0.0.0.0 — a client fetches the
  // machine locally; the public origin is the operator's VX_CLOUD_BASE_URL.
  const origin = `http://localhost:${server.port}`
  return {
    origin,
    name: opts.name,
    stop: async () => {
      clearInterval(registryGcTimer)
      clearInterval(agentSweepTimer)
      await server.stop(true)
    },
  }
}

/**
 * Load the embedded single-file dashboard. The asset module embeds
 * packages/cloud/ui/dist/index.html into the binary; in a source checkout the
 * dynamic import resolves the real file, which only exists after the SPA is
 * built — so a missing build only affects the UI, never the API.
 */
export async function loadUiHtmlPath(): Promise<string | null> {
  try {
    const mod = await import('./ui-asset.js')
    const p = mod.UI_HTML_PATH
    if (!(await Bun.file(p).exists())) return null
    return p
  } catch {
    return null
  }
}
