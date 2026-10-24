// The relay client: joined on the websocket it opens (over HTTP only where
// that socket does not open), everything after down it, dialed again
// whenever it drops.

import { afterEach, expect, it } from 'bun:test'
import { createRelay, serveRelay, type RelayServer } from '@vzn/vx-dte-relay'
import { join, RelayError, unsent } from '../src/wire.js'

/** Run ids: random UUIDs, as the relay takes. */
const R = '00000000-0000-4000-8000-000000000001'
const R2 = '00000000-0000-4000-8000-000000000002'

const servers: RelayServer[] = []
const realFetch = globalThis.fetch
afterEach(async () => {
  globalThis.fetch = realFetch
  for (const s of servers.splice(0)) await s.stop()
})

/** The verbs this process asked the relay for over HTTP. */
function verbs(): string[] {
  const asked: string[] = []
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    asked.push(/\/(\w+)(\?|$)/.exec(input)![1]!)
    return realFetch(input, init)
  }) as typeof fetch
  return asked
}

it('talks over the socket the relay offers: sends, removes and leaves, polling nothing', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  const asked = verbs()
  const o = await join(s.url, R, 'orchestrator', null, undefined)
  const a = await join(s.url, R, 'worker', { size: 'small' }, undefined)
  expect(await o.poll()).toEqual([
    { from: 'relay', body: { type: 'joined', id: a.id, info: { size: 'small' } } },
  ])
  await o.send(a.id, { run: 'x#build' })
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: { run: 'x#build' } }])
  await a.send('orchestrator', 'done')
  expect(await o.poll()).toEqual([{ from: a.id, body: 'done' }])
  await expect(a.send('nobody', 1)).rejects.toThrow('relay send: 404 unknown to')
  await expect(a.remove(o.id)).rejects.toThrow('relay send: 403 only the orchestrator removes')
  const b = await join(s.url, R, 'worker', null, undefined)
  await o.poll()
  await o.remove(b.id)
  await a.leave()
  expect(await o.poll()).toEqual([{ from: 'relay', body: { type: 'lost', id: a.id } }])
  await o.leave()
  // Each joins on the socket it opens: one request a participant, none of it HTTP.
  expect(asked).toEqual([])
})

it('learns from its socket’s close that the relay let it go, asking HTTP nothing', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  const o = await join(s.url, R, 'orchestrator', null, undefined)
  const a = await join(s.url, R, 'worker', null, undefined)
  await o.poll()
  const asked = verbs()
  // Removed by the orchestrator, so the relay closes the worker's socket as gone.
  await o.remove(a.id)
  await expect(a.poll()).rejects.toThrow('relay: unknown id')
  expect(asked).toEqual([])
})

// workerd ends no TCP after it closes a socket, and Bun 1.4.4's client
// fires onclose only once TCP ends: a removed worker heard 4404 10 s late
// (PR #4171). The relay says its close in a frame first.
it('learns it was let go from the frame the relay says it in, not the close', async () => {
  const { url, host } = sockets()
  const o = await join(url, R, 'orchestrator', null, undefined)
  const a = await join(url, R, 'worker', null, undefined)
  await o.poll()
  host.deaf = true
  const t0 = performance.now()
  await o.remove(a.id)
  await expect(a.poll()).rejects.toThrow('relay: unknown id')
  expect(performance.now() - t0).toBeLessThan(1_000)
}, 3_000)

/** A relay on Bun.serve whose participants' sockets the test sees, and can drop as a network does. */
function sockets(heartbeatMs?: number, options: Partial<Parameters<typeof createRelay>[0]> = {}) {
  type Held = { key: string; id: string; socket?: { send(t: string): void; close(): void } }
  const open: Bun.ServerWebSocket<Held>[] = []
  const closes: { id: string; code: number }[] = []
  const frames: string[] = []
  /** Whose ping each was. */
  const pings: string[] = []
  /**
   * While `refusing`, the host answers each new dial 503, as one overloaded.
   * Once `forget` is set, the next participant to dial is refused for good.
   * `older`: a socket that would join is refused, as a relay before
   * PROTOCOL.md's `socket?join` refuses it, so each joins over HTTP.
   * `deaf`: the relay's closes never reach the client, as workerd's under
   * Bun 1.4.4 (it ends no TCP, and the client waits 10 s for it).
   */
  const host = { refusing: false, forget: false, forgotten: '', older: false, deaf: false }
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
    fetch: (r) =>
      host.older && r.url.includes('socket?join=')
        ? new Response(null, { status: 404 })
        : relay.fetch(r),
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
        if (m === 'ping') {
          pings.push(ws.data.id)
          relay.seen(ws.data.key, ws.data.id, Date.now())
          ws.send('pong')
        } else {
          frames.push(String(m))
          ws.send(relay.frame(ws.data.key, ws.data.id, String(m)))
        }
      },
      close(ws, code) {
        closes.push({ id: ws.data.id, code })
        relay.detach(ws.data.key, ws.data.id, ws.data.socket!)
      },
    },
  })
  servers.push({
    url: '',
    async stop() {
      relay.close()
      await server!.stop(true)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, relay, open, closes, frames, pings, host }
}

// Each ping is a message a relay host may bill: at two a heartbeat they
// were nearly all of a run's (2026-10-23), so none goes in a half
// heartbeat a frame went in. Quiet, the relay is asked: a frame it must
// answer each heartbeat (owner, 2026-10-23: "if not ask to send"). Frames
// go every 50 ms, a tenth of the heartbeat.
it('asks a quiet relay each heartbeat, and pings only while it hears, not while it frames', async () => {
  const { url, pings, frames } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  pings.length = 0
  frames.length = 0
  await Bun.sleep(2_600)
  // Quiet, most half heartbeats are a frame or the one after it.
  const quiet = pings.filter((id) => id === a.id).length
  const asked = frames.filter((f) => f.includes('"sends":[]')).length
  pings.length = 0
  const t = performance.now()
  for (let i = 0; performance.now() - t < 2_000; i++) {
    await a.send('orchestrator', i)
    await Bun.sleep(50)
  }
  expect([quiet <= 3, asked >= 4, pings.filter((id) => id === a.id)]).toEqual([true, true, []])
  await a.leave()
  await o.leave()
}, 15_000)

it('joins again when its first socket does not open', async () => {
  // A relay that made a run twice for two joins at once forgot the first
  // one's participants: their first socket never opened (CI, 2026-10-23).
  const { url, host } = sockets()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  host.forget = true
  const a = await join(url, R2, 'worker', null, undefined)
  expect(a.id).not.toBe(host.forgotten)
  const told = await o.poll()
  expect(told.map((m) => (m.body as { id: string }).id)).toContain(a.id)
  await o.send(a.id, 'hi')
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: 'hi' }])
  await a.leave()
  await o.leave()
})

it('keeps its quiet socket while a new one fails to open, so the relay keeps it', async () => {
  // A worker busy on long tasks heard nothing for three heartbeats, closed
  // its socket, and its next dial failed: the relay lost it and the run ran
  // its task again elsewhere (CI, 2026-10-23).
  const { url, open, host } = sockets(200)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  host.refusing = true
  const first = open.find((w) => w.data.id === a.id)!
  // Quiet well past twelve heartbeats, every dial refused.
  for (let i = 0; i < 16; i++) expect(await a.poll()).toEqual([])
  expect(first.readyState).toBe(1)
  await o.send(a.id, 'still here')
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: 'still here' }])
  host.refusing = false
  await a.leave()
  await o.leave()
})

it('dials its socket again after it drops, and gets what queued meanwhile', async () => {
  const { url, open } = sockets()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  const workerSockets = () => open.filter((w) => w.data.id === a.id)
  const asked = verbs()
  workerSockets()[0]!.close()
  await o.send(a.id, 'while down')
  // A poll the socket's close wakes may come back empty; the next waits on the redial.
  const got = await a.poll()
  expect(got.length > 0 ? got : await a.poll()).toEqual([
    { from: 'orchestrator', body: 'while down' },
  ])
  expect(workerSockets()).toHaveLength(2)
  await a.send('orchestrator', 'back')
  expect(await o.poll()).toEqual([{ from: a.id, body: 'back' }])
  expect(asked).toEqual([])
  await a.leave()
  await o.leave()
})

it('leaves only once its socket has closed, so exiting next cuts nothing', async () => {
  // A socket a process exits under before its close handshake is cut: the
  // host logs a client that disconnected. The relay closes a worker's
  // socket once it told it the run closed; its leave then cuts nothing.
  const closed: WebSocket[] = []
  const Real = globalThis.WebSocket
  globalThis.WebSocket = class extends Real {
    constructor(...args: ConstructorParameters<typeof Real>) {
      super(...args)
      this.addEventListener('close', () => closed.push(this))
    }
  } as typeof WebSocket
  try {
    const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
    servers.push(s)
    const o = await join(s.url, R2, 'orchestrator', null, undefined)
    const a = await join(s.url, R2, 'worker', null, undefined)
    await o.poll()
    await o.leave()
    expect(await a.poll()).toEqual([{ from: 'relay', body: { type: 'closed' } }])
    await a.leave()
    // Only this relay's: a participant another test left dialing may close one meanwhile.
    const port = new URL(s.url).port
    expect(closed.filter((w) => new URL(w.url).port === port)).toHaveLength(2)
  } finally {
    globalThis.WebSocket = Real
  }
})

it('sends asked for together go as one frame, each answered', async () => {
  const { url, frames } = sockets()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  const sent = await Promise.allSettled([o.send(a.id, 1), o.send('nobody', 2), o.send(a.id, 3)])
  expect(sent.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message))).toEqual([
    'ok',
    'relay send: 404 unknown to',
    'ok',
  ])
  expect(frames).toHaveLength(1)
  expect(await a.poll()).toEqual([
    { from: 'orchestrator', body: 1 },
    { from: 'orchestrator', body: 3 },
  ])
  await a.leave()
  await o.leave()
})

it('refuses a relay that offers no socket', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ id: 'p1', heartbeatMs: 100 }),
  })
  servers.push({ url: '', stop: () => server.stop(true) })
  await expect(
    join(`http://127.0.0.1:${server.port}`, R, 'worker', null, undefined),
  ).rejects.toThrow('the relay offers no socket')
})

it('asks for a new token a minute before the one it holds expires', async () => {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const jwt = (inS: number): string => `${b64({})}.${b64({ exp: Date.now() / 1000 + inS })}.x`
  const { url, host } = sockets(undefined, { verify: async () => ({ iss: 'i', run: ['1'] }) })
  // Several requests a participant, to tell one token from several.
  host.older = true
  // A worker joins a run its orchestrator started.
  await join(url, R, 'orchestrator', null, async () => jwt(300))
  const asked = async (inS: number): Promise<number> => {
    let n = 0
    const me = await join(url, R, 'worker', null, async () => (n++, jwt(inS)))
    await me.leave()
    return n
  }
  // The socket that would join, its join and its socket's: once, or each time.
  expect([await asked(300), await asked(30)]).toEqual([1, 3])
})

it('waits out the relay’s rate limit and joins again', async () => {
  const s = sockets()
  s.host.older = true
  await join(s.url, R, 'orchestrator', null, undefined)
  let limited = 0
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    input.endsWith('/join') && limited++ === 0
      ? Promise.resolve(Response.json({ error: 'rate limited', retryAfterMs: 30 }, { status: 429 }))
      : realFetch(input, init)) as typeof fetch
  const at = Date.now()
  const a = await join(s.url, R, 'worker', null, undefined)
  expect([limited, Date.now() - at >= 25]).toEqual([2, true])
  await a.leave()
})

type Held = { key: string; id: string; socket?: { send(t: string): void; close(): void } }

/**
 * A relay whose open sockets of a participant drop what `drop` says, as a
 * host whose object failed answers nothing: `all`, its pings too, or
 * `frames`, while the host itself still answers pings (Cloudflare's
 * auto-response). A socket dialed after works.
 */
function dropping(): {
  url: string
  drop(id: string, mode: 'all' | 'frames'): void
  forget(id: string): void
  garble(id: string, text: string): void
} {
  const drops = new Map<Bun.ServerWebSocket<Held>, 'all' | 'frames'>()
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
        if (m === 'ping') {
          if (drop === 'all') return
          relay.seen(ws.data.key, ws.data.id, Date.now())
          ws.send('pong')
        } else if (drop === undefined)
          ws.send(relay.frame(ws.data.key, ws.data.id, String(m), ws.data.socket))
      },
      close(ws) {
        open.delete(ws)
        relay.detach(ws.data.key, ws.data.id, ws.data.socket!)
      },
    },
  })
  servers.push({
    url: '',
    async stop() {
      relay.close()
      await server!.stop(true)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    drop(id, mode) {
      for (const ws of open) if (ws.data.id === id) drops.set(ws, mode)
    },
    /** The relay lets `id`'s socket go, which stays open and answers its pings. */
    forget(id) {
      for (const ws of open) if (ws.data.id === id) relay.detach(ws.data.key, id, ws.data.socket!)
    },
    /** `text` down `id`'s socket, as no relay frame is. */
    garble(id, text) {
      for (const ws of open) if (ws.data.id === id) ws.send(text)
    },
  }
}

// A relay is anyone's to host: a frame that is not its protocol threw out of
// the socket's handler, and the process exited 1 on a bare SyntaxError.
it('ends on a frame that is not the relay’s, and says what it was', async () => {
  for (const text of ['<html>bad gateway</html>', 'null']) {
    const { url, garble } = dropping()
    const o = await join(url, R2, 'orchestrator', null, undefined)
    const a = await join(url, R2, 'worker', null, undefined)
    await o.poll()
    garble(a.id, text)
    let err: unknown
    for (let i = 0; i < 10 && err === undefined; i++)
      await a.poll().catch((e: unknown) => (err = e))
    expect(err).toBeInstanceOf(RelayError)
    expect((err as RelayError).message).toBe(`relay: a frame that is not its protocol: ${text}`)
    await o.leave()
  }
}, 5_000)

// A socket a network stops carrying sends no close: on a CI runner a worker's
// `held` frames waited on acks that never came, its lease lapsed mid-task, and
// its polls read nothing while the relay queued its next batch (2026-10-22).
it('drops a socket the relay stopped answering, and carries on over a new one', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  drop(a.id, 'all')
  await a.send('orchestrator', 'held')
  const got = []
  for (let i = 0; i < 10 && got.length === 0; i++) got.push(...(await o.poll()))
  expect(got).toEqual([{ from: a.id, body: 'held' }])
  await o.send(a.id, 'batch')
  const read = []
  for (let i = 0; i < 10 && read.length === 0; i++) read.push(...(await a.poll()))
  expect(read).toEqual([{ from: 'orchestrator', body: 'batch' }])
  await a.leave()
  await o.leave()
}, 5_000)

// Main 13baaf6: the relay let the orchestrator's socket go while its host
// still answered its pings, and it heard nothing for 8 min (2026-10-23).
it('hears again within a few heartbeats when the relay lets its socket go', async () => {
  const { url, forget } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  await a.poll()
  forget(a.id)
  await o.send(a.id, 'task')
  const at = performance.now()
  const got = []
  for (let i = 0; i < 10 && got.length === 0; i++) got.push(...(await a.poll()))
  expect(got).toEqual([{ from: 'orchestrator', body: 'task' }])
  // A quiet heartbeat, then the beat the relay answers.
  expect(performance.now() - at).toBeLessThan(2_500)
  await a.leave()
  await o.leave()
}, 5_000)

// A Cloudflare relay over its daily limit still answers pings, which the
// host does without the object, but no frame: a send waited for its
// answer forever, and the run with it (CI on #3888, 2026-10-22).
it('sends again on a new socket when one answers pings but not frames', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  await a.poll()
  drop(a.id, 'frames')
  await a.send('orchestrator', 'result')
  const read = []
  for (let i = 0; i < 10 && read.length === 0; i++) read.push(...(await o.poll()))
  expect(read).toEqual([{ from: a.id, body: 'result' }])
  await o.leave()
  await a.leave()
}, 5_000)

it('leaves when its socket answers pings but not frames: the run still closes', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  drop(o.id, 'frames')
  await o.leave()
  const read = []
  for (let i = 0; i < 20 && read.length === 0; i++) read.push(...(await a.poll()))
  expect(read).toEqual([{ from: 'relay', body: { type: 'closed' } }])
  await a.leave()
}, 5_000)

// A relay that held a poll left the run waiting on Bun's own five-minute
// limit before it failed (CI, 2026-10-22): an upgrade held past three
// heartbeats is a dial that failed, and no socket for three is the end.
it('gives up on a socket upgrade the relay holds, after 3 dials', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) =>
      r.url.includes('/join')
        ? Response.json({ id: 'p1', heartbeatMs: 100, socket: true })
        : r.url.includes('socket?join=')
          ? new Response(null, { status: 404 })
          : new Promise<Response>(() => {}),
  })
  servers.push({ url: '', stop: () => server.stop(true) })
  const at = performance.now()
  const o = await join(`http://127.0.0.1:${server.port}`, R, 'orchestrator', null, undefined)
  await expect(o.poll()).rejects.toThrow('no socket in 3 dials')
  expect(performance.now() - at).toBeLessThan(6_000)
}, 10_000)

// Cloudflare answers 5xx while a Durable Object restarts, and a runner's
// network drops a connection now and then: one such answer to a worker's
// request ended the worker and lost what it ran (2026-10-22).
it('dials again through a relay fault shorter than three heartbeats', async () => {
  let faults = 0
  let fail = false
  let server: Bun.Server<{ key: string; id: string }> | undefined
  const relay = createRelay({
    heartbeatMs: 200,
    upgrade: (key, id, req) => {
      server!.upgrade(req, { data: { key, id } })
      return new Response(null, { status: 101 })
    },
  })
  const held = new Map<string, Bun.ServerWebSocket<{ key: string; id: string }>>()
  server = Bun.serve<{ key: string; id: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      if (fail && req.url.includes('/socket') && faults++ < 3)
        return new Response('upstream', { status: 503 })
      return relay.fetch(req)
    },
    websocket: {
      open(ws) {
        held.set(ws.data.id, ws)
        relay.attach(ws.data.key, ws.data.id, ws)
      },
      message(ws, m) {
        if (m === 'ping') ws.send('pong')
        else ws.send(relay.frame(ws.data.key, ws.data.id, String(m)))
      },
      close(ws) {
        relay.detach(ws.data.key, ws.data.id, ws)
      },
    },
  })
  servers.push({
    url: '',
    async stop() {
      relay.close()
      await server!.stop(true)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const o = await join(url, R, 'orchestrator', null, undefined)
  const a = await join(url, R, 'worker', null, undefined)
  await o.poll()
  fail = true
  held.get(a.id)!.close()
  await a.send('orchestrator', 'once')
  expect(faults).toBe(4)
  expect(await o.poll()).toEqual([{ from: a.id, body: 'once' }])
  await a.leave()
  await o.leave()
})

it('gives up on a relay down after 3 dials, not a wait', async () => {
  const { url, open } = sockets(50)
  let down = false
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    down
      ? Promise.resolve(new Response('', { status: 502 }))
      : realFetch(input, init)) as typeof fetch
  const Real = globalThis.WebSocket
  try {
    await join(url, R, 'orchestrator', null, undefined)
    const a = await join(url, R, 'worker', null, undefined)
    down = true
    // Its upgrades fail as the relay's host is down.
    globalThis.WebSocket = class extends Real {
      constructor(u: string | URL, o?: unknown) {
        super(String(u).replace(/:\d+\//, ':1/'), o as never)
      }
    } as typeof WebSocket
    const at = performance.now()
    for (const w of open) if (w.data.id === a.id) w.close()
    const polls = async (): Promise<never> => {
      for (;;) await a.poll()
    }
    await expect(polls()).rejects.toThrow('no socket in 3 dials')
    expect(performance.now() - at).toBeLessThan(2_000)
  } finally {
    globalThis.WebSocket = Real
  }
})

// Sends asked for in one tick went as one frame, which the relay refused
// whole once they passed its 1 MiB body limit together (2026-10-22).
it('sends asked for together that would pass the relay’s body limit go as several frames', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  const o = await join(s.url, R, 'orchestrator', null, undefined)
  const a = await join(s.url, R, 'worker', null, undefined)
  await o.poll()
  const big = 'x'.repeat(600_000)
  await Promise.all([o.send(a.id, big), o.send(a.id, big), o.send(a.id, 'small')])
  const got = []
  for (let i = 0; i < 10 && got.length < 3; i++) got.push(...(await a.poll()))
  expect(got.map((m) => (m.body as string).length)).toEqual([600_000, 600_000, 5])
  await expect(o.send(a.id, 'x'.repeat(1 << 20))).rejects.toThrow('relay send: 413 body over 1 MiB')
  await a.leave()
  await o.leave()
})

// One 500 from the relay's host on join failed a whole CI run before any
// task started (PR #3911, 2026-10-22): join asks again.
it('joins again after the relay answers 5xx or the network drops', async () => {
  const s = sockets()
  s.host.older = true
  let failures = 0
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    if (input.endsWith('/join') && failures < 2) {
      failures++
      return failures === 1
        ? Promise.resolve(new Response('{}', { status: 500 }))
        : Promise.reject(new TypeError('fetch failed'))
    }
    return realFetch(input, init)
  }) as typeof fetch
  const o = await join(s.url, R, 'orchestrator', null, undefined)
  expect([failures, typeof o.id]).toEqual([2, 'string'])
  await o.leave()
})

// A run its relay did not admit fails at once, naming the relay (owner,
// 2026-10-23); a refusal is never waited out as a fault is.
it('does not join again after a 4xx, and names the relay that refused it', async () => {
  const s = sockets()
  s.host.older = true
  let asked = 0
  globalThis.fetch = (() => {
    asked++
    return Promise.resolve(
      Response.json({ error: "repository o/r is not in this relay's ALLOW" }, { status: 403 }),
    )
  }) as unknown as typeof fetch
  await expect(join(s.url, R, 'worker', null, undefined)).rejects.toThrow(
    `cannot connect to the relay ${new URL(s.url).origin}: repository o/r is not in this relay's ALLOW`,
  )
  expect(asked).toBe(1)
})

// PR #4225's run (2026-10-24): a relay that held the socket and then the
// request took 10 s each, and the run failed after 21 s on a bare "The
// operation timed out".
it('gives up on a relay that answers nothing in 10 s in all, and names it', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  })
  servers.push({ url: '', stop: () => server.stop(true) })
  const url = `http://127.0.0.1:${server.port}`
  const at = performance.now()
  await expect(join(url, R, 'worker', null, undefined)).rejects.toThrow(
    `cannot connect to the relay ${url}: no answer in 10 s`,
  )
  expect(performance.now() - at).toBeLessThan(11_000)
}, 25_000)

// M, 2026-10-23: a remote fault is at least a warning. Every send the
// orchestrator and a worker make unawaited dropped its error.
it('a send the relay would not take is said; one to a participant it lost is not', () => {
  const said: string[] = []
  const warn = (m: string): void => void said.push(m)
  unsent(warn, 'welcome', 'small#1')(new RelayError(503, 'relay: 503 overloaded'))
  unsent(warn, 'exit', 'small#2')(new RelayError(404, 'relay: unknown id'))
  unsent(warn, 'ran', 'the orchestrator')(new Error('socket closed'))
  expect(said).toEqual([
    'dte: sending welcome to small#1 failed: relay: 503 overloaded',
    'dte: sending ran to the orchestrator failed: socket closed',
  ])
})
