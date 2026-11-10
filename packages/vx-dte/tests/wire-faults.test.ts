// The relay client through a relay's faults, and each send delivered once.

import { afterEach, expect, it } from 'bun:test'
import { createRelay, serveRelay, TokenError } from '@vzn/vx-dte-server'
import { join, RelayError, unsent, type RelayMessage } from '../src/wire.js'
import { joinOffLoop } from '../src/wire-thread.js'
import { answer, servedRelay } from './served-relay.js'
import { R, R2, cleanUp, dropping, heard, servers, sockets, realFetch } from './relay-sockets.js'

afterEach(cleanUp)

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
}, 30_000)

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
}, 30_000)

// A Cloudflare relay over its daily limit answers no frame: a send waited
// for its answer forever, and the run with it (CI on #3888, 2026-10-22).
// Owner, 2026-10-23: "if it does not reply for 10s its dead".
it('a worker whose relay answers nothing ends, and the orchestrator loses it, within three heartbeats', async () => {
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
  expect(performance.now() - at).toBeLessThan(3_600)
  await o.leave()
}, 30_000)

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
}, 30_000)

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
}, 30_000)

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
}, 30_000)

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
}, 30_000)

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
}, 30_000)

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
}, 30_000)
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

// CI run 40886829588 (2026-10-29): the orchestrator said nothing for 12 s
// and every worker then running ended. Its own sync work (whatever held its
// loop) starved its socket's acks. Off the loop, a held loop sends them
// still; on it, the worker ends. The relay and the worker run in a process
// of their own, as on CI, so holding this loop holds only the orchestrator.
// Held five heartbeats, the loop is taken as hung: the thread leaves, the
// relay closes the run, and the run hears why when its loop is back.
for (const [how, open, heldMs, want] of [
  ['on the loop', 'loop', 2_000, 'ended relay: the orchestrator went silent'],
  ['off the loop', 'thread', 2_000, 'alive'],
  ['off the loop, past its bound', 'thread', 3_500, 'ended relay: the run is closed'],
] as const)
  it(`an orchestrator whose loop is held ${heldMs} ms, its socket ${how}: the worker says ${want}`, async () => {
    const child = Bun.spawn(['bun', `${import.meta.dir}/wire-stall-fixture.ts`, R2], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      timeout: 20_000,
    })
    const reader = child.stdout.getReader()
    let buf = ''
    const line = async (): Promise<string> => {
      for (;;) {
        const i = buf.indexOf('\n')
        if (i !== -1) {
          const l = buf.slice(0, i)
          buf = buf.slice(i + 1)
          return l
        }
        const { value, done } = await reader.read()
        if (done) return ''
        buf += new TextDecoder().decode(value)
      }
    }
    const url = await line()
    const o =
      open === 'thread'
        ? await joinOffLoop(url, R2, null, undefined)
        : await join(url, R2, 'orchestrator', null, undefined)
    void child.stdin.write('go\n')
    void child.stdin.flush()
    expect(await line()).toBe('joined')
    while (!(await o.poll()).some((m) => m.from === 'relay')) {}
    // Past a worker's loss (1.9 heartbeats of 500 ms), short of the
    // thread's bound on a held loop (five).
    const said: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => (said.push(String(chunk)), true)) as never
    const until = performance.now() + heldMs
    while (performance.now() < until) {}
    await Bun.sleep(500)
    process.stderr.write = write
    // What held it is not known here: its length and time are said, for the run's log.
    expect(said.some((l) => l.includes("dte: this machine's loop was held"))).toBe(
      open === 'thread',
    )
    void child.stdin.write('done\n')
    void child.stdin.flush()
    expect(await line()).toBe(want)
    if (heldMs > 2_000) {
      const err = await (async () => {
        for (;;) await o.poll()
      })().catch((e: unknown) => e)
      expect((err as RelayError).message).toMatch(
        /^dte: this machine's run was held \d+ s, past 5 heartbeats/,
      )
    }
    await o.leave().catch(() => undefined)
    await child.exited
  }, 30_000)
