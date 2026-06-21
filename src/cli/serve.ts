// `vx serve` — the foreground execution service. Clients (`vx run`)
// connect over WebSocket, submit a RunRequest, and the service executes it
// in-process via the same `run()` the CLI uses, streaming WireEvents back
// and returning a RunResult. The transport is Bun-native (Bun.serve + ws),
// so the exact same protocol serves a local socket today or a hosted
// `wss://` link later. Foreground only: Ctrl-C stops it.

import path from 'node:path'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { Cache } from '../cache/index.js'
import {
  run as runOrchestrator,
  createEventBus,
  wireForwarder,
  requestToOptions,
  projectOutcome,
  encodeForNDJSON,
  encodeForSSE,
  envelopeToClientMessage,
  explainCacheKeyQuery,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStatsSql,
  getHistory,
  getRecentFailures,
  getRun,
  getTaskDetail,
  getTopTimeBurners,
  isEnvelope,
  listCacheEntries,
  listInvocations,
  listRuns,
  serverMessageToEnvelope,
  whyDidThisRerunQuery,
  WIRE_CHANNELS,
  WIRE_PROTOCOL_VERSION,
  type ClientMessage,
  type Envelope,
  type Logger,
  type RunRequest,
  type ServerMessage,
} from '../orchestrator/index.js'
import { VERSION } from '../version.js'
import { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from '../workspace/index.js'

/** Where `vx serve` advertises itself and `vx run` looks for it. */
export function serveInfoPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.vx', 'serve.json')
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
  stop: () => Promise<void>
}

// CORS is wide-open: the hosted SPA needs to reach localhost from a foreign
// origin, and the surface is read-only insights + an authenticated WS run
// submission. Any tighter policy would break the "host the SPA once, point
// it at any vx serve" UX.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  onRun?: (request: RunRequest, ok: boolean) => void
}): Promise<ServeServer> {
  // One registry for the service's whole lifetime — concurrent runs share
  // it to dedup in-flight task execution.
  const inflight = new Map<string, Promise<void>>()

  // Read-only handle to the workspace's cache.db, opened once and reused
  // for every /v1/* query. The query module is pure — opens nothing —
  // so the lifetime lives here.
  const workspaceConfig = await loadWorkspaceConfig(opts.root)
  const cacheDir = resolveCacheDir(opts.root, workspaceConfig)
  const cache = new Cache(cacheDir)

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

  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      // Browser preflight — answer everything with CORS-permissive headers.
      if (req.method === 'OPTIONS') {
        return withCors(new Response(null, { status: 204 }))
      }
      // Liveness probe — `vx run` health-checks this before delegating.
      if (url.pathname === '/health') return withCors(new Response('ok'))
      // Capability handshake — what protocol version + channels + RPCs.
      if (url.pathname === '/version') {
        return jsonResponse({
          protocol: WIRE_PROTOCOL_VERSION,
          vx: VERSION,
          channels: WIRE_CHANNELS,
          rpc: ['getCacheStats', 'getRunHistory', 'explainCacheKey', 'whyDidThisRerun'],
          workspace: opts.root,
        })
      }
      // -----------------------------------------------------------------
      // Insights HTTP surface — JSON read APIs over cache.db. The hosted
      // SPA in apps/insights/ calls these directly; same shape will be
      // mirrored by a future hosted multi-tenant deployment.
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
        return jsonResponse({ runs: listRuns(cache.dbHandle(), args) })
      }
      if (url.pathname === '/v1/invocations') {
        const limit = Number(url.searchParams.get('limit') ?? '50')
        return jsonResponse({ invocations: listInvocations(cache.dbHandle(), limit) })
      }
      {
        const m = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname)
        if (m) {
          const detail = getRun(cache.dbHandle(), decodeURIComponent(m[1]!))
          if (!detail) return jsonResponse({ error: 'not found' }, { status: 404 })
          return jsonResponse(detail)
        }
      }
      if (url.pathname === '/v1/cache/stats') {
        return jsonResponse(getCacheStatsSql(cache.dbHandle()))
      }
      if (url.pathname === '/v1/cache/breakdown') {
        const limit = Number(url.searchParams.get('limit') ?? '20')
        return jsonResponse({ projects: getCacheBreakdown(cache.dbHandle(), limit) })
      }
      if (url.pathname === '/v1/cache/savings') {
        return jsonResponse(getCacheSavings(cache.dbHandle()))
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
        return jsonResponse({ entries: listCacheEntries(cache.dbHandle(), args) })
      }
      if (url.pathname === '/v1/top-tasks') {
        const limit = Number(url.searchParams.get('limit') ?? '10')
        return jsonResponse({ tasks: getTopTimeBurners(cache.dbHandle(), limit) })
      }
      if (url.pathname === '/v1/failures') {
        const limit = Number(url.searchParams.get('limit') ?? '25')
        return jsonResponse({ failures: getRecentFailures(cache.dbHandle(), limit) })
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
        return jsonResponse({ history: getHistory(cache.dbHandle(), args) })
      }
      {
        const m = /^\/v1\/tasks\/(.+)$/.exec(url.pathname)
        if (m) {
          const detail = getTaskDetail(cache.dbHandle(), decodeURIComponent(m[1]!))
          if (!detail) return jsonResponse({ error: 'not found' }, { status: 404 })
          return jsonResponse(detail)
        }
      }
      {
        const m = /^\/v1\/explain\/(.+)$/.exec(url.pathname)
        if (m) {
          return jsonResponse(explainCacheKeyQuery(cache.dbHandle(), decodeURIComponent(m[1]!)))
        }
      }
      {
        const m = /^\/v1\/why\/([^/]+)\/(.+)$/.exec(url.pathname)
        if (m) {
          return jsonResponse(
            whyDidThisRerunQuery(
              cache.dbHandle(),
              decodeURIComponent(m[1]!),
              decodeURIComponent(m[2]!),
            ),
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
      return withCors(new Response('vx serve'))
    },
    websocket: {
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
        const ok = await executeRequest(send, message.request, inflight)
        opts.onRun?.(message.request, ok)
      },
    },
  })

  const origin = `http://localhost:${server.port}`
  const infoPath = serveInfoPath(opts.root)
  await mkdir(path.dirname(infoPath), { recursive: true })
  await writeFile(infoPath, JSON.stringify({ origin, pid: process.pid }))

  return {
    origin,
    stop: async () => {
      await server.stop(true)
      try {
        cache.close()
      } catch {
        // already closed
      }
      try {
        await unlink(infoPath)
      } catch {
        // already gone
      }
    },
  }
}

function parsePort(args: readonly string[]): { port?: number; error?: string } {
  const out: { port?: number; error?: string } = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const v = a === '--port' ? args[++i] : a?.startsWith('--port=') ? a.slice(7) : undefined
    if (v === undefined) return { error: `unknown flag: ${a}` }
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > 65535) return { error: `invalid --port: ${v}` }
    out.port = n
  }
  return out
}

export async function serveCmd(args: readonly string[]): Promise<number> {
  const parsed = parsePort(args)
  if (parsed.error) {
    process.stderr.write(`vx serve: ${parsed.error}\n`)
    return 1
  }
  const root = await findWorkspaceRoot(process.cwd())
  const server = await startServe({
    root,
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
    onRun: (request, ok) => {
      process.stdout.write(`  ${ok ? '✓' : '✗'} ${request.tasks.join(', ')}\n`)
    },
  })

  process.stdout.write(
    `vx serve: ${server.origin}\n` +
      `vx serve: ready — \`vx run\` in this workspace will delegate here\n` +
      `(press Ctrl-C to stop)\n\n`,
  )

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })

  await server.stop()
  process.stdout.write('\nvx serve: stopped\n')
  return 0
}
