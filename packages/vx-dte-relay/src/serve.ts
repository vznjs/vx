// The relay on Bun.serve, its participants' websockets included.

import type { ServerWebSocket } from 'bun'
import { createRelay, type RelayOptions, type RelaySocket } from './relay.js'

export interface ServeOptions extends Pick<RelayOptions, 'verify' | 'heartbeatMs'> {
  hostname: string
  /** `0` picks a free port. */
  port: number
}

export interface RelayServer {
  readonly url: string
  stop(): Promise<void>
}

interface Held {
  key: string
  id: string
  socket?: RelaySocket
}

export function serveRelay(opts: ServeOptions): RelayServer {
  let server: Bun.Server<Held> | undefined
  const relay = createRelay({
    ...opts,
    upgrade: (key, id, req) => {
      if (!server!.upgrade(req, { data: { key, id } })) {
        return Response.json({ error: 'not a websocket' }, { status: 426 })
      }
      // Bun answers the upgrade itself and ignores this.
      return new Response(null, { status: 101 })
    },
  })
  server = Bun.serve<Held>({
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: 60,
    fetch: (req) => relay.fetch(req),
    websocket: {
      // A silent socket is lost by the relay's heartbeat, not Bun's idle timeout.
      idleTimeout: 0,
      open(ws: ServerWebSocket<Held>) {
        const { key, id } = ws.data
        ws.data.socket = {
          send(text) {
            // 0: dropped, so the relay queues it for the next poll instead.
            if (ws.send(text) === 0) throw new Error('socket closed')
          },
          close: () => ws.close(),
        }
        if (!relay.attach(key, id, ws.data.socket)) ws.close()
      },
      message(ws: ServerWebSocket<Held>, message) {
        const { key, id } = ws.data
        if (message === 'ping') {
          relay.seen(key, id, Date.now())
          ws.send('pong')
          return
        }
        ws.send(relay.frame(key, id, String(message)))
      },
      close(ws: ServerWebSocket<Held>) {
        const { key, id, socket } = ws.data
        if (socket !== undefined) relay.detach(key, id, socket)
      },
    },
  })
  const host = opts.hostname.includes(':') ? `[${opts.hostname}]` : opts.hostname
  return {
    url: `http://${host}:${server.port}`,
    async stop() {
      relay.close()
      await server.stop(true)
    },
  }
}
