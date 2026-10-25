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
    upgrade: (key, id, req, protocol) => {
      const headers = protocol === undefined ? {} : { 'sec-websocket-protocol': protocol }
      if (!server!.upgrade(req, { data: { key, id }, headers })) {
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
      // A socket with no frame in three heartbeats has no peer listening
      // either (each probes a quiet one within two): closed, it loses its
      // participant, as a half-open one on no other host would be.
      idleTimeout: Math.max(1, Math.ceil((3 * (opts.heartbeatMs ?? 2_000)) / 1000)),
      open(ws: ServerWebSocket<Held>) {
        const { key, id } = ws.data
        ws.data.socket = {
          send(text) {
            // 0: dropped, so the relay queues it for the next poll instead.
            if (ws.send(text) === 0) throw new Error('socket closed')
          },
          close: (code, reason) => ws.close(code, reason),
        }
        relay.attach(key, id, ws.data.socket)
      },
      message(ws: ServerWebSocket<Held>, message) {
        const { key, id } = ws.data
        const answer = relay.frame(key, id, String(message), ws.data.socket)
        if (answer !== undefined) ws.send(answer)
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
      await server.stop(true)
    },
  }
}
