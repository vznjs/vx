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
  type ClientMessage,
  type Logger,
  type RunRequest,
  type ServerMessage,
} from '../orchestrator/index.js'
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
): Promise<boolean> {
  const bus = createEventBus()
  bus.subscribe(wireForwarder((event) => send({ t: 'event', event })))
  try {
    const summary = await runOrchestrator({
      ...requestToOptions(request),
      bus,
      log: silentLogger,
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
  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      // Liveness probe — `vx run` health-checks this before delegating.
      if (url.pathname === '/health') return new Response('ok')
      if (srv.upgrade(req)) return undefined
      return new Response('vx serve')
    },
    websocket: {
      async message(ws, raw) {
        let message: ClientMessage
        try {
          message = JSON.parse(String(raw)) as ClientMessage
        } catch {
          return
        }
        if (message.t !== 'run') return
        const send = (m: ServerMessage): void => {
          try {
            ws.send(JSON.stringify(m))
          } catch {
            // client vanished mid-run; the run still completes server-side
          }
        }
        const ok = await executeRequest(send, message.request)
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
