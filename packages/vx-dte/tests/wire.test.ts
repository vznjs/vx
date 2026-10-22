// The relay client: over the websocket a relay offers, and over HTTP polls
// when it offers none or the socket goes, until it dials the socket again.

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

it('polls over HTTP once its socket is gone', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  const o = await join(s.url, R, 'orchestrator', null, undefined)
  const a = await join(s.url, R, 'agent', null, undefined)
  await o.poll()
  // Left by HTTP alone, so the relay closes the agent's socket and its next poll asks HTTP.
  await realFetch(`${s.url}/v1/runs/${R}/leave`, {
    method: 'POST',
    body: JSON.stringify({ id: a.id }),
  })
  expect(await o.poll()).toEqual([{ from: 'relay', body: { type: 'lost', id: a.id } }])
  const asked = verbs()
  await expect(a.poll()).rejects.toThrow('relay poll: 404 unknown id')
  expect(asked).toEqual(['poll'])
})

/** A relay on Bun.serve whose participants' sockets the test sees, and can drop as a network does. */
function sockets(framesV2 = true) {
  type Held = { key: string; id: string; socket?: { send(t: string): void; close(): void } }
  const open: Bun.ServerWebSocket<Held>[] = []
  const closes: { id: string; code: number }[] = []
  const frames: string[] = []
  let server: Bun.Server<Held> | undefined
  const relay = createRelay({
    upgrade: (key, id, req) => {
      server!.upgrade(req, { data: { key, id } })
      return new Response(null, { status: 101 })
    },
  })
  server = Bun.serve<Held>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (r) => {
      const res = await relay.fetch(r)
      if (framesV2 || !r.url.endsWith('/join')) return res
      // A relay from before `frames` 2.
      const { frames: _, ...json } = (await res.json()) as Record<string, unknown>
      return Response.json(json, { status: res.status })
    },
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
  return { url: `http://127.0.0.1:${server.port}`, open, closes, frames }
}

it('dials its socket again after it drops, and is back off HTTP', async () => {
  const { url, open } = sockets()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
  await o.poll()
  const agentSockets = () => open.filter((w) => w.data.id === a.id)
  agentSockets()[0]!.close()
  await o.send(a.id, 'while down')
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: 'while down' }])
  for (let i = 0; i < 100 && agentSockets().length < 2; i++) await Bun.sleep(20)
  expect(agentSockets()).toHaveLength(2)
  const asked = verbs()
  await o.send(a.id, 'back')
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: 'back' }])
  expect(asked).toEqual([])
  await a.leave()
  await o.leave()
})

it('leaves only once its socket has closed, so exiting next cuts nothing', async () => {
  // A socket a process exits under before its close handshake is cut: the
  // host logs a client that disconnected. An agent of a run that closed
  // leaves with its socket still open, so its leave closes it.
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
    expect(closed).toHaveLength(1)
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

it('to a relay without frames 2, sends one by one and leaves over HTTP', async () => {
  const { url, frames } = sockets(false)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
  await o.poll()
  await Promise.all([o.send(a.id, 1), o.send(a.id, 2)])
  expect(frames.map((f) => Object.keys(JSON.parse(f) as object))).toEqual([
    ['n', 'to', 'body'],
    ['n', 'to', 'body'],
  ])
  const asked = verbs()
  await a.leave()
  await o.leave()
  expect(asked).toEqual(['leave', 'leave'])
})

it('polls a relay that offers no socket', async () => {
  const relay = createRelay()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => relay.fetch(r) })
  servers.push({
    url: '',
    async stop() {
      relay.close()
      await server.stop(true)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const asked = verbs()
  const o = await join(url, R, 'orchestrator', null, undefined)
  const a = await join(url, R, 'agent', null, undefined)
  expect(await o.poll()).toEqual([
    { from: 'relay', body: { type: 'joined', id: a.id, info: null } },
  ])
  expect(asked).toEqual(['join', 'join', 'poll'])
})

it('asks for a new token a minute before the one it holds expires', async () => {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const jwt = (inS: number): string => `${b64({})}.${b64({ exp: Date.now() / 1000 + inS })}.x`
  const relay = createRelay({ heartbeatMs: 20, verify: async () => ({ iss: 'i', run: ['1'] }) })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => relay.fetch(r) })
  servers.push({
    url: '',
    async stop() {
      relay.close()
      await server.stop(true)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const asked = async (inS: number): Promise<number> => {
    let n = 0
    const me = await join(url, R, 'agent', null, async () => (n++, jwt(inS)))
    await me.poll()
    await me.poll()
    return n
  }
  expect([await asked(300), await asked(30)]).toEqual([1, 3])
})

it('waits out the relay’s rate limit and sends again', async () => {
  const relay = createRelay({ heartbeatMs: 20 })
  let limited = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      if (req.url.endsWith('/send') && limited++ === 0) {
        return Response.json({ error: 'rate limited', retryAfterMs: 30 }, { status: 429 })
      }
      return relay.fetch(req)
    },
  })
  servers.push({
    url: '',
    async stop() {
      relay.close()
      await server.stop(true)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const o = await join(url, R, 'orchestrator', null, undefined)
  const a = await join(url, R, 'agent', null, undefined)
  const at = Date.now()
  await a.send('orchestrator', 'once')
  expect(Date.now() - at).toBeGreaterThanOrEqual(25)
  const got = [...(await o.poll()), ...(await o.poll())].filter((m) => m.from === a.id)
  expect(got).toEqual([{ from: a.id, body: 'once' }])
})

type Held = { key: string; id: string; socket?: { send(t: string): void; close(): void } }

/**
 * A relay whose sockets drop what `drops` says, as a host whose object
 * failed answers nothing: `all`, its pings too, or `frames`, while the
 * host itself still answers pings (Cloudflare's auto-response).
 */
function dropping(drops: Map<string, 'all' | 'frames'>): string {
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
        ws.data.socket = {
          send: (t) => {
            if (!drops.has(ws.data.id)) ws.send(t)
          },
          close: () => ws.close(),
        }
        relay.attach(ws.data.key, ws.data.id, ws.data.socket)
      },
      message(ws, m) {
        const drop = drops.get(ws.data.id)
        if (m === 'ping') {
          if (drop === 'all') return
          relay.seen(ws.data.key, ws.data.id, Date.now())
          ws.send('pong')
        } else if (drop === undefined) ws.send(relay.frame(ws.data.key, ws.data.id, String(m)))
      },
      close(ws) {
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
  return `http://127.0.0.1:${server.port}`
}

// A socket a network stops carrying sends no close: on a CI runner an agent's
// `held` frames waited on acks that never came, its lease lapsed mid-task, and
// its polls read nothing while the relay queued its next batch (2026-10-22).
it('drops a socket the relay stopped answering, and carries on over HTTP', async () => {
  const drops = new Map<string, 'all' | 'frames'>()
  const url = dropping(drops)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
  await o.poll()
  drops.set(a.id, 'all')
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
it('sends over HTTP when the socket answers pings but not frames', async () => {
  const drops = new Map<string, 'all' | 'frames'>()
  const url = dropping(drops)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
  await o.poll()
  drops.set(o.id, 'frames')
  await o.send(a.id, 'batch')
  const read = []
  for (let i = 0; i < 10 && read.length === 0; i++) read.push(...(await a.poll()))
  expect(read).toEqual([{ from: 'orchestrator', body: 'batch' }])
  await o.leave()
  await a.leave()
}, 5_000)

it('leaves over HTTP when the socket answers pings but not frames', async () => {
  const drops = new Map<string, 'all' | 'frames'>()
  const url = dropping(drops)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'agent', null, undefined)
  await o.poll()
  drops.set(o.id, 'frames')
  // The run closes, and its agents learn it.
  await o.leave()
  expect(await a.poll()).toEqual([{ from: 'relay', body: { type: 'closed' } }])
  await a.leave()
}, 5_000)

// A relay that held a poll left the run waiting on Bun's own five-minute
// limit before it failed (CI, 2026-10-22): a request past three heartbeats
// is a failure the run counts.
it('gives up on a request the relay holds past three heartbeats', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) =>
      r.url.includes('/join')
        ? Response.json({ id: 'p1', heartbeatMs: 100 })
        : new Promise<Response>(() => {}),
  })
  servers.push({ url: '', stop: () => server.stop(true) })
  const o = await join(`http://127.0.0.1:${server.port}`, R, 'orchestrator', null, undefined)
  const at = performance.now()
  await expect(o.poll()).rejects.toThrow()
  expect(performance.now() - at).toBeLessThan(2_000)
}, 5_000)

// Cloudflare answers 5xx while a Durable Object restarts, and a runner's
// network drops a connection now and then: one such answer to an agent's
// poll ended the agent and lost what it ran (2026-10-22).
it('asks again through a relay fault shorter than three heartbeats', async () => {
  const relay = createRelay({ heartbeatMs: 50 })
  let faults = 0
  let joins = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const verb = /\/(\w+)(\?|$)/.exec(req.url)![1]
      // The first join too: an agent on CI died of `relay join: 500` (2026-10-22).
      if ((verb !== 'join' || joins++ === 0) && faults++ < 3)
        return new Response('upstream', { status: 503 })
      return relay.fetch(req)
    },
  })
  servers.push({
    url: '',
    async stop() {
      relay.close()
      await server.stop(true)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const o = await join(url, R, 'orchestrator', null, undefined)
  const a = await join(url, R, 'agent', null, undefined)
  await a.send('orchestrator', 'once')
  expect(faults).toBe(4)
  const got = [...(await o.poll()), ...(await o.poll())].filter((m) => m.from === a.id)
  expect(got).toEqual([{ from: a.id, body: 'once' }])
  globalThis.fetch = (async () => {
    globalThis.fetch = realFetch
    throw new Error('ECONNRESET')
  }) as unknown as typeof fetch
  expect(await a.poll()).toEqual([])
})

it('gives up on a relay down for three heartbeats', async () => {
  const relay = createRelay({ heartbeatMs: 50 })
  let down = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => (down ? new Response('', { status: 502 }) : relay.fetch(req)),
  })
  servers.push({
    url: '',
    async stop() {
      relay.close()
      await server.stop(true)
    },
  })
  const a = await join(`http://127.0.0.1:${server.port}`, R, 'agent', null, undefined)
  down = true
  const at = performance.now()
  await expect(a.poll()).rejects.toThrow('relay poll: 502')
  expect(performance.now() - at).toBeGreaterThanOrEqual(150)
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
