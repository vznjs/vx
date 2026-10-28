import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import {
  createProver,
  createRelay,
  serveRelay,
  type Prover,
  type RelayOptions,
  type RelayServer,
} from '../src/index.js'
import { GONE, sessionKey, type Kept, type Relay, type RelaySocket } from '../src/relay.js'
import { conformance } from './conformance.js'

/** Run ids: random UUIDs, as the relay takes. */
const R = '00000000-0000-4000-8000-000000000001'
const R1 = '00000000-0000-4000-8000-000000000002'
/** R as its host names it, with no token. */
const K = await sessionKey(R, undefined)

/** A relay, and its participants' requests and sockets as a host would carry them. */
function client(opts: Partial<RelayOptions> = {}, provers = new Map<string, Prover>()) {
  /** Each socket request the relay let in, by its host's names for it. */
  const upgraded = new Map<Request, { key: string; id: string }>()
  const relay = createRelay({
    upgrade: (key, id, req) => {
      upgraded.set(req, { key, id })
      return new Response(null, { status: 101 })
    },
    ...opts,
  })
  /**
   * A request as its participant makes it: `join` is a socket that joins
   * (`socket?join=`), signed by the orchestrator's key, made here.
   */
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
    if (verb === 'join') {
      if (body?.['role'] === 'host' && !('key' in body)) {
        prover = await createProver()
        body = { ...body, key: prover.key }
      }
      verb = 'socket'
      query = `?join=${encodeURIComponent(JSON.stringify(body))}`
      body = undefined
      headers = { ...headers, upgrade: 'websocket', 'sec-websocket-protocol': 'switchboard.v1' }
    }
    const method = body === undefined ? 'GET' : 'POST'
    const text = body === undefined ? '' : JSON.stringify(body)
    const path = `/v1/sessions/${run}/${verb}${query}`
    const req = new Request(`http://relay${path}`, {
      method,
      headers: {
        ...headers,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(prover === undefined ? {} : { 'relay-proof': await prover.proof(method, path, text) }),
      },
      ...(body === undefined ? {} : { body: text }),
    })
    return [req, prover]
  }
  /** What each participant's socket was pushed, said and closed with, by id. */
  const inboxes = new Map<string, unknown[]>()
  const said = new Map<string, any[]>()
  const closes = new Map<string, (number | undefined)[]>()
  const sockets = new Map<string, RelaySocket>()
  /** What each socket's host keeps with it. */
  const kept = new Map<string, Kept>()
  const attach = (key: string, id: string): Kept | false => {
    const inbox: unknown[] = []
    const frames: any[] = []
    const closed: (number | undefined)[] = []
    inboxes.set(id, inbox)
    said.set(id, frames)
    closes.set(id, closed)
    const socket: RelaySocket = {
      send: (t) => {
        const m = JSON.parse(t)
        if (m.messages !== undefined) inbox.push(...m.messages)
        else frames.push(m)
      },
      close: (code) => void closed.push(code),
    }
    sockets.set(id, socket)
    const k = relay.attach(key, id, socket)
    if (k !== false) kept.set(id, k)
    return k
  }
  /**
   * A socket request's answer, as its client reads it: a join's `joined`
   * frame (200), a socket let in (101), or the status its socket was
   * closed with (4000 plus it) and why.
   */
  const open = async (req: Request): Promise<{ status: number; json: any }> => {
    const res = await relay.fetch(req)
    if (res.status !== 101) return { status: res.status, json: await res.json() }
    const { key, id } = upgraded.get(req)!
    upgraded.delete(req)
    if (attach(key, id) === false) {
      const { close, error } = said.get(id)!.find((f) => f.close !== undefined)
      return { status: close - 4000, json: { error } }
    }
    const joined = said.get(id)!.find((f) => f.joined !== undefined)?.joined
    return joined === undefined ? { status: 101, json: null } : { status: 200, json: joined }
  }
  const call = async (
    run: string,
    verb: string,
    body?: Record<string, unknown>,
    query = '',
    token?: string,
  ): Promise<{ status: number; json: any }> => {
    const [req, prover] = await request(run, verb, body, query, token)
    const r = await open(req)
    if (verb === 'join' && r.status === 200 && prover !== undefined) provers.set(r.json.id, prover)
    return r
  }
  const join = async (run: string, role: string, info?: unknown): Promise<string> =>
    (await call(run, 'join', { role, info })).json.id
  /** The run's name at its host, as `token` claims it. */
  const keyOf = async (run: string, token?: string): Promise<string> =>
    sessionKey(
      run,
      token === undefined || opts.verify === undefined
        ? undefined
        : await opts.verify(token, new Request('http://relay')),
    )
  /** A new socket of `id`'s: false if the relay closed it. */
  const plug = async (run: string, id: string, token?: string): Promise<boolean> =>
    attach(await keyOf(run, token), id) !== false
  /** `id`'s socket closed, as its host reports it. */
  const cut = async (run: string, id: string, token?: string): Promise<void> =>
    relay.detach(await keyOf(run, token), id, sockets.get(id)!)
  /** What reached `id`'s socket since, its socket plugged in first if it has none. */
  const poll = async (run: string, id: string, token?: string): Promise<any[]> => {
    if (!inboxes.has(id)) await plug(run, id, token)
    return inboxes.get(id)!.splice(0)
  }
  let n = 0
  const frame = async (run: string, id: string, body: object, token?: string): Promise<any> => {
    const answer = JSON.parse(
      relay.frame(await keyOf(run, token), id, JSON.stringify({ n, ...body }))!,
    )
    expect(answer.n).toBe(n++)
    return answer
  }
  /** One send down `id`'s socket: its status, as HTTP would say it. */
  const send = async (run: string, id: string, to: string, body: unknown, token?: string) => {
    const a = await frame(run, id, { sends: [{ to, body }] }, token)
    return { status: a.status ?? a.results?.[0].status ?? 204, json: a.results?.[0] ?? a }
  }
  return {
    relay,
    provers,
    request,
    open,
    call,
    join,
    keyOf,
    plug,
    cut,
    poll,
    closes,
    said,
    frame,
    send,
    kept,
  }
}

describe('the relay carries one run between its orchestrator and workers', () => {
  // Owner, 2026-10-23: "job is live, or it isnt". A worker that waited
  // for a run held its runner ten minutes when the run had ended.
  it('tells the orchestrator of each worker; one before it finds no live run', async () => {
    const c = client()
    expect((await c.call(R1, 'join', { role: 'peer' })).status).toBe(410)
    const o = await c.join(R1, 'host')
    const a = await c.join(R1, 'peer', { size: 'small' })
    expect(await c.poll(R1, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: { size: 'small' } } },
    ])
  })

  // Two workers joined a run at once on CI and each made it: the second
  // replaced the first, whose worker the relay then never knew (2026-10-23).
  it('puts workers that join a run at once in that run', async () => {
    const c = client()
    const o = await c.join(R1, 'host')
    const workers = await Promise.all([1, 2, 3].map(() => c.join(R1, 'peer')))
    const told: string[] = (await c.poll(R1, o)).map((m) => m.body.id)
    expect(new Set(told)).toEqual(new Set(workers))
    expect(told).toHaveLength(3)
  })

  it('passes messages both ways, and a worker reaches only the orchestrator', async () => {
    const c = client()
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    const b = await c.join(R, 'peer')
    for (const id of [o, a, b]) await c.plug(R, id)
    await c.poll(R, o)
    expect((await c.send(R, o, a, { run: 'x#build' })).status).toBe(204)
    expect(await c.poll(R, a)).toEqual([{ from: 'host', body: { run: 'x#build' } }])
    expect((await c.send(R, a, 'host', 'done')).status).toBe(204)
    expect(await c.poll(R, o)).toEqual([{ from: a, body: 'done' }])
    expect((await c.send(R, a, b, 'hi')).status).toBe(404)
    expect(await c.poll(R, b)).toEqual([])
  })

  it('refuses a second orchestrator', async () => {
    const c = client()
    await c.join(R, 'host')
    expect((await c.call(R, 'join', { role: 'host' })).status).toBe(409)
  })

  // Owner, 2026-10-25: only `leave` ends a participant at once; one whose
  // socket dropped may dial again within the grace.
  it('loses a worker whose socket dropped once its grace passes, and closes the run when the orchestrator leaves', async () => {
    const c = client({ graceMs: 50 })
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    const b = await c.join(R, 'peer')
    await c.poll(R, o)
    await c.poll(R, a)
    await c.poll(R, b)
    // No timer: the next use of the run finds the grace passed.
    await c.cut(R, b)
    await c.frame(R, o, { sends: [] })
    expect(await c.poll(R, o)).toEqual([])
    await Bun.sleep(60)
    await c.frame(R, o, { sends: [] })
    expect(await c.poll(R, o)).toEqual([{ from: 'relay', body: { type: 'left', id: b } }])
    expect((await c.send(R, o, b, 'gone?')).status).toBe(404)
    expect(await c.plug(R, b)).toBe(false)
    await c.frame(R, o, { leave: true })
    expect(await c.poll(R, a)).toEqual([{ from: 'relay', body: { type: 'closed' } }])
    expect([c.closes.get(o), c.closes.get(a)]).toEqual([[GONE], [GONE]])
  })

  it('keeps the key its orchestrator claimed the run with: no other acts as it', async () => {
    const c = client()
    expect((await c.call(R, 'join', { role: 'host', key: undefined })).json).toEqual({
      error: 'a host joins with key: its P-256 public key',
    })
    expect((await c.call(R, 'join', { role: 'host', key: 'AAAA' })).status).toBe(400)
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    const owner = c.provers.get(o)!
    const other = await createProver()
    const status = async (req: Request) => (await c.open(req)).status
    const socket = (proof?: string) =>
      new Request(`http://relay/v1/sessions/${R}/socket?id=${o}`, {
        headers: {
          upgrade: 'websocket',
          'sec-websocket-protocol': 'switchboard.v1',
          ...(proof === undefined ? {} : { 'relay-proof': proof }),
        },
      })
    const path = `/v1/sessions/${R}/socket?id=${o}`
    const replayed = await owner.proof('GET', path, '')
    // A key not the run's signs nothing as its orchestrator, nor claims the run again.
    expect([
      await status(socket()),
      await status(socket(await other.proof('GET', path, ''))),
      await status(socket(await owner.proof('GET', `/v1/sessions/${R}/socket?id=${a}`, ''))),
      await status(socket(replayed)),
      await status(socket(replayed)),
      (await c.call(R, 'join', { role: 'host' })).status,
    ]).toEqual([403, 403, 403, 101, 403, 409])
    const stale = socket(
      (await owner.proof('GET', path, '')).replace(/^\d+/, String(Date.now() - 3 * 60_000)),
    )
    expect(await status(stale)).toBe(403)
    // Sent at once, a replay still finds its nonce taken: the check awaited
    // the signature before it took the nonce, and both passed.
    const twice = await owner.proof('GET', path, '')
    expect(
      (await Promise.all([status(socket(twice)), status(socket(twice))])).toSorted((x, y) => x - y),
    ).toEqual([101, 403])
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
    const open = async (body: object, prover?: Prover) => {
      const path = `/v1/sessions/${R}/socket?join=${encodeURIComponent(JSON.stringify(body))}`
      const proof = prover && (await prover.proof('GET', path, ''))
      return relay.fetch(
        new Request(`http://relay${path}`, {
          headers: {
            upgrade: 'websocket',
            'sec-websocket-protocol': 'switchboard.v1',
            ...(proof === undefined ? {} : { 'relay-proof': proof }),
          },
        }),
      )
    }
    const owner = await createProver()
    const other = await createProver()
    // Signed by the key it claims the run with, over the query that carries it.
    // Each is let in; one refused is closed saying why (4000 plus its status).
    for (const [body, prover] of [
      [{ role: 'host', key: owner.key }, other],
      [{ role: 'host', key: owner.key }, owner],
      [{ role: 'peer', info: { size: 'small' } }],
      [{ role: 'nobody' }],
    ] as [object, Prover?][]) {
      expect((await open(body, prover)).status).toBe(101)
    }
    const [forged, o, w, nobody] = [...pushed.keys()] as [string, string, string, string]
    expect([pushed.get(forged), pushed.get(nobody)]).toEqual([
      [{ close: 4403, error: 'not signed by the session’s host key' }],
      [{ close: 4400, error: 'role is host or peer' }],
    ])
    const [oSaw, wSaw] = [pushed.get(o)!, pushed.get(w)!]
    expect(oSaw).toEqual([
      { joined: { id: o, heartbeatMs: 2000 } },
      { messages: [{ from: 'relay', body: { type: 'joined', id: w, info: { size: 'small' } } }] },
    ])
    expect(wSaw).toEqual([{ joined: { id: w, heartbeatMs: 2000 } }])
    // Its frames go as any participant's.
    const k = await sessionKey(R, undefined)
    expect(relay.frame(k, w, JSON.stringify({ n: 1, sends: [{ to: 'host', body: 'hi' }] }))).toBe(
      '{"n":1}',
    )
    expect(oSaw.at(-1)).toEqual({ messages: [{ from: w, body: 'hi' }] })
  })

  it('lets the orchestrator remove a worker it did not admit', async () => {
    const c = client()
    const o = await c.join(R, 'host')
    const early = await c.join(R, 'peer')
    const late = await c.join(R, 'peer')
    expect(await c.frame(R, early, { remove: late })).toEqual({
      n: 0,
      status: 403,
      error: 'only the host removes',
    })
    expect((await c.frame(R, o, { remove: o })).status).toBe(404)
    // `early` gets what it was told before its socket closes.
    await c.plug(R, early)
    await c.send(R, o, early, { type: 'refused' })
    for (const worker of [early, late]) {
      expect(await c.frame(R, o, { remove: worker })).toEqual({ n: expect.any(Number) })
      expect((await c.send(R, worker, 'host', 1)).status).toBe(404)
    }
    expect(await c.poll(R, early)).toEqual([{ from: 'host', body: { type: 'refused' } }])
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
    expect((await c.call('bad run', 'join', { role: 'peer' })).status).toBe(400)
    expect((await c.call('900-42', 'join', { role: 'peer' })).json).toEqual({
      error: 'session id is not a random UUID',
    })
    expect((await c.call(R, 'join', { role: 'boss' })).status).toBe(400)
    expect((await c.call(R, 'join', { role: 'peer', info: 'x'.repeat(1 << 20) })).json).toEqual({
      error: 'join over 1 MiB',
    })
    expect((await c.call(R, 'socket', { id: 'x' })).status).toBe(405)
    // A signature that is not base64url threw out of the relay: its host answered 500.
    const join = encodeURIComponent(
      JSON.stringify({ role: 'host', key: (await createProver()).key }),
    )
    const forged = await c.open(
      new Request(`http://relay/v1/sessions/${R}/socket?join=${join}`, {
        headers: {
          upgrade: 'websocket',
          'sec-websocket-protocol': 'switchboard.v1',
          'relay-proof': `${Date.now()}.abcdefghijklmnopq.a`,
        },
      }),
    )
    expect(forged).toEqual({
      status: 403,
      json: { error: 'not signed by the session’s host key' },
    })
    // Only `socket` is HTTP: the rest goes down it, the join too.
    for (const verb of ['join', 'send', 'poll', 'leave', 'remove']) {
      const res = await c.relay.fetch(
        new Request(`http://relay/v1/sessions/${R}/${verb}`, { method: 'POST', body: '{}' }),
      )
      expect([res.status, await res.json()]).toEqual([404, { error: 'no such route' }])
    }
  })

  // NATS-style: a sender resends what its receiver did not acknowledge,
  // so the relay holds no participant's message. Its own notices have no
  // sender to resend them, and wait for the next socket.
  it('drops a message it cannot push now; its own notices wait for the socket', async () => {
    const c = client()
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    await c.poll(R, o)
    const failing = {
      send() {
        throw new Error('dropped')
      },
      close() {},
    }
    expect(c.relay.attach(K, a, failing)).toBeTruthy()
    expect((await c.send(R, o, a, 'on a dead socket')).status).toBe(204)
    expect(await c.plug(R, a)).toBe(true)
    expect(await c.poll(R, a)).toEqual([])
    // The relay's own notice has no sender to resend it: it waits.
    expect(c.relay.attach(K, o, failing)).toBeTruthy()
    const b = await c.join(R, 'peer')
    expect(await c.plug(R, o)).toBe(true)
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: b, info: null } },
    ])
  })

  it('wants a bearer token when it verifies', async () => {
    const c = client({ verify: async () => ({ iss: 'i', run: ['1'] }) })
    expect((await c.call(R, 'join', { role: 'peer' })).status).toBe(401)
    // Past the token: no live run.
    expect((await c.call(R, 'join', { role: 'peer' }, '', 't')).status).toBe(410)
  })

  it('names a run by its id and its repository: another repository cannot take its id', async () => {
    // The token names its repository; a GitHub run id is guessable, so
    // another tenant of the relay could open it first.
    const c = client({ verify: async (t) => ({ iss: 'https://gitlab.com', run: [t] }) })
    const theirs = (await c.call(R, 'join', { role: 'host' }, '', 'other')).json.id
    const mine = await c.call(R, 'join', { role: 'host' }, '', 'mine')
    const worker = (await c.call(R, 'join', { role: 'peer' }, '', 'mine')).json.id
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
  /** Sockets as a host restarted would hand them back, with what each got and was closed with. */
  const restarted = (kept: Map<string, Kept | { key: string; id: string }>) => {
    const got = new Map<string, unknown[]>()
    const codes = new Map<string, (number | undefined)[]>()
    const sockets = [...kept].map(([id, k]) => {
      got.set(id, [])
      codes.set(id, [])
      const socket: RelaySocket = {
        send: (t) => void got.get(id)!.push(...((JSON.parse(t).messages as unknown[]) ?? [])),
        close: (code) => void codes.get(id)!.push(code),
      }
      return [k as Kept, socket] as const
    })
    return { sockets, got, codes }
  }

  it('rebuilds its runs from the sockets its host kept, which say no secret', async () => {
    const verify = async () => ({ iss: 'https://gitlab.example', run: ['project-xyz'] })
    const before = client({ verify })
    const o = (await before.call(R, 'join', { role: 'host' }, '', 't')).json.id
    const a = (await before.call(R, 'join', { role: 'peer', info: 'sealed' }, '', 't')).json.id
    const b = (await before.call(R, 'join', { role: 'peer', info: 'sealed' }, '', 't')).json.id
    for (const id of [o, a, b]) await before.plug(R, id, 't')
    await before.send(R, o, a, 'secret', 't')
    // Nothing kept says whose run it is, what was sent, or what a worker said.
    const kept = JSON.stringify([...before.kept.values()])
    expect([
      kept.includes('secret'),
      kept.includes('sealed'),
      kept.includes('gitlab'),
      kept.includes('project-xyz'),
      kept.includes(R),
    ]).toEqual([false, false, false, false, false])
    // A Durable Object's attachment holds 2 KiB.
    for (const k of before.kept.values()) expect(JSON.stringify(k).length).toBeLessThan(2048)
    const { sockets, got, codes } = restarted(before.kept)
    const after = client({ verify, sockets }, before.provers)
    await after.send(R, o, a, 'again', 't')
    await after.send(R, b, 'host', 'back', 't')
    expect([got.get(a), got.get(o), [...codes.values()].flat()]).toEqual([
      [{ from: 'host', body: 'again' }],
      [{ from: b, body: 'back' }],
      [],
    ])
    // Its orchestrator is still bound to its key and job.
    expect((await after.call(R, 'join', { role: 'host' }, '', 't')).status).toBe(409)
  })

  // A host that dropped as its object hibernated may still dial again:
  // its peers' sockets name it.
  it('keeps a run whose orchestrator’s socket was not kept, for its redial', async () => {
    const before = client()
    const o = await before.join(R, 'host')
    const a = await before.join(R, 'peer')
    for (const id of [o, a]) await before.plug(R, id)
    const kept = new Map<string, Kept | { key: string; id: string }>(before.kept)
    kept.delete(o)
    const { sockets, got, codes } = restarted(kept)
    const after = client({ sockets }, before.provers)
    expect(await after.plug(R, o)).toBe(true)
    await after.send(R, o, a, 'back')
    expect([got.get(a), codes.get(a)]).toEqual([[{ from: 'host', body: 'back' }], []])
  })

  it('ends a kept run whose orchestrator’s socket was not kept once its grace passes, letting its workers redial, and closes an older relay’s', async () => {
    const before = client()
    const o = await before.join(R, 'host')
    const a = await before.join(R, 'peer')
    const o1 = await before.join(R1, 'host')
    for (const [run, id] of [
      [R, o],
      [R, a],
      [R1, o1],
    ] as const)
      await before.plug(run, id)
    const kept = new Map<string, Kept | { key: string; id: string }>(before.kept)
    kept.delete(o)
    kept.set(o1, { key: kept.get(o1)!.key, id: o1 })
    const { sockets, codes } = restarted(kept)
    const after = client({ sockets, graceMs: 0 })
    expect([codes.get(a), codes.get(o1)]).toEqual([[undefined], [GONE]])
    expect((await after.call(R, 'join', { role: 'peer' })).status).toBe(410)
  })

  it('keeps no worker’s info: its orchestrator is told it as it joins', async () => {
    const c = client()
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer', 'sealed')
    await c.plug(R, a)
    expect(JSON.stringify([...c.kept.values()]).includes('sealed')).toBe(false)
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: 'sealed' } },
    ])
  })

  // An object kept a day per run held 100+ on one host (2026-10-22).
  // Kept closed ten minutes, or opened by a late worker, a run held that
  // worker's runner ten minutes (main, 2026-10-23).
  it('keeps nothing of a run its orchestrator signed off: a worker after it finds none', async () => {
    const c = client()
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    await c.frame(R, o, { leave: true })
    expect((await c.call(R, 'join', { role: 'peer' })).status).toBe(410)
    expect(await c.plug(R, a)).toBe(false)
  })

  it('takes one of two orchestrators that join at once', async () => {
    const c = client({})
    const reqs = await Promise.all(
      [1, 2].map(async () => (await c.request(R, 'join', { role: 'host' }))[0]),
    )
    const statuses = await Promise.all(reqs.map(async (req) => (await c.open(req)).status))
    expect(statuses.sort((a, b) => a - b)).toEqual([200, 409])
  })

  // Main 32f73ed: the orchestrator waited 13 min on results the relay
  // queued for it, its socket's pings answered all along (2026-10-23).
  it('closes a participant’s earlier socket when another attaches, so none is left deaf', async () => {
    const c = client()
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    const closed: string[] = []
    const live = { send() {}, close: () => void closed.push('live') }
    const stale = {
      send() {
        throw new Error('socket closed')
      },
      close: () => void closed.push('stale'),
    }
    expect(c.relay.attach(K, o, live)).toBeTruthy()
    expect(c.relay.attach(K, o, stale)).toBeTruthy()
    expect(await c.send(R, a, 'host', 'result')).toEqual({
      status: 204,
      json: expect.anything(),
    })
    // Both closed: the live one's client dials again, and the result,
    // unacknowledged, is sent again down it.
    expect(closed).toEqual(['live', 'stale'])
    const pushed: unknown[] = []
    const again = {
      send: (t: string) => void pushed.push(...(JSON.parse(t) as { messages: unknown[] }).messages),
      close() {},
    }
    expect(c.relay.attach(K, o, again)).toBeTruthy()
    await c.send(R, a, 'host', 'result')
    expect(pushed).toContainEqual({ from: a, body: 'result' })
  })

  // Main 13baaf6: a socket whose host let it go, its pings still
  // answered, left the orchestrator deaf for 8 min (2026-10-23).
  it('makes the socket a frame came down its sender’s, and pushes down it from then on', async () => {
    const c = client()
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    const live: unknown[] = []
    const socket = {
      send: (t: string) => void live.push(...(JSON.parse(t) as { messages: unknown[] }).messages),
      close() {},
    }
    expect(c.relay.attach(K, a, socket)).toBeTruthy()
    live.splice(0)
    // Its host handed the relay another object for it, which goes nowhere.
    expect(c.relay.attach(K, a, { send() {}, close() {} })).toBeTruthy()
    await c.send(R, o, a, 'task')
    expect(live).toEqual([])
    // Its next frame, an empty beat, comes down the first.
    expect(JSON.parse(c.relay.frame(K, a, JSON.stringify({ n: 7, sends: [] }), socket)!)).toEqual({
      n: 7,
    })
    await c.send(R, o, a, 'next')
    expect(live.at(-1)).toEqual({ from: 'host', body: 'next' })
  })

  // Owner, 2026-10-25: an orchestrator that dropped without its final
  // `leave` dials again; only once its grace passes is the run over.
  // Its host may still join again (vx-dte rejoins a session the relay
  // forgot): its peers are let go to redial, not told it is over.
  it('closes the run once its orchestrator’s dropped socket has not come back in its grace, letting its workers redial', async () => {
    const c = client({ graceMs: 50 })
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    await c.plug(R, o)
    await c.plug(R, a)
    const socket = { send() {}, close() {} }
    expect(c.relay.attach(K, o, socket)).toBeTruthy()
    c.relay.detach(K, o, socket)
    await c.frame(R, a, { sends: [] })
    expect(await c.poll(R, a)).toEqual([])
    await Bun.sleep(60)
    c.relay.frame(K, a, JSON.stringify({ sends: [] }))
    expect(await c.poll(R, a)).toEqual([])
    expect(c.closes.get(a)).toEqual([undefined])
    expect(await c.plug(R, a)).toBe(false)
    expect((await c.call(R, 'join', { role: 'peer' })).status).toBe(410)
  })

  it('forgets a session all of whose sockets dropped, as another is next asked', async () => {
    const c = client({ graceMs: 20 })
    const o = await c.join(R, 'host')
    const a = await c.join(R, 'peer')
    await c.plug(R, o)
    await c.plug(R, a)
    await c.cut(R, a)
    await c.cut(R, o)
    await Bun.sleep(30)
    await c.join(R1, 'host')
    expect([await c.plug(R, o), (await c.call(R, 'join', { role: 'peer' })).status]).toEqual([
      false,
      410,
    ])
  })

  // A join whose socket never opened (its client dropped during the
  // upgrade) left a participant with no socket and no drop time, which no
  // grace ever lapsed: a host's kept its session, refusing its own rejoin
  // 409 for as long as the relay ran.
  it('loses a participant whose join’s socket never opened, once its grace passes', async () => {
    const c = client({ graceMs: 20 })
    const [host] = await c.request(R, 'join', { role: 'host' })
    expect((await c.relay.fetch(host)).status).toBe(101)
    await Bun.sleep(30)
    const joined = await c.call(R, 'join', { role: 'host' })
    expect(joined.status).toBe(200)
    const o = joined.json.id
    const [peer] = await c.request(R, 'join', { role: 'peer' })
    expect((await c.relay.fetch(peer)).status).toBe(101)
    const [ghost] = (await c.poll(R, o)).map((m) => m.body.id)
    await Bun.sleep(30)
    await c.frame(R, o, { sends: [] })
    expect((await c.poll(R, o)).map((m) => m.body)).toEqual([{ type: 'left', id: ghost }])
  })

  it('pushes messages down a socket and takes sends from it', async () => {
    const c = client()
    const joined = await c.call(R, 'join', { role: 'host' })
    // A socket takes every frame kind; no version to negotiate.
    expect(Object.keys(joined.json).sort()).toEqual(['heartbeatMs', 'id'])
    const o = joined.json.id
    const a = await c.join(R, 'peer')
    await c.plug(R, o)
    const frames: unknown[] = []
    const socket = { send: (t: string) => void frames.push(JSON.parse(t)), close() {} }
    expect(c.relay.attach(K, a, socket)).toBeTruthy()
    await c.send(R, o, a, 'pushed')
    expect(await c.frame(R, a, { sends: [{ to: 'host', body: 3 }] })).toEqual({
      n: expect.any(Number),
    })
    expect((await c.frame(R, a, { sends: [{ to: 'nobody' }] })).results).toEqual([
      { status: 404, error: 'unknown to' },
    ])
    // A lone send is no frame: only `sends`, `remove` and `leave` are.
    expect(await c.frame(R, a, { to: 'host' })).toEqual({
      n: expect.any(Number),
      status: 400,
      error: 'frame is sends, remove or leave',
    })
    // JSON that is no object, or a send that is none: a 400, never a throw out of the relay.
    expect(JSON.parse(c.relay.frame(K, a, 'null')!)).toEqual({
      n: null,
      status: 400,
      error: 'frame is not a JSON object',
    })
    expect((await c.frame(R, a, { sends: [null, 7] })).results).toEqual([
      { status: 400, error: 'a send is an object' },
      { status: 400, error: 'a send is an object' },
    ])
    // Refused for its size, still answered by its number, or its sender waits on it forever.
    const huge = JSON.stringify({
      n: 99,
      sends: [{ to: 'host', body: 'x'.repeat(1 << 20) }],
    })
    expect(JSON.parse(c.relay.frame(K, a, huge)!)).toEqual({
      n: 99,
      status: 413,
      error: 'body over 1 MiB',
    })
    // Unnumbered, its sender waits on no answer: it gets one only if a send fails.
    const unnumbered = (sends: unknown[]) => c.relay.frame(K, a, JSON.stringify({ sends }), socket)
    expect(unnumbered([{ to: 'host', body: 4 }])).toBeUndefined()
    expect(JSON.parse(unnumbered([{ to: 'nobody' }])!)).toEqual({
      n: null,
      results: [{ status: 404, error: 'unknown to' }],
    })
    expect(frames).toEqual([{ messages: [{ from: 'host', body: 'pushed' }] }])
    expect((await c.poll(R, o)).slice(-2)).toEqual([
      { from: a, body: 3 },
      { from: a, body: 4 },
    ])
    c.relay.detach(K, a, socket)
    await c.send(R, o, a, 'after')
    expect(await c.poll(R, a)).toEqual([])
    expect(c.relay.attach(K, 'gone', socket)).toBe(false)
  })

  it('closes a socket a push failed on, so its participant redials', async () => {
    const c = client()
    const o = (await c.call(R, 'join', { role: 'host' })).json.id
    const a = await c.join(R, 'peer')
    let closed = 0
    const socket = {
      send() {
        throw new Error('dropped')
      },
      close: () => void closed++,
    }
    expect(c.relay.attach(K, a, socket)).toBeTruthy()
    await c.send(R, o, a, 'lost?')
    expect(closed).toBe(1)
    // Dropped: its sender, unacknowledged, sends it again.
    expect(await c.poll(R, a)).toEqual([])
  })

  it('answers a socket request without the upgrade header 426', async () => {
    const c = client()
    const a = await c.join(R, 'peer')
    expect((await c.call(R, 'socket', undefined, `?id=${a}`)).status).toBe(426)
  })
})

it('the Bun entry serves the protocol, without auth on loopback only', async () => {
  const bin = path.join(import.meta.dir, '..', 'src', 'bun.ts')
  const refused = Bun.spawnSync(['bun', bin, '--no-auth', '--host', '0.0.0.0'], { stderr: 'pipe' })
  expect([refused.exitCode, refused.stderr.toString().trim()]).toEqual([
    2,
    '✗ vx-dte-server  --no-auth listens on loopback only',
  ])
  const proc = Bun.spawn(['bun', bin, '--no-auth', '--port', '0'], { stdout: 'pipe' })
  try {
    const reader = proc.stdout.getReader()
    const line = new TextDecoder().decode((await reader.read()).value)
    const url = /http:\/\/\S+/.exec(line)![0]
    // Refused, its socket is let in and closed saying why: a failed upgrade says nothing.
    const join = encodeURIComponent(JSON.stringify({ role: 'peer' }))
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/sessions/${R}/socket?join=${join}`, [
      'switchboard.v1',
    ])
    const first = await new Promise<unknown>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)))
    })
    ws.close()
    expect(first).toEqual({ close: 4410, error: 'no live session' })
  } finally {
    proc.kill()
    await proc.exited
  }
})

let served: RelayServer | undefined
beforeAll(() => {
  served = serveRelay({ hostname: '127.0.0.1', port: 0 })
})
afterAll(() => served?.stop())
conformance('the Bun relay', { base: () => served!.url, headers: () => ({}) })

it('names the flags it lacks', () => {
  const said = (...args: string[]) =>
    Bun.spawnSync(['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), ...args], {
      stderr: 'pipe',
    })
      .stderr.toString()
      .split('\n')[0]
  const allow = ['--allow', 'https://token.actions.githubusercontent.com:acme/app:ci.yml']
  expect([
    said(),
    said(...allow),
    said('--audience', 'x'),
    said('--allow', '', '--audience', ''),
    said(...allow, '--audience', ' '),
  ]).toEqual([
    '✗ vx-dte-server  missing --allow and --audience (or --no-auth)',
    '✗ vx-dte-server  missing --audience (or --no-auth)',
    '✗ vx-dte-server  missing --allow (or --no-auth)',
    '✗ vx-dte-server  missing --allow and --audience (or --no-auth)',
    '✗ vx-dte-server  missing --audience (or --no-auth)',
  ])
})

it('answers a flag it does not know with its usage', () => {
  const cli = Bun.spawnSync(['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--bogus'], {
    stderr: 'pipe',
  })
  const [said, usage] = cli.stderr.toString().split('\n')
  expect([cli.exitCode, said, usage?.split(' ').slice(0, 2).join(' ')]).toEqual([
    2,
    "✗ vx-dte-server  Unknown option '--bogus'",
    'usage: vx-dte-server',
  ])
})

it('refuses an empty --port: Number of it is 0, a random port', () => {
  const cli = Bun.spawnSync(
    ['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--no-auth', '--port', ''],
    { stderr: 'pipe' },
  )
  expect([cli.exitCode, cli.stderr.toString()]).toEqual([
    2,
    '✗ vx-dte-server  --port: not a port: \n',
  ])
})
