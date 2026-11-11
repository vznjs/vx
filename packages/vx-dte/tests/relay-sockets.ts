// What the relay client's tests share: relays whose sockets a test sees and
// drops as a network does, and what was asked of them.

import { createRelay, type RelayServer } from '@vzn/vx-dte-server'
import { answer } from './served-relay.js'

/** Run ids: random UUIDs, as the relay takes. */
export const R = '00000000-0000-4000-8000-000000000001'
export const R2 = '00000000-0000-4000-8000-000000000002'

export const servers: RelayServer[] = []
export const realFetch = globalThis.fetch
/** After each test: this process's fetch again, and no relay left serving. */
export async function cleanUp(): Promise<void> {
  globalThis.fetch = realFetch
  for (const s of servers.splice(0)) await s.stop()
}

/** The verbs this process asked the relay for over HTTP. */
export function verbs(): string[] {
  const asked: string[] = []
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    asked.push(/\/(\w+)(\?|$)/.exec(input)![1]!)
    return realFetch(input, init)
  }) as typeof fetch
  return asked
}

/** A relay on Bun.serve whose participants' sockets the test sees, and can drop as a network does. */
export function sockets(
  heartbeatMs?: number,
  options: Partial<Parameters<typeof createRelay>[0]> = {},
) {
  type Held = { key: string; id: string; socket?: { send(t: string): void; close(): void } }
  const open: Bun.ServerWebSocket<Held>[] = []
  const closes: { id: string; code: number }[] = []
  const frames: string[] = []
  /** What the relay answered, as frames down the sockets. */
  const answers: string[] = []
  const reply = (ws: { send(t: string): unknown }, t: string | undefined): void => {
    if (t !== undefined) answers.push(t)
    answer(ws, t)
  }
  /** Whose ping each was. */
  const pings: string[] = []
  /** Each dial's request headers. */
  const dials: Headers[] = []
  /**
   * While `refusing`, the host answers each new dial 503, as one overloaded.
   * Once `forget` is set, the next participant to dial is refused for good.
   * `failJoins`: that many sockets that would join get a bare 500, as a
   * host whose object restarts. `hold`: a redial's upgrade is never
   * answered.
   * `deaf`: the relay's closes never reach the client, as workerd's under
   * Bun 1.4.4 (it ends no TCP, and the client waits 10 s for it).
   */
  const host = {
    refusing: false,
    forget: false,
    forgotten: '',
    failJoins: 0,
    hold: false,
    deaf: false,
    /** Frames of sends the relay takes and loses, as a relay with no queue does. */
    lose: 0,
    /** Each frame of sends reaches the relay twice. */
    twice: false,
    /** A socket's close never reaches the relay, as a network that stops carrying it. */
    halfOpen: false,
  }
  let server: Bun.Server<Held> | undefined
  const relay = createRelay({
    ...options,
    ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    upgrade: (key, id, req) => {
      if (host.forget && host.forgotten === '') host.forgotten = id
      if (host.refusing || id === host.forgotten) return new Response(null, { status: 503 })
      server!.upgrade(req, { data: { key, id } })
      return new Response(null, { status: 101 })
    },
  })
  server = Bun.serve<Held>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) => {
      dials.push(r.headers)
      if (r.url.includes('socket?join=') && host.failJoins > 0) {
        host.failJoins--
        return new Response(null, { status: 500 })
      }
      if (host.hold && r.url.includes('socket?id=')) return new Promise<Response>(() => {})
      return relay.fetch(r)
    },
    websocket: {
      open(ws) {
        open.push(ws)
        ws.data.socket = {
          send: (t) => void ws.send(t),
          close: () => void (host.deaf || ws.close()),
        }
        relay.attach(ws.data.key, ws.data.id, ws.data.socket)
      },
      message(ws, m) {
        if (m === 'ping') pings.push(ws.data.id)
        else {
          frames.push(String(m))
          const f = JSON.parse(String(m)) as { n: number; sends?: unknown[] }
          if (f.sends !== undefined && f.sends.length > 0 && host.lose > 0) {
            host.lose--
            reply(ws, relay.frame(ws.data.key, ws.data.id, JSON.stringify({ n: f.n, sends: [] })))
            return
          }
          if (f.sends !== undefined && f.sends.length > 0 && host.twice)
            relay.frame(ws.data.key, ws.data.id, String(m))
          reply(ws, relay.frame(ws.data.key, ws.data.id, String(m)))
        }
      },
      close(ws, code) {
        closes.push({ id: ws.data.id, code })
        if (!host.halfOpen) relay.detach(ws.data.key, ws.data.id, ws.data.socket!)
      },
    },
  })
  servers.push({
    url: '',
    async stop() {
      await server!.stop(true)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    relay,
    open,
    closes,
    frames,
    answers,
    pings,
    host,
    dials,
  }
}

/** What `p` hears next: a poll returns empty after a quiet heartbeat. */
export async function heard(p: { poll(): Promise<unknown[]> }): Promise<unknown[]> {
  for (;;) {
    const m = await p.poll()
    if (m.length > 0) return m
  }
}

type Held = { key: string; id: string; socket?: { send(t: string): void; close(): void } }

/**
 * A relay whose open sockets of a participant drop what `drop` says, as a
 * host whose object failed answers nothing: `all`, its pings too, or
 * `frames`, while the host itself still answers pings (Cloudflare's
 * auto-response). A socket dialed after works.
 */
export function dropping(): {
  url: string
  drop(id: string, mode: 'all' | 'frames', forever?: boolean): void
  garble(id: string, text: string): void
} {
  const drops = new Map<Bun.ServerWebSocket<Held>, 'all' | 'frames'>()
  /** Participants each socket of which, dialed again too, drops so. */
  const always = new Map<string, 'all' | 'frames'>()
  const open = new Set<Bun.ServerWebSocket<Held>>()
  let server: Bun.Server<Held> | undefined
  const relay = createRelay({
    // A frame waits a heartbeat on its answer, at least 1 s (MIN_WAIT_MS),
    // and the relay loses a participant silent two.
    heartbeatMs: 1_000,
    upgrade: (key, id, req) => {
      server!.upgrade(req, { data: { key, id } })
      return new Response(null, { status: 101 })
    },
  })
  server = Bun.serve<Held>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) => relay.fetch(r),
    websocket: {
      open(ws) {
        open.add(ws)
        const mode = always.get(ws.data.id)
        if (mode !== undefined) drops.set(ws, mode)
        ws.data.socket = {
          send: (t) => {
            if (!drops.has(ws)) ws.send(t)
          },
          close: () => ws.close(),
        }
        relay.attach(ws.data.key, ws.data.id, ws.data.socket)
      },
      message(ws, m) {
        const drop = drops.get(ws)
        if (drop === undefined)
          answer(ws, relay.frame(ws.data.key, ws.data.id, String(m), ws.data.socket))
      },
      close(ws) {
        open.delete(ws)
        // A socket that carries nothing carries no close either.
        if (!drops.has(ws)) relay.detach(ws.data.key, ws.data.id, ws.data.socket!)
      },
    },
  })
  servers.push({
    url: '',
    async stop() {
      await server!.stop(true)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    drop(id, mode, forever = false) {
      if (forever) always.set(id, mode)
      for (const ws of open) if (ws.data.id === id) drops.set(ws, mode)
    },
    /** `text` down `id`'s socket, as no relay frame is. */
    garble(id, text) {
      for (const ws of open) if (ws.data.id === id) ws.send(text)
    },
  }
}
