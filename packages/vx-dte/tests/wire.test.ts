// The relay client: joined on the websocket it opens (over HTTP only where
// that socket does not open), everything after down it, dialed again
// whenever it drops.

import { afterEach, expect, it } from 'bun:test'
import { createRelay, serveRelay, TokenError, type RelayServer } from '@vzn/vx-dte-server'
import { join, RelayError, unsent, type RelayMessage } from '../src/wire.js'
import { answer, servedRelay } from './served-relay.js'

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
  await expect(a.remove(o.id)).rejects.toThrow('relay send: 403 only the host removes')
  const b = await join(s.url, R, 'worker', null, undefined)
  await o.poll()
  await o.remove(b.id)
  await a.leave()
  expect(await o.poll()).toEqual([{ from: 'relay', body: { type: 'lost', id: a.id } }])
  await o.leave()
  // Each joins on the socket it opens: one request a participant, none of it HTTP.
  expect(asked).toEqual([])
})

// 2026-10-25: "We don't need double compressed". Each body is zstd'd
// before it is sealed, so the socket offers no deflate.
it('offers the relay no socket compression', async () => {
  const s = servedRelay()
  try {
    const o = await join(s.url, R, 'orchestrator', null, undefined)
    await o.leave()
    expect(s.offered).toEqual([null])
  } finally {
    await s.stop()
  }
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

// Each frame is a message a relay host may bill: pings at two a heartbeat
// were nearly all of a run's (2026-10-23). Quiet, a pair trades one probe
// and its ack each heartbeat and a half (2026-10-23: "if not ask
// to send") and pings nothing; talking, it is asked nothing.
it('a quiet pair trades one probe and its ack, a talking one none, and none pings', async () => {
  const { url, pings, frames, answers } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  frames.length = 0
  answers.length = 0
  await Bun.sleep(2_600)
  const probe = /"sends":\[\{"to":"[^"]+","body":\{"seq":\d+(,"acked":\d+)?\}\}\]/
  const quiet = frames.splice(0)
  // Five heartbeats: the orchestrator's probe and the worker's ack each
  // one and a half. Before, each side asked the relay a heartbeat and
  // pinged it twice.
  expect([quiet.length >= 4, quiet.length <= 8]).toEqual([true, true])
  expect(quiet.filter((f) => probe.test(f)).length).toBeLessThanOrEqual(4)
  // Neither waits on the relay's answer to either, so it sends none.
  expect(answers).toEqual([])
  const t = performance.now()
  for (let i = 0; performance.now() - t < 2_500; i++) {
    // A probe due as the talk began may still go.
    if (performance.now() - t < 500) frames.length = 0
    await a.send('orchestrator', i)
    await Bun.sleep(50)
  }
  expect([frames.filter((f) => probe.test(f) || f.includes('"sends":[]')), pings]).toEqual([[], []])
  await a.leave()
  await o.leave()
}, 15_000)

// PR #4317's run (2026-10-24): two workers each sent `ran` a moment
// before their orchestrator's next probe was due. The orchestrator, having
// heard them, probed no more and acked half a heartbeat later; the worker,
// its send unacked, did not probe, and judged it silent first.
it('a worker that sends just before the next probe still hears its orchestrator', async () => {
  const { url, frames } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  const probe = new RegExp(
    `"sends":\\[\\{"to":"${a.id}","body":\\{"seq":\\d+(,"acked":\\d+)?\\}\\}\\]`,
  )
  frames.length = 0
  while (!frames.some((f) => probe.test(f))) await Bun.sleep(5)
  await Bun.sleep(710)
  await a.send('orchestrator', 'ran')
  const polls = (async () => {
    for (;;) await a.poll()
  })()
  const read = []
  const t = performance.now()
  while (performance.now() - t < 1_500) read.push(...(await o.poll()))
  expect(read).toEqual([{ from: a.id, body: 'ran' }])
  expect(
    await Promise.race([
      polls.then(
        () => 'ended',
        (e: Error) => e.message,
      ),
      Bun.sleep(1).then(() => 'live'),
    ]),
  ).toBe('live')
  await a.leave()
  await o.leave()
}, 10_000)

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

/** What `p` hears next: a poll returns empty after a quiet heartbeat. */
async function heard(p: { poll(): Promise<unknown[]> }): Promise<unknown[]> {
  for (;;) {
    const m = await p.poll()
    if (m.length > 0) return m
  }
}

// Only `leave` ends a participant at once (2026-10-25): one whose
// socket dropped dials again and is still in the run.
it('keeps a worker whose socket dropped, by its redial; one that leaves is lost at once', async () => {
  const { url, open } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  for (const w of open) if (w.data.id === a.id) w.close()
  await o.send(a.id, 'still yours')
  expect(await heard(a)).toEqual([{ from: 'orchestrator', body: 'still yours' }])
  await a.leave()
  expect(await o.poll()).toEqual([{ from: 'relay', body: { type: 'lost', id: a.id } }])
  await o.leave()
})

// 2026-10-25: a proxy in front of the relay (an Access service token).
it('carries dte({ headers }) on every dial, its redial too, never over the token', async () => {
  const { url, open, dials } = sockets(500)
  const extra = { 'CF-Access-Client-Id': 'id' }
  const o = await join(url, R2, 'orchestrator', null, 'jwt', extra)
  const a = await join(url, R2, 'worker', null, 'jwt', extra)
  await o.poll()
  for (const w of open) if (w.data.id === a.id) w.close()
  await o.send(a.id, 'still yours')
  expect(await heard(a)).toEqual([{ from: 'orchestrator', body: 'still yours' }])
  await a.leave()
  await o.leave()
  expect(dials.length).toBeGreaterThanOrEqual(3)
  for (const h of dials)
    expect([h.get('cf-access-client-id'), h.get('authorization')]).toEqual(['id', 'Bearer jwt'])
})

// Main 8d0619f: its orchestrator's socket ended 1006 3 s in, and its
// redial found the run closed: "relay: unknown id" (2026-10-24).
it('keeps the run through its orchestrator’s dropped socket: both carry on', async () => {
  const { url, open } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  for (const w of open) if (w.data.id === o.id) w.close()
  await a.send('orchestrator', 'result')
  expect(await heard(o)).toEqual([{ from: a.id, body: 'result' }])
  await o.send(a.id, 'next')
  expect(await heard(a)).toEqual([{ from: 'orchestrator', body: 'next' }])
  await o.leave()
  const polls = async (): Promise<never> => {
    for (;;) await a.poll()
  }
  await expect(polls()).rejects.toThrow('relay: the run is closed')
})

// A relay stores nothing (2026-10-25: "no storage on relay"): a
// restart forgets every run. The orchestrator joins again as its host, each
// worker joins again naming the id it had, and the run goes on: "offline
// orchestrator or relay does not matter to the system".
it('carries a run across a relay restart: both join again, and what was sent meanwhile arrives', async () => {
  const served = servedRelay({ heartbeatMs: 500 })
  try {
    const o = await join(served.url, R2, 'orchestrator', null, undefined)
    const a = await join(served.url, R2, 'worker', { size: 'small' }, undefined)
    expect(await o.poll()).toEqual([
      { from: 'relay', body: { type: 'joined', id: a.id, info: { size: 'small' } } },
    ])
    served.restart()
    await a.send('orchestrator', 'ran while it was down')
    await o.send(a.id, 'next')
    expect(await heard(o)).toEqual([{ from: a.id, body: 'ran while it was down' }])
    expect(await heard(a)).toEqual([{ from: 'orchestrator', body: 'next' }])
    // Again, past a second restart, by the same id.
    served.restart()
    await o.send(a.id, 'still yours')
    expect(await heard(a)).toEqual([{ from: 'orchestrator', body: 'still yours' }])
    await a.leave()
    expect(await heard(o)).toEqual([{ from: 'relay', body: { type: 'lost', id: a.id } }])
    await o.leave()
  } finally {
    await served.stop()
  }
})

// The worker comes back first: the relay has no run until its orchestrator
// opens it again (410), and the worker keeps asking.
it('a worker that joins again before its orchestrator waits for it, within two heartbeats', async () => {
  const served = servedRelay({ heartbeatMs: 500 })
  try {
    const o = await join(served.url, R2, 'orchestrator', null, undefined)
    const a = await join(served.url, R2, 'worker', null, undefined)
    await o.poll()
    const host = (r: Request): boolean => decodeURIComponent(r.url).includes('"role":"host"')
    served.refuse = host
    served.restart()
    await a.send('orchestrator', 'done')
    await Bun.sleep(400)
    served.refuse = undefined
    expect(await heard(o)).toEqual([{ from: a.id, body: 'done' }])
    await a.leave()
    await o.leave()
  } finally {
    await served.stop()
  }
})

// "If they can't rejoin for 2 heartbeats, it's over" (2026-10-25).
it('a worker whose orchestrator does not come back ends two heartbeats after the restart', async () => {
  const served = servedRelay({ heartbeatMs: 500 })
  try {
    const o = await join(served.url, R2, 'orchestrator', null, undefined)
    const a = await join(served.url, R2, 'worker', null, undefined)
    await o.poll()
    served.refuse = (r) => decodeURIComponent(r.url).includes('"role":"host"')
    const t0 = performance.now()
    served.restart()
    const polls = async (): Promise<never> => {
      for (;;) await a.poll()
    }
    await expect(polls()).rejects.toThrow('relay: unknown id, not joined again in 2 heartbeats')
    expect(performance.now() - t0).toBeLessThan(2_500)
    await expect(o.poll()).rejects.toThrow()
  } finally {
    await served.stop()
  }
})

// A worker the run no longer holds (lost, removed) that joins again is let go.
it('lets go of a worker that joins again naming an id it does not hold', async () => {
  const served = servedRelay({ heartbeatMs: 500 })
  try {
    const o = await join(served.url, R2, 'orchestrator', null, undefined)
    const a = await join(served.url, R2, 'worker', null, undefined)
    await o.poll()
    served.restart()
    // As if lost while it was down: the orchestrator holds it no more.
    await o.remove(a.id).catch(() => undefined)
    const polls = async (): Promise<never> => {
      for (;;) await a.poll()
    }
    await expect(polls()).rejects.toThrow('relay: unknown id')
    expect(await o.poll()).toEqual([])
    await o.leave()
  } finally {
    await served.stop()
  }
})

it('dials its socket again after one the relay never heard close, and gets what was sent meanwhile, sent again', async () => {
  const { url, open, host } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  const workerSockets = () => open.filter((w) => w.data.id === a.id)
  const asked = verbs()
  host.halfOpen = true
  workerSockets()[0]!.close()
  await o.send(a.id, 'while down')
  // Polls the close and the redial wake come back empty until the resend lands.
  let got = await a.poll()
  for (let i = 0; got.length === 0 && i < 8; i++) got = await a.poll()
  expect(got).toEqual([{ from: 'orchestrator', body: 'while down' }])
  expect(workerSockets()).toHaveLength(2)
  host.halfOpen = false
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

it('asks for a new token a minute before the one it holds expires', async () => {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const jwt = (inS: number): string => `${b64({})}.${b64({ exp: Date.now() / 1000 + inS })}.x`
  const { url, host, open } = sockets(undefined, {
    verify: async () => ({ iss: 'i', run: ['1'] }),
  })
  // A worker joins a run its orchestrator started.
  await join(url, R, 'orchestrator', null, async () => jwt(300))
  const asked = async (inS: number): Promise<number> => {
    let n = 0
    const me = await join(url, R, 'worker', null, async () => (n++, jwt(inS)))
    // Its socket drops unseen by the relay: it dials again.
    const mine = () => open.filter((w) => w.data.id === me.id)
    host.halfOpen = true
    mine()[0]!.close()
    for (const t = performance.now(); mine().length < 2 && performance.now() - t < 3_000;)
      await Bun.sleep(20)
    host.halfOpen = false
    await me.leave()
    return n
  }
  // The socket that joined and the one dialed again: one token, or each its own.
  expect([await asked(300), await asked(30)]).toEqual([1, 2])
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

// A Cloudflare relay over its daily limit answers no frame: a send waited
// for its answer forever, and the run with it (CI on #3888, 2026-10-22).
// Owner, 2026-10-23: "if it does not reply for 10s its dead".
it('a worker whose relay answers nothing ends, and the orchestrator loses it, within two heartbeats', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  await a.poll()
  drop(a.id, 'frames', true)
  const at = performance.now()
  const polls = async (): Promise<never> => {
    for (;;) await a.poll()
  }
  await expect(polls()).rejects.toThrow('relay: the orchestrator went silent')
  const read = []
  for (let i = 0; i < 10 && read.length === 0; i++) read.push(...(await o.poll()))
  expect(read).toEqual([{ from: 'relay', body: { type: 'lost', id: a.id } }])
  expect(performance.now() - at).toBeLessThan(2_500)
  await o.leave()
}, 5_000)

// CI run 40886829588 (2026-10-29): three workers' every running task was
// stopped within a second, each worker's job green, when their orchestrator
// was quiet past 1.9 heartbeats (3.8 s) on a relay that answered them. The
// relay keeps a run's host while its socket dials again (10 s), so a worker
// whose relay answers waits for a quiet orchestrator that long; one whose
// relay answers nothing still ends at 1.9 (the row above).
it('a worker whose relay answers waits five heartbeats on a quiet orchestrator', async () => {
  let silent = false
  // The orchestrator's frames lose what they carry to a worker; the relay answers all.
  const served = servedRelay({ heartbeatMs: 200 }, (frame) => {
    if (!silent) return frame
    const f = JSON.parse(frame) as { sends?: { to: string }[] }
    if (f.sends === undefined) return frame
    return JSON.stringify({ ...f, sends: f.sends.filter((one) => one.to === 'host') })
  })
  try {
    const o = await join(served.url, R2, 'orchestrator', null, undefined)
    const a = await join(served.url, R2, 'worker', null, undefined)
    await o.poll()
    silent = true
    const at = performance.now()
    let err: unknown
    while (err === undefined) await a.poll().catch((e: unknown) => (err = e))
    const waited = performance.now() - at
    expect((err as RelayError).message).toBe('relay: the orchestrator went silent')
    // Five heartbeats, not 1.9: 1 000 ms, where it ended at 380.
    expect(waited).toBeGreaterThanOrEqual(4 * 200)
    await o.leave()
  } finally {
    await served.stop()
  }
}, 10_000)

it('a worker ends when its orchestrator’s relay answers nothing, the run’s close unheard', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  drop(o.id, 'frames', true)
  await o.leave()
  const polls = async (): Promise<never> => {
    for (;;) await a.poll()
  }
  await expect(polls()).rejects.toThrow('relay: the orchestrator went silent')
}, 10_000)

// The final call: a `leave` whose socket answers nothing goes again on a
// new one, so its run's close reaches its workers.
it('says its leave again on a new socket when the first answers nothing', async () => {
  const { url, drop } = dropping()
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  drop(o.id, 'frames')
  await o.leave()
  const polls = async (): Promise<never> => {
    for (;;) await a.poll()
  }
  await expect(polls()).rejects.toThrow('relay: the run is closed')
}, 5_000)

// A relay that held a poll left the run waiting on Bun's own five-minute
// limit before it failed (CI, 2026-10-22): an upgrade held past three
// heartbeats is a dial that failed, and no socket for three is the end.
it('gives up on a socket upgrade the relay holds, after 3 dials', async () => {
  const { url, host, open } = sockets(100)
  const o = await join(url, R, 'orchestrator', null, undefined)
  const at = performance.now()
  host.hold = true
  host.halfOpen = true
  for (const w of open) w.close()
  const polls = async (): Promise<never> => {
    for (;;) await o.poll()
  }
  await expect(polls()).rejects.toThrow('no socket in 3 dials')
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
        answer(ws, relay.frame(ws.data.key, ws.data.id, String(m)))
      },
      close(ws) {
        // The network dropped it: the relay never hears its close.
        if (!fail) relay.detach(ws.data.key, ws.data.id, ws)
      },
    },
  })
  servers.push({
    url: '',
    async stop() {
      await server!.stop(true)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const o = await join(url, R, 'orchestrator', null, undefined)
  const a = await join(url, R, 'worker', null, undefined)
  await o.poll()
  fail = true
  held.get(a.id)!.close()
  // Sent with no socket, it waits for the next: the worker goes on.
  await a.send('orchestrator', 'once')
  expect(await heard(o)).toEqual([{ from: a.id, body: 'once' }])
  expect(faults).toBe(4)
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

// A refused send's number was dropped: its receiver waited on it, and
// every send after it, forever.
it('a send the relay refuses holds up none after it', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0, heartbeatMs: 200 })
  servers.push(s)
  const o = await join(s.url, R, 'orchestrator', null, undefined)
  const a = await join(s.url, R, 'worker', null, undefined)
  await o.poll()
  await expect(a.send('orchestrator', 'x'.repeat(1 << 20))).rejects.toThrow('413')
  await a.send('orchestrator', 'after')
  const got: unknown[] = []
  for (let i = 0; i < 10 && got.length === 0; i++) got.push(...(await o.poll()).map((m) => m.body))
  expect(got).toEqual(['after'])
  await a.leave()
  await o.leave()
})

// One 500 from the relay's host on join failed a whole CI run before any
// task started (PR #3911, 2026-10-22): join asks again.
it('joins again after its socket is refused 5xx', async () => {
  const s = sockets()
  s.host.failJoins = 2
  const o = await join(s.url, R, 'orchestrator', null, undefined)
  expect([s.host.failJoins, typeof o.id]).toEqual([0, 'string'])
  await o.leave()
})

// A run its relay did not admit fails at once, naming the relay
// (2026-10-23), with its status and message as every remote error; a
// refusal is never waited out as a fault is.
it('does not join again after a 4xx, and names the relay that refused it', async () => {
  let asked = 0
  const s = sockets(undefined, {
    verify: async () => {
      asked++
      throw new TokenError("repository o/r is not in this relay's ALLOW", 403)
    },
  })
  await expect(join(s.url, R, 'worker', null, 'token')).rejects.toThrow(
    `cannot connect to the relay ${new URL(s.url).origin}: 403 repository o/r is not in this relay's ALLOW`,
  )
  expect(asked).toBe(1)
})

// PR #4311's CI: a refusal whose frame never reached the client gave up
// as "no answer in 10 s"; the close itself says why.
it('reads a refusal from the close when its frame is lost', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: { open: (ws) => ws.close(4403, 'not in ALLOW'), message() {} },
  })
  try {
    await expect(join(server.url.href, R, 'worker', null, 'token')).rejects.toThrow(
      `cannot connect to the relay ${server.url.origin}: 403 not in ALLOW`,
    )
  } finally {
    await server.stop(true)
  }
})

// A relay's words reach the terminal: an ESC in them retitled it and
// overwrote the line vx printed before them.
it("writes the controls in a relay's close as escapes", async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: { open: (ws) => ws.close(4403, '\x1b]0;PWNED\x07'), message() {} },
  })
  try {
    await expect(join(server.url.href, R, 'worker', null, 'token')).rejects.toThrow(
      `cannot connect to the relay ${server.url.origin}: 403 \\x1b]0;PWNED\\x07`,
    )
  } finally {
    await server.stop(true)
  }
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

// A token that could not be had was said as a relay that never answered,
// "no answer in 10 s", with the relay up and never asked, after asking
// the token's source, which tries again itself, three more times.
it('says a token it could not get as that, not as a relay that did not answer', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  let asked = 0
  const token = (): Promise<string> => (
    asked++,
    Promise.reject(new Error("GitHub's OIDC token: 403"))
  )
  const err = await join(s.url, R, 'orchestrator', null, token).catch((e: unknown) => e)
  expect([(err as Error).message, asked]).toEqual(["GitHub's OIDC token: 403", 1])
})

// 2026-10-23: a remote fault is at least a warning. Every send the
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

// The relay may lose what it took (one with no queue, a socket that drops
// under a push): a send not acknowledged by its receiver within a
// heartbeat goes again, and is taken once.
it('sends again what its receiver did not acknowledge, and the receiver takes it once', async () => {
  const { url, host } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  host.lose = 1
  await o.send(a.id, 'lost once')
  const got: unknown[] = []
  const t0 = performance.now()
  while (got.length === 0) got.push(...(await a.poll()).map((m) => m.body))
  expect(got).toEqual(['lost once'])
  expect(performance.now() - t0).toBeGreaterThan(400)
  // Acknowledged: never sent again.
  await Bun.sleep(1_200)
  expect(await a.poll()).toEqual([])
  await a.leave()
  await o.leave()
}, 5_000)

it('takes each send once and in order, however often it arrives', async () => {
  const { url, host } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  host.twice = true
  await o.send(a.id, 1)
  host.lose = 1
  await o.send(a.id, 2)
  await o.send(a.id, 3)
  const got: unknown[] = []
  while (got.length < 3) got.push(...(await a.poll()).map((m) => m.body))
  await Bun.sleep(800)
  got.push(...(await a.poll()).map((m) => m.body))
  expect(got).toEqual([1, 2, 3])
  await a.leave()
  await o.leave()
}, 5_000)

// A participant that left while its relay held every redial kept what
// waited on a socket (here an owed ack) asking for one a heartbeat at a
// time, for good, so its process never ended by itself.
it('ends what waits on a socket when it leaves, so its process can end', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/wire-leave-fixture.ts`], {
    stdout: 'pipe',
    stderr: 'inherit',
    timeout: 8_000,
  })
  expect([await child.exited, child.signalCode, (await child.stdout.text()).trim()]).toEqual([
    0,
    null,
    'left',
  ])
}, 10_000)
// An ack still owed to a worker the relay then lost: the next send to it
// read the intake `forget` dropped and its TypeError was taken for a
// closed socket, so the send resolved and its body went again to nobody
// every heartbeat. A send to one the relay no longer knows is a 404 its
// caller may ignore, and nothing of it goes again.
it('sends to a worker lost while an ack to it was owed as to any lost one', async () => {
  const frames: string[] = []
  const served = servedRelay({ heartbeatMs: 500 }, (f) => (frames.push(f), f))
  try {
    const o = await join(served.url, R2, 'orchestrator', null, undefined)
    const a = await join(served.url, R2, 'worker', null, undefined)
    await o.poll()
    await a.send('orchestrator', 'done')
    await a.leave()
    const got: RelayMessage[] = []
    while (!got.some((m) => (m.body as { type?: string } | null)?.type === 'lost'))
      got.push(...(await o.poll()))
    // Within half a heartbeat of 'done': its ack is still owed.
    const err = await o.send(a.id, 'next').catch((e: unknown) => e)
    expect([err instanceof RelayError, (err as RelayError).status]).toEqual([true, 404])
    const sent = frames.length
    await Bun.sleep(1_200)
    expect(frames.slice(sent).filter((f) => f.includes(a.id))).toEqual([])
    await o.leave()
  } finally {
    await served.stop()
  }
})
