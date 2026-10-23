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
  it('tells the orchestrator of workers that joined before and after it', async () => {
    const c = client()
    const early = await c.join(R1, 'worker', { size: 'small' })
    const o = await c.join(R1, 'orchestrator')
    const late = await c.join(R1, 'worker', { size: 'large' })
    expect(await c.poll(R1, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: early, info: { size: 'small' } } },
      { from: 'relay', body: { type: 'joined', id: late, info: { size: 'large' } } },
    ])
  })

  // Two workers joined a run at once on CI and each made it: the second
  // replaced the first, whose worker the relay then never knew (2026-10-23).
  it('puts workers that join a new run at once in one run', async () => {
    const c = client()
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
    const o = await c.join(R1, 'orchestrator')
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

  it('lets the orchestrator remove a worker it did not admit, before or after it came', async () => {
    const c = client()
    const early = await c.join(R, 'worker')
    const o = await c.join(R, 'orchestrator')
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

  it('wants a bearer token when it verifies', async () => {
    const c = client({ verify: async () => ({ iss: 'i', run: ['1'] }) })
    expect((await c.call(R, 'join', { role: 'worker' })).status).toBe(401)
    expect((await c.call(R, 'join', { role: 'worker' }, '', 't')).status).toBe(200)
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

  it('holds a worker’s info only until the orchestrator is told it', async () => {
    const store = memory()
    const c = client({ store, timer: false })
    const a = await c.join(R, 'worker', 'sealed')
    expect(JSON.stringify([...store.kv]).includes('sealed')).toBe(true)
    const o = await c.join(R, 'orchestrator')
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
  it('keeps nothing of a run its orchestrator signed off, once its workers heard', async () => {
    const store = memory()
    const c = client({ store, timer: false })
    const o = await c.join(R, 'orchestrator')
    await c.join(R, 'worker')
    await c.frame(R, o, { leave: true })
    // The worker has no socket: the run keeps it a minute to tell it, then nothing is kept.
    expect((await c.call(R, 'join', { role: 'worker' })).status).toBe(410)
    expect(later(c, 61_000)).toBeUndefined()
    expect([...store.kv]).toEqual([])
    const alone = client({ store, timer: false })
    const o1 = await alone.join(R1, 'orchestrator')
    await alone.frame(R1, o1, { leave: true })
    expect([...store.kv]).toEqual([])
    expect(alone.relay.sweep()).toBeUndefined()
  })

  it('forgets a run whose workers all went before an orchestrator joined', async () => {
    const store = memory()
    const c = client({ store, timer: false })
    await c.join(R, 'worker')
    expect(later(c, 16_000)).toBeUndefined()
    expect([...store.kv]).toEqual([])
  })

  // Workers start after their orchestrator joins: one alone is late for a run that ended.
  it('closes a run no orchestrator joined in ten minutes', async () => {
    const store = memory()
    const c = client({ store, timer: false })
    const a = await c.join(R, 'worker')
    // Heard from all along.
    c.relay.seen(K, a, Date.now() + 10 * 60_000)
    expect(later(c, 9 * 60_000)! - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 1)
    later(c, 10 * 60_000 + 2)
    expect((await c.call(R, 'join', { role: 'worker' })).status).toBe(410)
  })

  // The run closed while an orchestrator's join awaited its key's proof:
  // the join read the emptied run and threw (main, 3e8a96b).
  it('answers 410 to an orchestrator whose run closed while its key was checked', async () => {
    const answers = new Set<string>()
    for (let ticks = 0; ticks < 32; ticks++) {
      const c = client({ timer: false })
      await c.join(R, 'worker')
      const [req] = await c.request(R, 'join', { role: 'orchestrator' })
      let answered = false
      const res = c.relay.fetch(req).finally(() => (answered = true))
      for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r))
      const before = answered
      later(c, 10 * 60_000 + 2)
      const status = await res.then(
        (r) => r.status,
        (err: Error) => err.message,
      )
      if (!before) answers.add(String(status))
    }
    expect([...answers]).toEqual(['410'])
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
    expect(next - Date.now()).toBeGreaterThan(40)
    expect(next - Date.now()).toBeLessThanOrEqual(61)
    await Bun.sleep(70)
    c.relay.seen(K, o, Date.now())
    c.relay.sweep()
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: null } },
      { from: 'relay', body: { type: 'lost', id: a } },
    ])
  })

  // Each sweep wakes a Durable Object; at three heartbeats it woke every
  // 12 s and stayed billed the whole run (2026-10-22).
  it('gives a participant on a socket twelve heartbeats, one with none three', async () => {
    const c = client({ heartbeatMs: 20, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'worker')
    const b = await c.join(R, 'worker')
    expect(await c.plug(R, a)).toBe(true)
    expect(await c.plug(R, o)).toBe(true)
    await Bun.sleep(70)
    c.relay.seen(K, o, Date.now())
    const next = c.relay.sweep()!
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: null } },
      { from: 'relay', body: { type: 'joined', id: b, info: null } },
      { from: 'relay', body: { type: 'lost', id: b } },
    ])
    // The socket's silence is what the next sweep waits for: o pings.
    expect(next - Date.now()).toBeGreaterThan(40)
    await Bun.sleep(200)
    c.relay.seen(K, o, Date.now())
    c.relay.sweep()
    expect(await c.poll(R, o)).toEqual([{ from: 'relay', body: { type: 'lost', id: a } }])
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
    expect(c.relay.attach(K, o, socket)).toBe(true)
    live.splice(0)
    // Its host let the socket go: the relay queues, the client hears pongs.
    c.relay.detach(K, o, socket)
    await c.send(R, a, 'orchestrator', 'result')
    expect(live).toEqual([])
    // Its next frame, an empty beat, comes down the same socket.
    expect(JSON.parse(c.relay.frame(K, o, JSON.stringify({ n: 7, sends: [] }), socket))).toEqual({
      n: 7,
    })
    expect(live).toEqual([{ from: a, body: 'result' }])
    await c.send(R, a, 'orchestrator', 'next')
    expect(live.at(-1)).toEqual({ from: a, body: 'next' })
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
    expect([res.status, typeof ((await res.json()) as { id: unknown }).id]).toEqual([200, 'string'])
  } finally {
    proc.kill()
    await proc.exited
  }
})
