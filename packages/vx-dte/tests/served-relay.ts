// The relay on Bun.serve with its participants' sockets, for tests that
// reach into it: `tap` sees (and may change) each frame a participant
// sends, `restart` loses every run, as a host restart does, and `refuse`
// answers 503 to the requests it matches, as a relay still coming up.

import { createRelay, type Relay, type RelayOptions } from '@vzn/vx-dte-server'

type Held = {
  key: string
  id: string
  socket?: { send(t: string): void; close(code?: number, reason?: string): void }
}

/** Down `ws`, the relay's answer to a frame, if it gave one. */
export function answer(ws: { send(text: string): unknown }, text: string | undefined): void {
  if (text !== undefined) ws.send(text)
}

export function servedRelay(
  opts: Omit<RelayOptions, 'upgrade'> = {},
  tap?: (frame: string) => string,
): {
  readonly relay: Relay
  url: string
  /** Each request's `sec-websocket-extensions`: what its client offered. */
  offered: (string | null)[]
  /** Requests it matches are answered 503 until it is set again. */
  refuse: ((req: Request) => boolean) | undefined
  restart(): void
  stop(): Promise<void>
} {
  let server: Bun.Server<Held> | undefined
  const open = new Set<Bun.ServerWebSocket<Held>>()
  const make = () =>
    createRelay({
      ...opts,
      upgrade: (key, id, req) => {
        server!.upgrade(req, { data: { key, id } })
        return new Response(null, { status: 101 })
      },
    })
  let relay = make()
  const offered: (string | null)[] = []
  let refuse: ((req: Request) => boolean) | undefined
  server = Bun.serve<Held>({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (r) => {
      offered.push(r.headers.get('sec-websocket-extensions'))
      if (refuse?.(r) === true) return new Response('coming up', { status: 503 })
      return relay.fetch(r)
    },
    websocket: {
      open(ws) {
        open.add(ws)
        ws.data.socket = {
          send(t) {
            if (ws.send(t) === 0) throw new Error('socket closed')
          },
          close: (code, reason) => ws.close(code, reason),
        }
        relay.attach(ws.data.key, ws.data.id, ws.data.socket)
      },
      message(ws, m) {
        answer(ws, relay.frame(ws.data.key, ws.data.id, tap?.(String(m)) ?? String(m)))
      },
      close(ws) {
        open.delete(ws)
        relay.detach(ws.data.key, ws.data.id, ws.data.socket!)
      },
    },
  })
  return {
    get relay() {
      return relay
    },
    url: `http://127.0.0.1:${server.port}`,
    offered,
    get refuse() {
      return refuse
    },
    set refuse(f) {
      refuse = f
    },
    restart() {
      relay = make()
      for (const ws of open) ws.close()
    },
    async stop() {
      await server!.stop(true)
    },
  }
}
