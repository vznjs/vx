// The relay on Bun.serve with its participants' sockets, for tests that
// reach into it: `tap` sees (and may change) each frame a participant
// sends, and `restart` loses every run, as a host restart does.

import { closeSocket, createRelay, GONE, type Relay, type RelayOptions } from '@vzn/vx-dte-relay'

type Held = {
  key: string
  id: string
  socket?: { send(t: string): void; close(code?: number, reason?: string): void }
}

export function servedRelay(
  opts: Omit<RelayOptions, 'upgrade'> = {},
  tap?: (frame: string) => string,
): { readonly relay: Relay; url: string; restart(): void; stop(): Promise<void> } {
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
  server = Bun.serve<Held>({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (r) => relay.fetch(r),
    websocket: {
      open(ws) {
        open.add(ws)
        ws.data.socket = {
          send(t) {
            if (ws.send(t) === 0) throw new Error('socket closed')
          },
          close: (code, reason) => ws.close(code, reason),
        }
        if (!relay.attach(ws.data.key, ws.data.id, ws.data.socket))
          closeSocket(ws.data.socket, GONE, 'gone')
      },
      message(ws, m) {
        ws.send(relay.frame(ws.data.key, ws.data.id, tap?.(String(m)) ?? String(m)))
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
    restart() {
      relay = make()
      for (const ws of open) ws.close()
    },
    async stop() {
      await server!.stop(true)
    },
  }
}
