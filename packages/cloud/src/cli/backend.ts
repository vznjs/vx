// The cloud-side run backends: delegate to a `vx-cloud serve` over a
// WebSocket (`serviceBackend`), discover one for the current workspace
// (`resolveBackend`), and a local in-process backend that additionally
// mirrors events to a running `vx dev` hub (`localDevBackend`). Core's
// `localBackend` is the plain in-process default; these are the building
// blocks the first-party `cloud()` plugin's `backend` capability composes
// (Phase 3).

import {
  run as runOrchestrator,
  createEventBus,
  createWireRenderer,
  defaultLogger,
  projectOutcome,
  requestToOptions,
  resolveOutputView,
  wireForwarder,
  UserError,
  type ClientMessage,
  type Logger,
  type RunBackend,
  type RunResult,
  type ServerMessage,
} from '@vzn/vx'
import { connectDevForwarder } from './dev-client.js'
import { readServeInfo } from '../serve-info.js'

/**
 * Run in-process via `run()`, mirroring the run's events to a live `vx dev`
 * hub when one is up (additive: the local terminal output is unchanged).
 */
export function localDevBackend(): RunBackend {
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
 * Delegate to a `vx-cloud serve` over WebSocket. The streamed events are
 * rendered through a normal `defaultLogger`, so a delegated run looks like a
 * local one. `origin` is an http(s) origin; the ws URL is derived from it. The
 * same backend serves a local service or a hosted `wss://` one. A `token`
 * rides the upgrade request as `Authorization: Bearer` (Bun's client
 * WebSocket accepts a headers option) for a token-gated serve.
 */
export function serviceBackend(origin: string, sink?: Logger, token?: string): RunBackend {
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
        const ws =
          token !== undefined
            ? new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } })
            : new WebSocket(wsUrl)
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
 * Pick a backend. Order: an explicit `serviceUrl` (the `cloud({ serviceUrl })`
 * option or a delegate-enabled environment; `token` rides its WS upgrade),
 * then `VX_SERVICE_URL` (the hosted hook), then a local `vx-cloud serve`
 * advertised for this workspace, else the in-process dev backend.
 * Fail-safe: any uncertainty — unreachable service, stale info file, parse
 * error — falls through to local. A service must never be able to break a run
 * by merely being misconfigured or down.
 */
export async function resolveBackend(
  cwd: string,
  sink?: Logger,
  serviceUrl?: string,
  token?: string,
): Promise<RunBackend> {
  if (serviceUrl !== undefined && serviceUrl !== '' && (await reachable(serviceUrl))) {
    return serviceBackend(serviceUrl, sink, token)
  }
  const envUrl = process.env['VX_SERVICE_URL']
  if (envUrl !== undefined && envUrl !== '' && (await reachable(envUrl))) {
    return serviceBackend(envUrl, sink)
  }
  // Auto-detect a local serve via its per-user advertisement (machine-level, so
  // it's found from any workspace). `reachable` confirms it's actually up, so a
  // stale file just falls through to local.
  try {
    const info = readServeInfo()
    if (info !== undefined && (await reachable(info.origin))) {
      return serviceBackend(info.origin, sink)
    }
  } catch {
    // any failure → local
  }
  return localDevBackend()
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
