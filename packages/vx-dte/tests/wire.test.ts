// The relay client: `join` over HTTP, everything after over the websocket,
// dialed again whenever it drops.

import { afterEach, expect, it } from 'bun:test'
import { createRelay, serveRelay, type RelayServer } from '@vzn/vx-dte-relay'
import { join } from '../src/wire.js'

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
  const a = await join(s.url, R, 'agent', { size: 'small' }, undefined)
  expect(await o.poll()).toEqual([
    { from: 'relay', body: { type: 'joined', id: a.id, info: { size: 'small' } } },
  ])
  await o.send(a.id, { run: 'x#build' })
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: { run: 'x#build' } }])
  await a.send('orchestrator', 'done')
  expect(await o.poll()).toEqual([{ from: a.id, body: 'done' }])
  await expect(a.send('nobody', 1)).rejects.toThrow('relay send: 404 unknown to')
  await expect(a.remove(o.id)).rejects.toThrow('relay send: 403 only the orchestrator removes')
  const b = await join(s.url, R, 'agent', null, undefined)
  await o.poll()
  await o.remove(b.id)
  await a.leave()
  expect(await o.poll()).toEqual([{ from: 'relay', body: { type: 'lost', id: a.id } }])
  await o.leave()
  // Join opens the session; all else, leaving and removing too, goes down the socket.
  expect(asked).toEqual(['join', 'join', 'join'])
})

it('learns from its socket’s close that the relay let it go, asking HTTP nothing', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  const o = await join(s.url, R, 'orchestrator', null, undefined)
  const a = await join(s.url, R, 'agent', null, undefined)
  await o.poll()
  const asked = verbs()
  // Removed by the orchestrator, so the relay closes the agent's socket as gone.
  await o.remove(a.id)
  await expect(a.poll()).rejects.toThrow('relay: unknown id')
  expect(asked).toEqual([])
})

/** A relay on Bun.serve whose participants' sockets the test sees, and can drop as a network does. */
function sockets(heartbeatMs?: number, options: Partial<Parameters<typeof createRelay>[0]> = {}) {
  type Held = { key: string; id: string; socket?: { send(t: string): void; close(): void } }
  const open: Bun.ServerWebSocket<Held>[] = []
  const closes: { id: string; code: number }[] = []
  const frames: string[] = []
  let server: Bun.Server<Held> | undefined
  const relay = createRelay({
    ...options,
    ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
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
        open.push(ws)
        ws.data.socket = { send: (t) => void ws.send(t), close: () => ws.close() }
        relay.attach(ws.data.key, ws.data.id, ws.data.socket)
      },
      message(ws, m) {
        if (m === 'ping') ws.send('pong')
        else {
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
  return { url: `http://127.0.0.1:${server.port}`, relay, open, closes, frames }
}

it('dials anew once its socket goes quiet, and gets what the relay queued', async () => {
  // A relay whose push failed queued and left the socket open, its pings
  // answered: the agent heard nothing again (CI, 2026-10-23).
  const { url, relay, open } = sockets(200)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
  await o.poll()
  const agentSockets = () => open.filter((w) => w.data.id === a.id)
  const first = agentSockets()[0]!
  relay.detach(first.data.key, a.id, first.data.socket!)
  const asked = verbs()
  await o.send(a.id, 'queued')
  const got = []
  for (let i = 0; i < 20 && got.length === 0; i++) got.push(...(await a.poll()))
  expect(got).toEqual([{ from: 'orchestrator', body: 'queued' }])
  expect(agentSockets()).toHaveLength(2)
  await o.send(a.id, 'pushed')
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: 'pushed' }])
  expect(asked).toEqual([])
  await a.leave()
  await o.leave()
})

it('dials its socket again after it drops, and gets what queued meanwhile', async () => {
  const { url, open } = sockets()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
  await o.poll()
  const agentSockets = () => open.filter((w) => w.data.id === a.id)
  const asked = verbs()
  agentSockets()[0]!.close()
  await o.send(a.id, 'while down')
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: 'while down' }])
  expect(agentSockets()).toHaveLength(2)
  await a.send('orchestrator', 'back')
  expect(await o.poll()).toEqual([{ from: a.id, body: 'back' }])
  expect(asked).toEqual([])
  await a.leave()
  await o.leave()
})

it('leaves only once its socket has closed, so exiting next cuts nothing', async () => {
  // A socket a process exits under before its close handshake is cut: the
  // host logs a client that disconnected. The relay closes an agent's
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
    const a = await join(s.url, R2, 'agent', null, undefined)
    await o.poll()
    await o.leave()
    expect(await a.poll()).toEqual([{ from: 'relay', body: { type: 'closed' } }])
    await a.leave()
    expect(closed).toHaveLength(2)
  } finally {
    globalThis.WebSocket = Real
  }
})

it('sends asked for together go as one frame, each answered', async () => {
  const { url, frames } = sockets()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
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
    join(`http://127.0.0.1:${server.port}`, R, 'agent', null, undefined),
  ).rejects.toThrow('the relay offers no socket')
})

it('asks for a new token a minute before the one it holds expires', async () => {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const jwt = (inS: number): string => `${b64({})}.${b64({ exp: Date.now() / 1000 + inS })}.x`
  const { url } = sockets(undefined, { verify: async () => ({ iss: 'i', run: ['1'] }) })
  const asked = async (inS: number): Promise<number> => {
    let n = 0
    const me = await join(url, R, 'agent', null, async () => (n++, jwt(inS)))
    await me.leave()
    return n
  }
  // Its join and its socket's upgrade: once, or each time.
  expect([await asked(300), await asked(30)]).toEqual([1, 2])
})

it('waits out the relay’s rate limit and joins again', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  let limited = 0
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    input.endsWith('/join') && limited++ === 0
      ? Promise.resolve(Response.json({ error: 'rate limited', retryAfterMs: 30 }, { status: 429 }))
      : realFetch(input, init)) as typeof fetch
  const at = Date.now()
  const a = await join(s.url, R, 'agent', null, undefined)
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
function dropping(): { url: string; drop(id: string, mode: 'all' | 'frames'): void } {
  const drops = new Map<Bun.ServerWebSocket<Held>, 'all' | 'frames'>()
  const open = new Set<Bun.ServerWebSocket<Held>>()
  let server: Bun.Server<Held> | undefined
  const relay = createRelay({
    heartbeatMs: 100,
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
        } else if (drop === undefined) ws.send(relay.frame(ws.data.key, ws.data.id, String(m)))
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
  }
}

// A socket a network stops carrying sends no close: on a CI runner an agent's
// `held` frames waited on acks that never came, its lease lapsed mid-task, and
// its polls read nothing while the relay queued its next batch (2026-10-22).
it('drops a socket the relay stopped answering, and carries on over a new one', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
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

// A Cloudflare relay over its daily limit still answers pings, which the
// host does without the object, but no frame: a send waited for its
// answer forever, and the run with it (CI on #3888, 2026-10-22).
it('sends again on a new socket when one answers pings but not frames', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
  await o.poll()
  drop(o.id, 'frames')
  await o.send(a.id, 'batch')
  const read = []
  for (let i = 0; i < 10 && read.length === 0; i++) read.push(...(await a.poll()))
  expect(read).toEqual([{ from: 'orchestrator', body: 'batch' }])
  await o.leave()
  await a.leave()
}, 5_000)

it('leaves when its socket answers pings but not frames: the run still closes', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
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
it('gives up on a socket upgrade the relay holds past three heartbeats', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) =>
      r.url.includes('/join')
        ? Response.json({ id: 'p1', heartbeatMs: 100, socket: true })
        : new Promise<Response>(() => {}),
  })
  servers.push({ url: '', stop: () => server.stop(true) })
  const at = performance.now()
  const o = await join(`http://127.0.0.1:${server.port}`, R, 'orchestrator', null, undefined)
  await expect(o.poll()).rejects.toThrow('no socket for three heartbeats')
  expect(performance.now() - at).toBeLessThan(3_000)
}, 5_000)

// Cloudflare answers 5xx while a Durable Object restarts, and a runner's
// network drops a connection now and then: one such answer to an agent's
// request ended the agent and lost what it ran (2026-10-22).
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
  const a = await join(url, R, 'agent', null, undefined)
  await o.poll()
  fail = true
  held.get(a.id)!.close()
  await a.send('orchestrator', 'once')
  expect(faults).toBe(4)
  expect(await o.poll()).toEqual([{ from: a.id, body: 'once' }])
  await a.leave()
  await o.leave()
})

it('gives up on a relay down for three heartbeats', async () => {
  const { url, open } = sockets(50)
  let down = false
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    down
      ? Promise.resolve(new Response('', { status: 502 }))
      : realFetch(input, init)) as typeof fetch
  const Real = globalThis.WebSocket
  try {
    const a = await join(url, R, 'agent', null, undefined)
    down = true
    // Its upgrades fail as the relay's host is down.
    globalThis.WebSocket = class extends Real {
      constructor(u: string | URL, o?: unknown) {
        super(String(u).replace(/:\d+\//, ':1/'), o as never)
      }
    } as typeof WebSocket
    const at = performance.now()
    for (const w of open) w.close()
    const polls = async (): Promise<never> => {
      for (;;) await a.poll()
    }
    await expect(polls()).rejects.toThrow('no socket for three heartbeats')
    expect(performance.now() - at).toBeGreaterThanOrEqual(140)
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
  const a = await join(s.url, R, 'agent', null, undefined)
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
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
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

it('does not join again after a 4xx', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  let asked = 0
  globalThis.fetch = (() => {
    asked++
    return Promise.resolve(new Response('{"error":"no"}', { status: 403 }))
  }) as unknown as typeof fetch
  await expect(join(s.url, R, 'agent', null, undefined)).rejects.toThrow('relay join: 403 no')
  expect(asked).toBe(1)
})
