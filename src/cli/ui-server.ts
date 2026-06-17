// `vx run --ui`: boot a devframe dev server (h3 + WebSocket) that mirrors
// the run live — the `vx:events` stream + the reduced `vx:run` shared
// state. devframe is an OPTIONAL dependency: the adapter is imported
// dynamically here, so a default `vx run` never loads it and installs
// without it. Missing → a clear UserError with the install hint.

import { createEventBus, createVxSurface, type EventBus } from '../orchestrator/index.js'
import { UserError } from '../util/index.js'

export interface UiServer {
  /** Origin the dev server bound to, e.g. `http://localhost:9999`. */
  origin: string
  /** The bus to hand to `run({ bus })` — the surface is already subscribed. */
  bus: EventBus
  /** Stop the server (closes the WS + HTTP listeners). */
  close: () => Promise<void>
}

/**
 * Start the devframe dev server for a single run. Creates the bus,
 * mounts the vx surface (which subscribes to the bus in its `setup`),
 * and returns once the server is listening — so the caller can subscribe
 * the terminal renderer and start the run, with both surfaces live.
 */
export async function startUiServer(port?: number): Promise<UiServer> {
  const bus = createEventBus()
  const def = createVxSurface(bus)

  let createDevServer: typeof import('devframe/adapters/dev').createDevServer
  try {
    ;({ createDevServer } = await import('devframe/adapters/dev'))
  } catch {
    throw new UserError(
      "vx --ui needs the optional 'devframe' package — install it with: bun add -d devframe @modelcontextprotocol/sdk",
    )
  }

  let origin = ''
  const server = await createDevServer(def, {
    ...(port !== undefined ? { port } : {}),
    onReady: (info) => {
      origin = info.origin
    },
  })

  return { origin, bus, close: () => server.close() }
}
