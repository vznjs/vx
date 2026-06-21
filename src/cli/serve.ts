// `vx serve` — the foreground execution service. Clients (`vx run`)
// connect over WebSocket, submit a RunRequest, and the service executes it
// in-process via the same `run()` the CLI uses, streaming WireEvents back
// and returning a RunResult. The transport is Bun-native (Bun.serve + ws),
// so the exact same protocol serves a local socket today or a hosted
// `wss://` link later. Foreground only: Ctrl-C stops it.

import path from 'node:path'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import {
  run as runOrchestrator,
  createEventBus,
  wireForwarder,
  requestToOptions,
  projectOutcome,
  decodeEnvelope,
  encodeForNDJSON,
  encodeForSSE,
  envelopeToClientMessage,
  isEnvelope,
  serverMessageToEnvelope,
  WIRE_CHANNELS,
  WIRE_PROTOCOL_VERSION,
  type ClientMessage,
  type Envelope,
  type Logger,
  type RunRequest,
  type ServerMessage,
} from '../orchestrator/index.js'
import { VERSION } from '../version.js'
import { findWorkspaceRoot } from '../workspace/index.js'

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

export async function startServe(opts: {
  root: string
  port?: number
  onRun?: (request: RunRequest, ok: boolean) => void
}): Promise<ServeServer> {
  // One registry for the service's whole lifetime — concurrent runs share
  // it to dedup in-flight task execution.
  const inflight = new Map<string, Promise<void>>()

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
      // Liveness probe — `vx run` health-checks this before delegating.
      if (url.pathname === '/health') return new Response('ok')
      // Capability handshake — what protocol version + channels + RPCs.
      if (url.pathname === '/version') {
        return Response.json({
          protocol: WIRE_PROTOCOL_VERSION,
          vx: VERSION,
          channels: WIRE_CHANNELS,
          rpc: ['getCacheStats', 'getRunHistory', 'explainCacheKey', 'whyDidThisRerun'],
        })
      }
      // Server-Sent Events — broadcasts the same event envelopes the WS
      // sees, but on a one-way stream. `curl -N http://.../events` works.
      if (url.pathname === '/events') {
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
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          },
        })
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
        return new Response(stream, {
          headers: {
            'Content-Type': 'application/x-ndjson',
            'Cache-Control': 'no-store',
          },
        })
      }
      if (srv.upgrade(req)) return undefined
      return new Response('vx serve')
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
