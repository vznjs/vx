import { afterEach, describe, expect, it } from 'bun:test'
import path from 'node:path'
import {
  createProver,
  createRelay,
  type Prover,
  type Relay,
  type RelayOptions,
} from '../src/index.js'
import { GONE, runKey } from '../src/relay.js'

/** Run ids: random UUIDs, as the relay takes. */
const R = '00000000-0000-4000-8000-000000000001'
const R1 = '00000000-0000-4000-8000-000000000002'
/** R as its host names it, with no token. */
const K = await runKey(R, undefined)

const relays: Relay[] = []
afterEach(() => {
  for (const r of relays.splice(0)) r.close()
})

/** A relay, and its participants' requests and sockets as a host would carry them. */
function client(opts: Partial<RelayOptions> = {}, provers = new Map<string, Prover>()) {
  const relay = createRelay({ upgrade: () => new Response(null, { status: 101 }), ...opts })
  relays.push(relay)
  // Each orchestrator's key, by its id: a request as one is signed by it.
  const request = async (
    run: string,
    verb: string,
    body?: Record<string, unknown>,
    query = '',
    token?: string,
    headers: Record<string, string> = {},
  ): Promise<[Request, Prover | undefined]> => {
    const id = new URLSearchParams(query).get('id')
    let prover = provers.get(id ?? '')
    if (verb === 'join' && body?.['role'] === 'orchestrator' && !('key' in body)) {
      prover = await createProver()
      body = { ...body, key: prover.key }
    }
    const method = body === undefined ? 'GET' : 'POST'
    const text = body === undefined ? '' : JSON.stringify(body)
    const path = `/v1/runs/${run}/${verb}${query}`
    const req = new Request(`http://relay${path}`, {
      method,
      headers: {
        ...headers,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(prover === undefined ? {} : { 'vx-proof': await prover.proof(method, path, text) }),
      },
      ...(body === undefined ? {} : { body: text }),
    })
    return [req, prover]
  }
  const call = async (
    run: string,
    verb: string,
    body?: Record<string, unknown>,
    query = '',
    token?: string,
  ): Promise<{ status: number; json: any }> => {
    const [req, prover] = await request(run, verb, body, query, token)
    const res = await relay.fetch(req)
    const json: any = res.status === 101 ? null : await res.json()
    if (verb === 'join' && res.ok && prover !== undefined) provers.set(json.id, prover)
    return { status: res.status, json }
  }
  const join = async (run: string, role: string, info?: unknown): Promise<string> =>
    (await call(run, 'join', { role, info })).json.id
  /** The run's name at its host, as `token` claims it. */
  const keyOf = async (run: string, token?: string): Promise<string> =>
    runKey(
      run,
      token === undefined || opts.verify === undefined
        ? undefined
        : await opts.verify(token, new Request('http://relay')),
    )
  /** What each participant's socket was pushed, and the codes it was closed with. */
  const inboxes = new Map<string, unknown[]>()
  const closes = new Map<string, (number | undefined)[]>()
  const plug = async (run: string, id: string, token?: string): Promise<boolean> => {
    const inbox: unknown[] = []
    const closed: (number | undefined)[] = []
    inboxes.set(id, inbox)
    closes.set(id, closed)
    return relay.attach(await keyOf(run, token), id, {
      send: (t) => void inbox.push(...(JSON.parse(t) as { messages: unknown[] }).messages),
      close: (code) => void closed.push(code),
    })
  }
  /** What reached `id`'s socket since, its socket plugged in first if it has none. */
  const poll = async (run: string, id: string, token?: string): Promise<any[]> => {
    if (!inboxes.has(id)) await plug(run, id, token)
    return inboxes.get(id)!.splice(0)
  }
  let n = 0
  const frame = async (run: string, id: string, body: object, token?: string): Promise<any> => {
    const answer = JSON.parse(
      relay.frame(await keyOf(run, token), id, JSON.stringify({ n, ...body })),
    )
    expect(answer.n).toBe(n++)
    return answer
  }
  /** One send down `id`'s socket: its status, as HTTP would say it. */
  const send = async (run: string, id: string, to: string, body: unknown, token?: string) => {
    const a = await frame(run, id, { sends: [{ to, body }] }, token)
    return { status: a.status ?? a.results?.[0].status ?? 204, json: a.results?.[0] ?? a }
  }
  return { relay, provers, request, call, join, keyOf, plug, poll, closes, frame, send }
}

describe('the relay carries one run between its orchestrator and workers', () => {
  // Owner, 2026-10-23: "job is live, or it isnt". A worker that waited
  // for a run held its runner ten minutes when the run had ended.
  it('tells the orchestrator of each worker; one before it finds no live run', async () => {
    const c = client()
    expect((await c.call(R1, 'join', { role: 'worker' })).status).toBe(410)
    const o = await c.join(R1, 'orchestrator')
    const a = await c.join(R1, 'worker', { size: 'small' })
    expect(await c.poll(R1, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: { size: 'small' } } },
    ])
  })

  // Two workers joined a run at once on CI and each made it: the second
  // replaced the first, whose worker the relay then never knew (2026-10-23).
  it('puts workers that join a run at once in that run', async () => {
    const c = client()
    const o = await c.join(R1, 'orchestrator')
    // Bodies that arrive over the network, as a host's do: each join waits on its own.
    const slow = (ms: number) =>
      new Request(`http://relay/v1/runs/${R1}/join`, {
        method: 'POST',
        body: new ReadableStream({
          async start(s) {
            await Bun.sleep(ms)
            s.enqueue(new TextEncoder().encode(JSON.stringify({ role: 'worker' })))
            s.close()
          },
        }),
      })
    const workers = await Promise.all(
      [10, 20, 30].map(async (ms) => ((await (await c.relay.fetch(slow(ms))).json()) as any).id),
    )
    const told: string[] = (await c.poll(R1, o)).map((m) => m.body.id)
    expect(new Set(told)).toEqual(new Set(workers))
    expect(told).toHaveLength(3)
  })

  it('passes messages both ways, and a worker reaches only the orchestrator', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const b = await c.join(R, 'worker')
    await c.poll(R, o)
    expect((await c.send(R, o, a, { run: 'x#build' })).status).toBe(204)
    expect(await c.poll(R, a)).toEqual([{ from: 'orchestrator', body: { run: 'x#build' } }])
    expect((await c.send(R, a, 'orchestrator', 'done')).status).toBe(204)
    expect(await c.poll(R, o)).toEqual([{ from: a, body: 'done' }])
    expect((await c.send(R, a, b, 'hi')).status).toBe(404)
    expect(await c.poll(R, b)).toEqual([])
  })

  it('refuses a second orchestrator', async () => {
    const c = client()
    await c.join(R, 'orchestrator')
    expect((await c.call(R, 'join', { role: 'orchestrator' })).status).toBe(409)
  })

  it('reports a lost worker and closes the run when the orchestrator goes', async () => {
    const c = client({ heartbeatMs: 20 })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const b = await c.join(R, 'worker')
    await c.poll(R, o)
    await c.poll(R, a)
    // a and o keep pinging; b, with no socket, falls silent past three heartbeats.
    const deadline = Date.now() + 2_000
    let lost: unknown[] = []
    while (lost.length === 0 && Date.now() < deadline) {
      await Bun.sleep(10)
      for (const id of [o, a]) c.relay.seen(K, id, Date.now())
      lost = (await c.poll(R, o)).filter((m: any) => m.body.type === 'lost')
    }
    expect(lost).toEqual([{ from: 'relay', body: { type: 'lost', id: b } }])
    await c.frame(R, o, { leave: true })
    expect(await c.poll(R, a)).toEqual([{ from: 'relay', body: { type: 'closed' } }])
    expect([c.closes.get(o), c.closes.get(a)]).toEqual([[GONE], [GONE]])
  })

  it('pins a run to its orchestrator’s CI job: its id acts from no other', async () => {
    const c = client({ verify: async (t) => ({ iss: 'i', run: ['1'], job: t }) })
    const o = (await c.call(R, 'join', { role: 'orchestrator' }, '', 'job-1')).json.id
    const a = (await c.call(R, 'join', { role: 'worker' }, '', 'job-2')).json.id
    const upgrade = async (id: string, token: string) =>
      (
        await c.relay.fetch(
          (
            await c.request(R, 'socket', undefined, `?id=${id}`, token, { upgrade: 'websocket' })
          )[0],
        )
      ).status
    expect([
      await upgrade(o, 'job-2'),
      (await c.call(R, 'join', { role: 'orchestrator' }, '', 'job-2')).status,
      await upgrade(o, 'job-1'),
      await upgrade(a, 'job-1'),
    ]).toEqual([403, 409, 101, 101])
    // Its socket, once open, is its job's: its frames need no token.
    expect(await c.plug(R, o, 'job-1')).toBe(true)
    expect(await c.frame(R, o, { sends: [{ to: a, body: 'go' }] }, 'job-1')).toEqual({ n: 0 })
    expect(await c.poll(R, a, 'job-2')).toEqual([{ from: 'orchestrator', body: 'go' }])
  })

  it('keeps the key its orchestrator claimed the run with: no other acts as it', async () => {
    const c = client()
    expect((await c.call(R, 'join', { role: 'orchestrator', key: undefined })).json).toEqual({
      error: 'an orchestrator joins with key: its P-256 public key',
    })
    expect((await c.call(R, 'join', { role: 'orchestrator', key: 'AAAA' })).status).toBe(400)
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const owner = c.provers.get(o)!
    const other = await createProver()
    const status = async (req: Request) => (await c.relay.fetch(req)).status
    const socket = (proof?: string) =>
      new Request(`http://relay/v1/runs/${R}/socket?id=${o}`, {
        headers: { upgrade: 'websocket', ...(proof === undefined ? {} : { 'vx-proof': proof }) },
      })
    const path = `/v1/runs/${R}/socket?id=${o}`
    const replayed = await owner.proof('GET', path, '')
    // A key not the run's signs nothing as its orchestrator, nor claims the run again.
    expect([
      await status(socket()),
      await status(socket(await other.proof('GET', path, ''))),
      await status(socket(await owner.proof('GET', `/v1/runs/${R}/socket?id=${a}`, ''))),
      await status(socket(replayed)),
      await status(socket(replayed)),
      (await c.call(R, 'join', { role: 'orchestrator' })).status,
    ]).toEqual([403, 403, 403, 101, 403, 409])
    const stale = socket(
      (await owner.proof('GET', path, '')).replace(/^\d+/, String(Date.now() - 3 * 60_000)),
    )
    expect(await status(stale)).toBe(403)
  })

  it('joins a participant on the socket it opens: one request, its id said first', async () => {
    const pushed = new Map<string, unknown[]>()
    const relay: Relay = createRelay({
      upgrade: (key, id) => {
        const inbox: unknown[] = []
        pushed.set(id, inbox)
        relay.attach(key, id, { send: (t) => void inbox.push(JSON.parse(t)), close() {} })
        return new Response(null, { status: 101 })
      },
    })
    relays.push(relay)
    const open = async (body: object, prover?: Prover) => {
      const path = `/v1/runs/${R}/socket?join=${encodeURIComponent(JSON.stringify(body))}`
      const proof = prover && (await prover.proof('GET', path, ''))
      return relay.fetch(
        new Request(`http://relay${path}`, {
          headers: { upgrade: 'websocket', ...(proof === undefined ? {} : { 'vx-proof': proof }) },
        }),
      )
    }
    const owner = await createProver()
    const other = await createProver()
    // Signed like a join: by the key it claims the run with, over the query that carries it.
    expect((await open({ role: 'orchestrator', key: owner.key }, other)).status).toBe(403)
    expect((await open({ role: 'orchestrator', key: owner.key }, owner)).status).toBe(101)
    expect((await open({ role: 'worker', info: { size: 'small' } })).status).toBe(101)
    expect((await open({ role: 'nobody' })).status).toBe(400)
    const [o, w] = [...pushed.keys()] as [string, string]
    const [oSaw, wSaw] = [pushed.get(o)!, pushed.get(w)!]
    expect(oSaw).toEqual([
      { joined: { id: o, heartbeatMs: 5000 } },
      { messages: [{ from: 'relay', body: { type: 'joined', id: w, info: { size: 'small' } } }] },
    ])
    expect(wSaw).toEqual([{ joined: { id: w, heartbeatMs: 5000 } }])
    // Its frames go as any participant's.
    const k = await runKey(R, undefined)
    expect(
      relay.frame(k, w, JSON.stringify({ n: 1, sends: [{ to: 'orchestrator', body: 'hi' }] })),
    ).toBe('{"n":1}')
    expect(oSaw.at(-1)).toEqual({ messages: [{ from: w, body: 'hi' }] })
  })

  it('limits each participant’s frames to a burst, then a steady rate', async () => {
    const c = client()
    await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const b = await c.join(R, 'worker')
    const send = (id: string) => c.send(R, id, 'orchestrator', 1)
    // The burst, and what refilled while it was spent.
    let taken = 0
    let limited = await send(a)
    while (limited.status === 204 && taken < 2000) {
      taken++
      limited = await send(a)
    }
    expect(taken).toBeGreaterThanOrEqual(1000)
    expect(taken).toBeLessThan(2000)
    expect(limited.status).toBe(429)
    expect(limited.json).toEqual({
      n: expect.any(Number),
      status: 429,
      error: 'rate limited',
      retryAfterMs: expect.any(Number),
    })
    // Another participant spends its own.
    expect((await send(b)).status).toBe(204)
    await Bun.sleep(limited.json.retryAfterMs)
    expect((await send(a)).status).toBe(204)
  })

  it('lets the orchestrator remove a worker it did not admit, before or after its socket', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const early = await c.join(R, 'worker')
    const late = await c.join(R, 'worker')
    expect(await c.frame(R, early, { remove: late })).toEqual({
      n: 0,
      status: 403,
      error: 'only the orchestrator removes',
    })
    expect((await c.frame(R, o, { remove: o })).status).toBe(404)
    // `early` gets what it was told before its socket closes; `late` has none to tell.
    await c.send(R, o, early, { type: 'refused' })
    await c.plug(R, early)
    for (const worker of [early, late]) {
      expect(await c.frame(R, o, { remove: worker })).toEqual({ n: expect.any(Number) })
      expect((await c.send(R, worker, 'orchestrator', 1)).status).toBe(404)
    }
    expect(await c.poll(R, early)).toEqual([{ from: 'orchestrator', body: { type: 'refused' } }])
    expect(c.closes.get(early)).toEqual([GONE])
    expect(await c.plug(R, early)).toBe(false)
    // Removed, not lost: the orchestrator hears only that each came.
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: early, info: null } },
      { from: 'relay', body: { type: 'joined', id: late, info: null } },
    ])
  })

  it('answers malformed requests with their status', async () => {
    const c = client()
    expect((await c.call('bad run', 'join', { role: 'worker' })).status).toBe(400)
    expect((await c.call('900-42', 'join', { role: 'worker' })).json).toEqual({
      error: 'run id is not a random UUID',
    })
    expect((await c.call(R, 'join', { role: 'boss' })).status).toBe(400)
    expect((await c.call(R, 'join', { role: 'worker', info: 'x'.repeat(1 << 20) })).json).toEqual({
      error: 'body over 1 MiB',
    })
    expect((await c.call(R, 'socket', { id: 'x' })).status).toBe(405)
    // Only `join` and `socket` are HTTP: the rest goes down the socket.
    for (const verb of ['send', 'poll', 'leave', 'remove']) {
      expect((await c.call(R, verb, { id: 'x' })).json).toEqual({ error: 'no such route' })
    }
  })

  it('holds at most 64 MiB for a participant with no socket', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const body = 'x'.repeat((1 << 20) - 100)
    const statuses: number[] = []
    for (let i = 0; i < 66; i++) statuses.push((await c.send(R, o, a, body)).status)
    expect(statuses.indexOf(429)).toBe(64)
    expect((await c.poll(R, a)).length).toBe(64)
    expect((await c.send(R, o, a, body)).status).toBe(204)
  })

  // A worker's queue full when its run closed threw out of the close: the
  // workers after it never heard, and the run was never forgotten, so its
  // id refused the next orchestrator for good.
  it('closes a run whose worker’s queue is full: every worker hears, the run is gone', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const b = await c.join(R, 'worker')
    await c.poll(R, o)
    // 10 000 messages, the most it holds.
    for (let i = 0; i < 5; i++) await c.frame(R, o, { sends: Array(2000).fill({ to: a, body: i }) })
    expect((await c.send(R, o, a, 'one more')).status).toBe(429)
    await c.plug(R, b)
    const left = await c.frame(R, o, { leave: true })
    expect(left.status).toBeUndefined()
    expect(await c.poll(R, b)).toEqual([{ from: 'relay', body: { type: 'closed' } }])
    expect([c.closes.get(o), c.closes.get(b)]).toEqual([[GONE], [GONE]])
    expect((await c.call(R, 'join', { role: 'orchestrator' })).status).toBe(200)
  })

  it('tells an orchestrator whose queue is full of a lost worker, and sweeps on', async () => {
    const c = client({ heartbeatMs: 20, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const b = await c.join(R, 'worker')
    for (let i = 0; i < 4; i++)
      await c.frame(R, a, { sends: Array(2500).fill({ to: 'orchestrator', body: i }) })
    expect((await c.send(R, a, 'orchestrator', 'one more')).status).toBe(429)
    await Bun.sleep(60)
    for (const id of [o, a]) c.relay.seen(K, id, Date.now())
    expect(c.relay.sweep()).toBeNumber()
    expect((await c.poll(R, o)).at(-1)).toEqual({ from: 'relay', body: { type: 'lost', id: b } })
  })

  it('wants a bearer token when it verifies', async () => {
    const c = client({ verify: async () => ({ iss: 'i', run: ['1'] }) })
    expect((await c.call(R, 'join', { role: 'worker' })).status).toBe(401)
    // Past the token: no live run.
    expect((await c.call(R, 'join', { role: 'worker' }, '', 't')).status).toBe(410)
  })

  it('names a run by its id and its repository: another repository cannot take its id', async () => {
    // The token names its repository; a GitHub run id is guessable, so
    // another tenant of the relay could open it first.
    const c = client({ verify: async (t) => ({ iss: 'https://gitlab.com', run: [t] }) })
    const theirs = (await c.call(R, 'join', { role: 'orchestrator' }, '', 'other')).json.id
    const mine = await c.call(R, 'join', { role: 'orchestrator' }, '', 'mine')
    const worker = (await c.call(R, 'join', { role: 'worker' }, '', 'mine')).json.id
    expect([
      mine.status,
      await c.poll(R, mine.json.id, 'mine'),
      await c.poll(R, theirs, 'other'),
      await c.plug(R, worker, 'other'),
    ]).toEqual([
      200,
      [{ from: 'relay', body: { type: 'joined', id: worker, info: null } }],
      [],
      false,
    ])
  })
})

describe('a host that keeps runs and holds websockets', () => {
  const memory = () => {
    const kv = new Map<string, unknown>()
    return {
      kv,
      put: (k: string, v: unknown) => void kv.set(k, v),
      delete: (k: string) => kv.delete(k),
      list: ({ prefix }: { prefix: string }) =>
        [...kv].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)),
    }
  }

  it('keeps runs and participants across a restart, never a message', async () => {
    const store = memory()
    const verify = async () => ({ iss: 'https://gitlab.example', run: ['project-xyz'] })
    const before = client({ store, timer: false, verify })
    const o = (await before.call(R, 'join', { role: 'orchestrator' }, '', 't')).json.id
    const a = (await before.call(R, 'join', { role: 'worker', info: 'sealed' }, '', 't')).json.id
    const b = (await before.call(R, 'join', { role: 'worker', info: 'sealed' }, '', 't')).json.id
    await before.poll(R, o, 't')
    await before.send(R, o, a, 'secret', 't')
    // Nothing kept says whose run it is, what was sent, or what a worker said once told.
    const kept = JSON.stringify([...store.kv])
    expect([
      kept.includes('secret'),
      kept.includes('sealed'),
      kept.includes('gitlab'),
      kept.includes('project-xyz'),
      kept.includes(R),
    ]).toEqual([false, false, false, false, false])
    const after = client({ store, timer: false, verify }, before.provers)
    // `a`'s queue held a message the restart lost: `a` is lost, `b` goes on.
    expect([
      await after.plug(R, a, 't'),
      await after.poll(R, b, 't'),
      await after.poll(R, o, 't'),
    ]).toEqual([false, [], [{ from: 'relay', body: { type: 'lost', id: a } }]])
  })

  it('keeps no worker’s info: its orchestrator is told it as it joins', async () => {
    const store = memory()
    const c = client({ store, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker', 'sealed')
    expect(JSON.stringify([...store.kv]).includes('sealed')).toBe(false)
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: 'sealed' } },
    ])
  })

  /** Sweeps `c` as if `ms` had passed. */
  const later = (c: ReturnType<typeof client>, ms: number) => {
    const clock = Date.now
    const now = clock()
    Date.now = () => now + ms
    try {
      return c.relay.sweep()
    } finally {
      Date.now = clock
    }
  }

  // An object kept a day per run held 100+ on one host (owner, 2026-10-22).
  // Kept closed ten minutes, or opened by a late worker, a run held that
  // worker's runner ten minutes (main, 2026-10-23).
  it('keeps nothing of a run its orchestrator signed off: a worker after it finds none', async () => {
    const store = memory()
    const c = client({ store, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    await c.frame(R, o, { leave: true })
    expect([...store.kv]).toEqual([])
    expect(c.relay.sweep()).toBeUndefined()
    expect((await c.call(R, 'join', { role: 'worker' })).status).toBe(410)
    expect(await c.plug(R, a)).toBe(false)
  })

  it('takes one of two orchestrators that join at once', async () => {
    const c = client({ timer: false })
    const reqs = await Promise.all(
      [1, 2].map(async () => (await c.request(R, 'join', { role: 'orchestrator' }))[0]),
    )
    const statuses = await Promise.all(reqs.map(async (req) => (await c.relay.fetch(req)).status))
    expect(statuses.sort((a, b) => a - b)).toEqual([200, 409])
  })

  // Restored as heard just now, a gone participant kept its object waking
  // every 15 s, forever (2026-10-22).
  it('drops a participant silent across a restart', async () => {
    const store = memory()
    const before = client({ store, timer: false })
    const o = await before.join(R, 'orchestrator')
    await before.join(R, 'worker')
    await before.poll(R, o)
    before.relay.sweep()
    const after = client({ store, timer: false }, before.provers)
    // With no socket, participants are lost after three heartbeats of 5 s.
    expect(later(after, 16_000)).toBeUndefined()
    expect([...store.kv]).toEqual([])
    expect(await after.plug(R, o)).toBe(false)
  })

  // A host restores its sockets at each wake: restored, a dead
  // orchestrator's socket counted as heard, and its run's workers waited
  // out their job's timeout (main, 2026-10-23).
  it('loses an orchestrator whose restored socket is silent, and lets its workers go', async () => {
    const store = memory()
    const before = client({ store, timer: false })
    const o = await before.join(R, 'orchestrator')
    const a = await before.join(R, 'worker')
    await before.poll(R, o)
    await before.poll(R, a)
    const joinedAt = Date.now()
    const told: unknown[] = []
    const dead = { send: () => {}, close: () => {} }
    const live = {
      send: (t: string) => void told.push(...(JSON.parse(t) as { messages: unknown[] }).messages),
      close: () => {},
    }
    const wake = (ms: number) => {
      const clock = Date.now
      Date.now = () => joinedAt + ms
      try {
        const host = client({ store, timer: false }, before.provers)
        host.relay.attach(K, o, dead, 0)
        host.relay.attach(K, a, live, joinedAt + ms)
        return host
      } finally {
        Date.now = clock
      }
    }
    wake(50_000)
    const host = wake(70_000)
    host.relay.seen(K, a, joinedAt + 70_000)
    later(host, 70_000)
    expect(told).toEqual([{ from: 'relay', body: { type: 'closed' } }])
  })

  // Each write is a row of a free host's 100 000 a day: a write per
  // participant per sweep spent them in about 40 CI runs (2026-10-23).
  it('writes a participant on a socket once, not at each sweep', async () => {
    const store = memory()
    const writes: string[] = []
    const put = store.put
    store.put = (k, v) => {
      writes.push(k)
      put(k, v)
    }
    const c = client({ store, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    await c.poll(R, o)
    await c.poll(R, a)
    writes.length = 0
    for (let i = 1; i <= 50; i++) {
      c.relay.seen(K, o, Date.now() + i)
      c.relay.seen(K, a, Date.now() + i)
      c.relay.sweep()
    }
    expect(writes).toEqual([])
    // Off its socket, its silence is kept once: a restart counts it from there.
    const s = { send: () => {}, close: () => {} }
    c.relay.attach(K, a, s)
    c.relay.detach(K, a, { send: () => {}, close: () => {} })
    c.relay.detach(K, a, s)
    c.relay.sweep()
    expect(writes.length).toBe(1)
  })

  it('sweeps when its host asks, and says when to ask next', async () => {
    const c = client({ heartbeatMs: 20, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const next = c.relay.sweep()!
    expect(next - Date.now()).toBeGreaterThan(20)
    expect(next - Date.now()).toBeLessThanOrEqual(41)
    await Bun.sleep(50)
    c.relay.seen(K, o, Date.now())
    c.relay.sweep()
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: null } },
      { from: 'relay', body: { type: 'lost', id: a } },
    ])
  })

  // Owner, 2026-10-23: "if it does not reply for 10s its dead". Before, a
  // participant on a socket had twelve heartbeats, one with none three.
  it('loses a participant silent two heartbeats, on a socket or not', async () => {
    const c = client({ heartbeatMs: 50, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const b = await c.join(R, 'worker')
    expect(await c.plug(R, a)).toBe(true)
    expect(await c.plug(R, o)).toBe(true)
    await Bun.sleep(60)
    c.relay.seen(K, o, Date.now())
    c.relay.seen(K, a, Date.now())
    c.relay.seen(K, b, Date.now())
    c.relay.sweep()
    await Bun.sleep(60)
    c.relay.seen(K, o, Date.now())
    c.relay.sweep()
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: null } },
      { from: 'relay', body: { type: 'joined', id: b, info: null } },
    ])
    await Bun.sleep(60)
    c.relay.seen(K, o, Date.now())
    c.relay.sweep()
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'lost', id: a } },
      { from: 'relay', body: { type: 'lost', id: b } },
    ])
  })

  // Main 32f73ed: the orchestrator waited 13 min on results the relay
  // queued for it, its socket's pings answered all along (2026-10-23).
  it('closes a participant’s earlier socket when another attaches, so none is left deaf', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const closed: string[] = []
    const live = { send() {}, close: () => void closed.push('live') }
    const stale = {
      send() {
        throw new Error('socket closed')
      },
      close: () => void closed.push('stale'),
    }
    expect(c.relay.attach(K, o, live)).toBe(true)
    expect(c.relay.attach(K, o, stale)).toBe(true)
    expect(await c.send(R, a, 'orchestrator', 'result')).toEqual({
      status: 204,
      json: expect.anything(),
    })
    // Both closed: the live one's client dials again and gets the result.
    expect(closed).toEqual(['live', 'stale'])
    const pushed: unknown[] = []
    const again = {
      send: (t: string) => void pushed.push(...(JSON.parse(t) as { messages: unknown[] }).messages),
      close() {},
    }
    expect(c.relay.attach(K, o, again)).toBe(true)
    expect(pushed).toContainEqual({ from: a, body: 'result' })
  })

  // Main 13baaf6: a socket whose host let it go, its pings still
  // answered, left the orchestrator deaf for 8 min (2026-10-23).
  it('makes the socket a frame came down its sender’s, and pushes what queued down it', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const live: unknown[] = []
    const socket = {
      send: (t: string) => void live.push(...(JSON.parse(t) as { messages: unknown[] }).messages),
      close() {},
    }
    expect(c.relay.attach(K, a, socket)).toBe(true)
    live.splice(0)
    // Its host let the socket go: the relay queues, the client hears pongs.
    c.relay.detach(K, a, socket)
    await c.send(R, o, a, 'task')
    expect(live).toEqual([])
    // Its next frame, an empty beat, comes down the same socket.
    expect(JSON.parse(c.relay.frame(K, a, JSON.stringify({ n: 7, sends: [] }), socket))).toEqual({
      n: 7,
    })
    expect(live).toEqual([{ from: 'orchestrator', body: 'task' }])
    await c.send(R, o, a, 'next')
    expect(live.at(-1)).toEqual({ from: 'orchestrator', body: 'next' })
  })

  // Owner, 2026-10-23: "if the orchestrator is disconnected we close all agents".
  it('closes the run the moment its orchestrator’s socket closes', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    await c.plug(R, o)
    await c.plug(R, a)
    const socket = { send() {}, close() {} }
    expect(c.relay.attach(K, o, socket)).toBe(true)
    c.relay.detach(K, o, socket)
    expect(await c.poll(R, a)).toEqual([{ from: 'relay', body: { type: 'closed' } }])
    expect(c.closes.get(a)).toEqual([GONE])
    expect((await c.call(R, 'join', { role: 'worker' })).status).toBe(410)
  })

  it('pushes messages down a socket and takes sends from it', async () => {
    const c = client()
    const joined = await c.call(R, 'join', { role: 'orchestrator' })
    // A socket takes every frame kind; no version to negotiate.
    expect(Object.keys(joined.json).sort()).toEqual(['heartbeatMs', 'id', 'socket'])
    expect(joined.json.socket).toBe(true)
    const o = joined.json.id
    const a = await c.join(R, 'worker')
    await c.send(R, o, a, 'queued')
    const frames: unknown[] = []
    const socket = { send: (t: string) => void frames.push(JSON.parse(t)), close() {} }
    expect(c.relay.attach(K, a, socket)).toBe(true)
    await c.send(R, o, a, 'pushed')
    expect(await c.frame(R, a, { sends: [{ to: 'orchestrator', body: 3 }] })).toEqual({
      n: expect.any(Number),
    })
    expect((await c.frame(R, a, { sends: [{ to: 'nobody' }] })).results).toEqual([
      { status: 404, error: 'unknown to' },
    ])
    // A lone send is no frame: only `sends`, `remove` and `leave` are.
    expect(await c.frame(R, a, { to: 'orchestrator' })).toEqual({
      n: expect.any(Number),
      status: 400,
      error: 'frame is sends, remove or leave',
    })
    // Refused for its size, still answered by its number, or its sender waits on it forever.
    const huge = JSON.stringify({
      n: 99,
      sends: [{ to: 'orchestrator', body: 'x'.repeat(1 << 20) }],
    })
    expect(JSON.parse(c.relay.frame(K, a, huge))).toEqual({
      n: 99,
      status: 413,
      error: 'body over 1 MiB',
    })
    expect(frames).toEqual([
      { messages: [{ from: 'orchestrator', body: 'queued' }] },
      { messages: [{ from: 'orchestrator', body: 'pushed' }] },
    ])
    expect((await c.poll(R, o)).at(-1)).toEqual({ from: a, body: 3 })
    c.relay.detach(K, a, socket)
    await c.send(R, o, a, 'after')
    expect(await c.poll(R, a)).toEqual([{ from: 'orchestrator', body: 'after' }])
    expect(c.relay.attach(K, 'gone', socket)).toBe(false)
  })

  it('closes a socket a push failed on, so its participant redials for what queued', async () => {
    const c = client()
    const o = (await c.call(R, 'join', { role: 'orchestrator' })).json.id
    const a = await c.join(R, 'worker')
    let closed = 0
    const socket = {
      send() {
        throw new Error('dropped')
      },
      close: () => void closed++,
    }
    expect(c.relay.attach(K, a, socket)).toBe(true)
    await c.send(R, o, a, 'lost?')
    expect(closed).toBe(1)
    expect(await c.poll(R, a)).toEqual([{ from: 'orchestrator', body: 'lost?' }])
  })

  it('answers a socket request without the upgrade header 426', async () => {
    const c = client()
    const a = await c.join(R, 'worker')
    expect((await c.call(R, 'socket', undefined, `?id=${a}`)).status).toBe(426)
  })
})

it('the Bun entry serves the protocol, without auth on loopback only', async () => {
  const bin = path.join(import.meta.dir, '..', 'src', 'bun.ts')
  const refused = Bun.spawnSync(['bun', bin, '--no-auth', '--host', '0.0.0.0'], { stderr: 'pipe' })
  expect([refused.exitCode, refused.stderr.toString().trim()]).toEqual([
    2,
    '--no-auth listens on loopback only',
  ])
  const proc = Bun.spawn(['bun', bin, '--no-auth', '--port', '0'], { stdout: 'pipe' })
  try {
    const reader = proc.stdout.getReader()
    const line = new TextDecoder().decode((await reader.read()).value)
    const url = /http:\/\/\S+/.exec(line)![0]
    const res = await fetch(`${url}/v1/runs/${R}/join`, {
      method: 'POST',
      body: JSON.stringify({ role: 'worker' }),
    })
    expect([res.status, await res.json()]).toEqual([410, { error: 'no live run' }])
  } finally {
    proc.kill()
    await proc.exited
  }
})
