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
