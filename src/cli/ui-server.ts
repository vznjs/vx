// devframe dev-server boot, shared by `vx run --ui` (a one-shot per-run
// server) and `vx dev` (the long-lived foreground hub). devframe is an
// OPTIONAL dependency: the adapter is imported dynamically, so a default
// `vx run` never loads it. Missing → a clear UserError with the hint.

import type { DevframeDefinition } from 'devframe'
import { createEventBus, createVxSurface, type EventBus } from '../orchestrator/index.js'
import { UserError } from '../util/index.js'

export interface DevframeServer {
  /** Origin the dev server bound to, e.g. `http://localhost:9999`. */
  origin: string
  /** Stop the server (closes the WS + HTTP listeners). */
  close: () => Promise<void>
}

/**
 * Boot a devframe dev server for a definition. The single place that
 * dynamically imports the devframe runtime adapter.
 */
export async function bootDevframeServer(
  definition: DevframeDefinition,
  port?: number,
): Promise<DevframeServer> {
  let createDevServer: typeof import('devframe/adapters/dev').createDevServer
  try {
    ;({ createDevServer } = await import('devframe/adapters/dev'))
  } catch {
    throw new UserError(
      "this needs the optional 'devframe' package — install it with: bun add -d devframe @modelcontextprotocol/sdk",
    )
  }

  let origin = ''
  const server = await createDevServer(definition, {
    ...(port !== undefined ? { port } : {}),
    onReady: (info) => {
      origin = info.origin
    },
  })
  return { origin, close: () => server.close() }
}

export interface UiServer extends DevframeServer {
  /** The bus to hand to `run({ bus })` — the surface is already subscribed. */
  bus: EventBus
}

/**
 * Start a per-run devframe dev server (`vx run --ui`). Creates the bus,
 * mounts the vx surface (which subscribes to it in `setup`), and returns
 * once listening — so the caller can subscribe the terminal renderer and
 * start the run with both surfaces live.
 */
export async function startUiServer(port?: number): Promise<UiServer> {
  const bus = createEventBus()
  const def = createVxSurface(bus)
  const server = await bootDevframeServer(def, port)
  return { ...server, bus }
}
