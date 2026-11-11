// The relay client: joined on the websocket it opens (over HTTP only where
// that socket does not open), everything after down it, dialed again
// whenever it drops. Faults and delivery: wire-faults.test.ts; dials
// given up: wire-dials.test.ts.

import { afterEach, expect, it } from 'bun:test'
import { serveRelay } from '@vzn/vx-dte-server'
import { join } from '../src/wire.js'
import { servedRelay } from './served-relay.js'
import { R, R2, cleanUp, heard, servers, sockets, verbs } from './relay-sockets.js'

afterEach(cleanUp)

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
}, 30_000)

// Each frame is a message a relay host may bill: pings at two a heartbeat
// were nearly all of a run's (2026-10-23). Only a worker quiet 1.5
// heartbeats speaks (2026-11-03: "Make probe 3s"), and the orchestrator
// answers with its ack alone (the orchestrator "only sends orders"):
// quiet, a beat and its ack each 3 s; talking, no beat, and nobody pings.
it('a quiet worker beats once each heartbeat and a half, its orchestrator only acks, a talking worker never beats, and none pings', async () => {
  const { url, pings, frames, answers } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  frames.length = 0
  answers.length = 0
  await Bun.sleep(2_600)
  const beat = new RegExp(`"sends":\\[\\{"to":"host","body":\\{"n":\\d+(,"a":\\d+)?\\}\\}\\]`)
  const ack = new RegExp(`"sends":\\[\\{"to":"${a.id}","body":\\{"a":\\d+\\}\\}\\]`)
  const quiet = frames.splice(0)
  // 3.5 quiet spans of 1.5 heartbeats: the worker's beat each and the orchestrator's ack of it.
  const beats = quiet.filter((f) => beat.test(f)).length
  const acks = quiet.filter((f) => ack.test(f)).length
  expect([beats >= 2, beats <= 4, acks >= 2, acks <= 4]).toEqual([true, true, true, true])
  expect(quiet.length).toBe(beats + acks)
  // Neither waits on the relay's answer to either, so it sends none.
  expect(answers).toEqual([])
  const t = performance.now()
  for (let i = 0; performance.now() - t < 2_500; i++) {
    // A beat due as the talk began may still go.
    if (performance.now() - t < 500) frames.length = 0
    await a.send('orchestrator', i)
    await Bun.sleep(50)
  }
  const talking = frames.splice(0)
  expect([talking.filter((f) => beat.test(f) || f.includes('"sends":[]')), pings]).toEqual([[], []])
  // Its acks go together, at most one frame a half heartbeat: four
  // heartbeats of talk counted.
  expect(talking.filter((f) => ack.test(f)).length).toBeLessThanOrEqual(9)
  await a.leave()
  await o.leave()
}, 30_000)

// CI run 41952026507 (2026-11-05): three busy workers ended at once on
// their orchestrator's silence while it ran. A quiet worker beats 3 s
// after it last spoke and is lost at 6 s: an ack half a heartbeat late
// left 2 s for a stall. Its beat's ack goes at once.
it('the orchestrator acks a quiet worker’s beat at once, not half a heartbeat later', async () => {
  const { url, frames } = sockets(2_000)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  const beat = /"sends":\[\{"to":"host","body":\{"n":\d+(,"a":\d+)?\}\}\]/
  const ack = new RegExp(`"sends":\\[\\{"to":"${a.id}","body":\\{"a":\\d+\\}\\}\\]`)
  frames.length = 0
  while (!frames.some((f) => beat.test(f))) await Bun.sleep(5)
  const t = performance.now()
  while (!frames.some((f) => ack.test(f)) && performance.now() - t < 3_000) await Bun.sleep(5)
  // Half a heartbeat is 1 s: at once is the relay's round trip.
  expect(performance.now() - t).toBeLessThan(500)
  await a.leave()
  await o.leave()
}, 30_000)

// 2026-11-05: a live worker says its quiet heartbeat as a numbered
// `report`, not a beat, so its ack waited half a heartbeat as any other:
// the stall #4970 closed for beats stayed open for real workers. A peer
// the orchestrator has not spoken to in a heartbeat is answered right
// after the orchestrator reacts: an order it sends carries the ack, and
// with none, the ack goes alone.
it('the orchestrator answers a quiet worker’s report at once, and an order it sends in reply carries the ack', async () => {
  const { url, frames } = sockets(2_000)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  a.quiet(() => void a.send('orchestrator', { type: 'report' }))
  const report = /"sends":\[\{"to":"host","body":\{"n":\d+(,"a":\d+)?,"b":\{"type":"report"\}/
  const ack = new RegExp(`"sends":\\[\\{"to":"${a.id}","body":\\{"a":\\d+\\}\\}\\]`)
  frames.length = 0
  while (!frames.some((f) => report.test(f))) await Bun.sleep(5)
  const t = performance.now()
  while (!frames.some((f) => ack.test(f)) && performance.now() - t < 3_000) await Bun.sleep(5)
  expect(performance.now() - t).toBeLessThan(500)
  // Answered with an order: the order carries the ack, and no ack goes alone.
  await o.poll()
  frames.length = 0
  let reports = 0
  const reacting = (async () => {
    for (;;) {
      const got = await o.poll()
      for (const m of got) if ((m.body as { type?: string }).type === 'report') reports++
      if (reports > 0) return o.send(a.id, { type: 'batch' })
    }
  })()
  await reacting
  await a.poll()
  await Bun.sleep(1_200)
  const order = new RegExp(`"to":"${a.id}","body":\\{"n":\\d+,"b":\\{"type":"batch"\\},"a":\\d+\\}`)
  expect([frames.some((f) => order.test(f)), frames.filter((f) => ack.test(f))]).toEqual([true, []])
  await a.leave()
  await o.leave()
}, 30_000)

// PR #4317's run (2026-10-24): two workers each sent `ran` a moment
// before a probe was due, and the worker judged its orchestrator silent
// first. Now a send stands for the worker's beat, and its ack answers it.
it('a worker that sends just before its next beat still hears its orchestrator', async () => {
  const { url, frames } = sockets(500)
  const o = await join(url, R2, 'orchestrator', null, undefined)
  const a = await join(url, R2, 'worker', null, undefined)
  await o.poll()
  const probe = /"sends":\[\{"to":"host","body":\{"n":\d+(,"a":\d+)?\}\}\]/
  frames.length = 0
  while (!frames.some((f) => probe.test(f))) await Bun.sleep(5)
  await Bun.sleep(700)
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
}, 30_000)

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
// CI, 2026-11-10: at 500 ms beats the worker, whose orchestrator here never
// polls, lost it (3 beats) before the rejoin's refusal reached it under load.
it('lets go of a worker that joins again naming an id it does not hold', async () => {
  const served = servedRelay({ heartbeatMs: 2_000 })
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
