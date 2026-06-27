// Execution as a pluggable backend — the same idea as the cache's
// local/remote split, applied to running tasks. `vx run` resolves a
// backend and calls `run(request)`; it neither knows nor cares whether the
// work happened in-process or was delegated to a service. New backends
// (a pooled worker, a hosted execution cluster) slot in here without
// touching the CLI or the renderer.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  run as runOrchestrator,
  createEventBus,
  createWireRenderer,
  defaultLogger,
  projectOutcome,
  requestToOptions,
  resolveOutputView,
  wireForwarder,
  type ClientMessage,
  type Logger,
  type RunBackend,
  type RunResult,
  type ServerMessage,
} from '../orchestrator/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { UserError } from '../util/index.js'
import { connectDevForwarder } from './dev-client.js'
import { serveInfoPath } from './serve.js'

/**
 * Run in-process via `run()` — today's behaviour, byte-identical. If a
 * `vx dev` hub is up, mirror the run's events to it (additive: the local
 * terminal output is unchanged).
 */
export function localBackend(): RunBackend {
  return {
    async run(request) {
      const options = requestToOptions(request)
      const forwarder = await connectDevForwarder(request.cwd)
      if (forwarder) {
        const bus = createEventBus()
        bus.subscribe(wireForwarder((event) => forwarder.write(`${JSON.stringify(event)}\n`)))
        options.bus = bus
      }
      const summary = await runOrchestrator(options)
      if (forwarder) await forwarder.close()
      return { ok: summary.ok, outcomes: summary.outcomes.map(projectOutcome) }
    },
  }
}

/**
 * Delegate to a `vx serve` over WebSocket. The streamed events are rendered
 * through a normal `defaultLogger`, so a delegated run looks like a local
 * one. `origin` is an http(s) origin; the ws URL is derived from it. The
 * same backend serves a local service or a hosted `wss://` one.
 */
export function serviceBackend(origin: string, sink?: Logger): RunBackend {
  return {
    run(request) {
      const renderer =
        sink ??
        defaultLogger(
          undefined,
          resolveOutputView({
            ...(request.flow !== undefined ? { flow: request.flow } : {}),
            ...(request.outputLogs !== undefined ? { outputLogs: request.outputLogs } : {}),
          }),
        )
      const render = createWireRenderer(renderer)
      const wsUrl = origin.replace(/^http/, 'ws')

      return new Promise<RunResult>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        let result: RunResult | null = null
        let failure: Error | null = null
        ws.onopen = () => ws.send(JSON.stringify({ t: 'run', request } satisfies ClientMessage))
        ws.onmessage = (e) => {
          let message: ServerMessage
          try {
            message = JSON.parse(String(e.data)) as ServerMessage
          } catch {
            return
          }
          if (message.t === 'event') render(message.event)
          else if (message.t === 'result') {
            result = message.result
            ws.close()
          } else if (message.t === 'error') {
            failure = new UserError(message.message)
            ws.close()
          }
          // task:assign / cache:exists / coord:drain are coordinator-side messages
          // (distributed-ci protocol extension) — the run-submitter ignores them.
        }
        ws.onerror = () => {
          failure ??= new Error('vx serve: connection error')
        }
        ws.onclose = () => {
          if (result) resolve(result)
          else reject(failure ?? new Error('vx serve: closed without a result'))
        }
      })
    },
  }
}

/**
 * Pick a backend. Order: an explicit `VX_SERVICE_URL` (the hosted hook),
 * then a local `vx serve` advertised for this workspace, else in-process.
 * Fail-safe: any uncertainty — unreachable service, stale info file, parse
 * error — falls through to local. A service must never be able to break a
 * run by merely being misconfigured or down.
 */
export async function resolveBackend(cwd: string, sink?: Logger): Promise<RunBackend> {
  const envUrl = process.env['VX_SERVICE_URL']
  if (envUrl !== undefined && envUrl !== '' && (await reachable(envUrl))) {
    return serviceBackend(envUrl, sink)
  }
  try {
    const infoPath = serveInfoPath(await findWorkspaceRoot(cwd))
    if (existsSync(infoPath)) {
      const info = JSON.parse(await readFile(infoPath, 'utf8')) as { origin?: string }
      if (info.origin !== undefined && (await reachable(info.origin))) {
        return serviceBackend(info.origin, sink)
      }
    }
  } catch {
    // any failure → local
  }
  return localBackend()
}

/** Quick health probe with a hard timeout — never hangs a run. */
async function reachable(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(300),
    })
    return res.ok
  } catch {
    return false
  }
}
