import { afterEach, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { createProver, createRelay, type Prover, type Relay } from '../src/index.js'
import { runKey } from '../src/relay.js'

/** Run ids: random UUIDs, as the relay takes. */
const R = '00000000-0000-4000-8000-000000000001'
const R1 = '00000000-0000-4000-8000-000000000002'
/** R as its host names it, with no token. */
const K = await runKey(R, undefined)

const relays: Relay[] = []
afterEach(() => {
  for (const r of relays.splice(0)) r.close()
})

function client(opts: Parameters<typeof createRelay>[0] = {}, provers = new Map<string, Prover>()) {
  const relay = createRelay(opts)
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
    const id = (body?.['id'] as string | undefined) ?? new URLSearchParams(query).get('id')
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
    const json: any = res.status === 204 ? null : await res.json()
    if (verb === 'join' && res.ok && prover !== undefined) provers.set(json.id, prover)
    return { status: res.status, json }
  }
  const join = async (run: string, role: string, info?: unknown): Promise<string> =>
    (await call(run, 'join', { role, info })).json.id
  const poll = async (run: string, id: string, wait = 0) =>
    (await call(run, 'poll', undefined, `?id=${id}&wait=${wait}`)).json.messages
  return { relay, provers, request, call, join, poll }
}

describe('the relay carries one run between its orchestrator and agents', () => {
  it('tells the orchestrator of agents that joined before and after it', async () => {
    const c = client()
    const early = await c.join(R1, 'agent', { size: 'small' })
    const o = await c.join(R1, 'orchestrator')
    const late = await c.join(R1, 'agent', { size: 'large' })
    expect(await c.poll(R1, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: early, info: { size: 'small' } } },
      { from: 'relay', body: { type: 'joined', id: late, info: { size: 'large' } } },
    ])
  })

  it('passes messages both ways, and an agent reaches only the orchestrator', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'agent')
    const b = await c.join(R, 'agent')
    await c.poll(R, o)
    expect((await c.call(R, 'send', { id: o, to: a, body: { run: 'x#build' } })).status).toBe(204)
    expect(await c.poll(R, a)).toEqual([{ from: 'orchestrator', body: { run: 'x#build' } }])
    expect((await c.call(R, 'send', { id: a, to: 'orchestrator', body: 'done' })).status).toBe(204)
    expect(await c.poll(R, o)).toEqual([{ from: a, body: 'done' }])
    expect((await c.call(R, 'send', { id: a, to: b, body: 'hi' })).status).toBe(404)
    expect(await c.poll(R, b)).toEqual([])
  })

  it('holds a poll until a message arrives', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'agent')
    const held = c.poll(R, a, 5_000)
    await Bun.sleep(20)
    await c.call(R, 'send', { id: o, to: a, body: 1 })
    const t = performance.now()
    expect(await held).toEqual([{ from: 'orchestrator', body: 1 }])
    expect(performance.now() - t).toBeLessThan(1_000)
  })

  it('answers a held poll empty when its wait ends', async () => {
    const c = client()
    const a = await c.join(R, 'agent')
    expect(await c.poll(R, a, 30)).toEqual([])
  })

  it('refuses a second orchestrator', async () => {
    const c = client()
    await c.join(R, 'orchestrator')
    expect((await c.call(R, 'join', { role: 'orchestrator' })).status).toBe(409)
  })

  it('reports a lost agent and closes the run when the orchestrator goes', async () => {
    const c = client({ heartbeatMs: 20 })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'agent')
    const b = await c.join(R, 'agent')
    await c.poll(R, o)
    // a keeps polling; b falls silent past three heartbeats.
    const deadline = Date.now() + 2_000
    let lost: unknown[] = []
    while (lost.length === 0 && Date.now() < deadline) {
      await c.poll(R, a)
      lost = (await c.poll(R, o, 10)).filter((m: any) => m.body.type === 'lost')
    }
    expect(lost).toEqual([{ from: 'relay', body: { type: 'lost', id: b } }])
    const held = c.poll(R, a, 5_000)
    await Bun.sleep(5)
    expect((await c.call(R, 'leave', { id: o })).status).toBe(204)
    expect(await held).toEqual([{ from: 'relay', body: { type: 'closed' } }])
    expect((await c.call(R, 'join', { role: 'agent' })).status).toBe(410)
  })

  it('forgets a run whose agents all went before an orchestrator joined', async () => {
    const c = client({ heartbeatMs: 20 })
    await c.join(R, 'agent')
    // Polled as nobody, so the agent itself stays silent.
    const asked = async () => (await c.call(R, 'poll', undefined, '?id=x&wait=0')).json.error
    expect(await asked()).toBe('unknown id')
    const deadline = Date.now() + 2_000
    let error = ''
    while (error !== 'unknown run' && Date.now() < deadline) {
      await Bun.sleep(20)
      error = await asked()
    }
    expect(error).toBe('unknown run')
  })

  it('pins a run to its orchestrator’s CI job: its id acts from no other', async () => {
    const c = client({ verify: async (t) => ({ iss: 'i', run: ['1'], job: t }) })
    const o = (await c.call(R, 'join', { role: 'orchestrator' }, '', 'job-1')).json.id
    const a = (await c.call(R, 'join', { role: 'agent' }, '', 'job-2')).json.id
    const polled = async (id: string, token: string) =>
      (await c.call(R, 'poll', undefined, `?id=${id}&wait=0`, token)).status
    expect([
      await polled(o, 'job-2'),
      (await c.call(R, 'send', { id: o, to: a, body: 1 }, '', 'job-2')).status,
      (await c.call(R, 'join', { role: 'orchestrator' }, '', 'job-2')).status,
      await polled(o, 'job-1'),
      await polled(a, 'job-1'),
    ]).toEqual([403, 403, 409, 200, 200])
  })

  it('takes a pinned orchestrator’s sends down the socket its job opened', async () => {
    let key = ''
    const c = client({
      verify: async (t) => ({ iss: 'i', run: ['1'], job: t }),
      upgrade: (k) => {
        key = k
        return new Response(null, { status: 101 })
      },
    })
    const o = (await c.call(R, 'join', { role: 'orchestrator' }, '', 'job-1')).json.id
    const a = (await c.call(R, 'join', { role: 'agent' }, '', 'job-2')).json.id
    const upgrade = async (token: string) =>
      c.relay.fetch(
        (await c.request(R, 'socket', undefined, `?id=${o}`, token, { upgrade: 'websocket' }))[0],
      )
    expect((await upgrade('job-2')).status).toBe(403)
    expect((await upgrade('job-1')).status).toBe(101)
    expect(c.relay.attach(key, o, { send() {}, close() {} })).toBe(true)
    expect(JSON.parse(c.relay.frame(key, o, JSON.stringify({ n: 1, to: a, body: 'go' })))).toEqual({
      n: 1,
    })
    expect((await c.call(R, 'poll', undefined, `?id=${a}&wait=0`, 'job-2')).json.messages).toEqual([
      { from: 'orchestrator', body: 'go' },
    ])
  })

  it('keeps the key its orchestrator claimed the run with: no other acts as it', async () => {
    const c = client()
    expect((await c.call(R, 'join', { role: 'orchestrator', key: undefined })).json).toEqual({
      error: 'an orchestrator joins with key: its P-256 public key',
    })
    expect((await c.call(R, 'join', { role: 'orchestrator', key: 'AAAA' })).status).toBe(400)
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'agent')
    const owner = c.provers.get(o)!
    const other = await createProver()
    const status = async (req: Request) => (await c.relay.fetch(req)).status
    const poll = (proof?: string) =>
      new Request(`http://relay/v1/runs/${R}/poll?id=${o}&wait=0`, {
        headers: proof === undefined ? {} : { 'vx-proof': proof },
      })
    const path = `/v1/runs/${R}/poll?id=${o}&wait=0`
    const replayed = await owner.proof('GET', path, '')
    // A key not the run's signs nothing as its orchestrator, nor claims the run again.
    expect([
      await status(poll()),
      await status(poll(await other.proof('GET', path, ''))),
      await status(poll(await owner.proof('GET', `/v1/runs/${R}/poll?id=${a}&wait=0`, ''))),
      await status(poll(replayed)),
      await status(poll(replayed)),
      (await c.call(R, 'send', { id: o, to: a, body: 1 })).status,
      (await c.call(R, 'join', { role: 'orchestrator' })).status,
    ]).toEqual([403, 403, 403, 200, 403, 204, 409])
    const stale = poll(
      (await owner.proof('GET', path, '')).replace(/^\d+/, String(Date.now() - 3 * 60_000)),
    )
    expect(await status(stale)).toBe(403)
  })

  it('limits each participant’s requests to a burst, then a steady rate', async () => {
    const c = client()
    await c.join(R, 'orchestrator')
    const a = await c.join(R, 'agent')
    const b = await c.join(R, 'agent')
    const send = (id: string) => c.call(R, 'send', { id, to: 'orchestrator', body: 1 })
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
    expect(limited.json).toEqual({ error: 'rate limited', retryAfterMs: expect.any(Number) })
    // Another participant spends its own.
    expect((await send(b)).status).toBe(204)
    await Bun.sleep(limited.json.retryAfterMs)
    expect((await send(a)).status).toBe(204)
  })

  it('lets the orchestrator remove an agent it did not admit, before or after it came', async () => {
    const c = client()
    const early = await c.join(R, 'agent')
    const o = await c.join(R, 'orchestrator')
    const late = await c.join(R, 'agent')
    expect((await c.call(R, 'remove', { id: early, agent: late })).json).toEqual({
      error: 'only the orchestrator removes',
    })
    expect((await c.call(R, 'remove', { id: o, agent: o })).status).toBe(404)
    await c.call(R, 'send', { id: o, to: early, body: { type: 'refused' } })
    for (const agent of [early, late]) {
      expect((await c.call(R, 'remove', { id: o, agent })).status).toBe(204)
      expect((await c.call(R, 'send', { id: agent, to: 'orchestrator', body: 1 })).status).toBe(404)
    }
    // What it was told before it went, once; then the relay knows it no more.
    expect(await c.poll(R, early)).toEqual([{ from: 'orchestrator', body: { type: 'refused' } }])
    expect((await c.call(R, 'poll', undefined, `?id=${early}&wait=0`)).status).toBe(404)
    // Removed, not lost: the orchestrator hears only that each came.
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: early, info: null } },
      { from: 'relay', body: { type: 'joined', id: late, info: null } },
    ])
  })

  it('answers malformed requests with their status', async () => {
    const c = client()
    expect((await c.call('bad run', 'join', { role: 'agent' })).status).toBe(400)
    expect((await c.call('900-42', 'join', { role: 'agent' })).json).toEqual({
      error: 'run id is not a random UUID',
    })
    expect((await c.call(R, 'join', { role: 'boss' })).status).toBe(400)
    expect((await c.call(R, 'send', { id: 'nope', to: 'orchestrator' })).status).toBe(404)
    expect((await c.call(R, 'join', { role: 'agent', info: 'x'.repeat(1 << 20) })).json).toEqual({
      error: 'body over 1 MiB',
    })
    expect((await c.call(R, 'poll', { id: 'x' })).status).toBe(405)
  })

  it('holds at most 64 MiB for a participant that does not poll', async () => {
    const c = client()
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'agent')
    const body = 'x'.repeat((1 << 20) - 100)
    const statuses: number[] = []
    for (let i = 0; i < 66; i++) {
      statuses.push((await c.call(R, 'send', { id: o, to: a, body })).status)
    }
    expect(statuses.indexOf(429)).toBe(64)
    expect((await c.poll(R, a)).length).toBe(64)
    expect((await c.call(R, 'send', { id: o, to: a, body })).status).toBe(204)
  })

  it('wants a bearer token when it verifies', async () => {
    const c = client({ verify: async () => ({ iss: 'i', run: ['1'] }) })
    expect((await c.call(R, 'join', { role: 'agent' })).status).toBe(401)
    expect((await c.call(R, 'join', { role: 'agent' }, '', 't')).status).toBe(200)
  })

  it('names a run by its id and its repository: another repository cannot take its id', async () => {
    // The token names its repository; a GitHub run id is guessable, so
    // another tenant of the relay could open it first.
    const c = client({ verify: async (t) => ({ iss: 'https://gitlab.com', run: [t] }) })
    const theirs = (await c.call(R, 'join', { role: 'orchestrator' }, '', 'other')).json.id
    const mine = await c.call(R, 'join', { role: 'orchestrator' }, '', 'mine')
    const agent = (await c.call(R, 'join', { role: 'agent' }, '', 'mine')).json.id
    const polled = async (id: string, token: string) =>
      (await c.call(R, 'poll', undefined, `?id=${id}&wait=0`, token)).json
    expect([
      mine.status,
      await polled(mine.json.id, 'mine'),
      await polled(theirs, 'other'),
      await polled(agent, 'other'),
    ]).toEqual([
      200,
      { messages: [{ from: 'relay', body: { type: 'joined', id: agent, info: null } }] },
      { messages: [] },
      { error: 'unknown id' },
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
    const a = (await before.call(R, 'join', { role: 'agent', info: 'sealed' }, '', 't')).json.id
    const b = (await before.call(R, 'join', { role: 'agent', info: 'sealed' }, '', 't')).json.id
    await before.call(R, 'poll', undefined, `?id=${o}&wait=0`, 't')
    await before.call(R, 'send', { id: o, to: a, body: 'secret' }, '', 't')
    // Nothing kept says whose run it is, what was sent, or what an agent said once told.
    const kept = JSON.stringify([...store.kv])
    expect([
      kept.includes('secret'),
      kept.includes('sealed'),
      kept.includes('gitlab'),
      kept.includes('project-xyz'),
      kept.includes(R),
    ]).toEqual([false, false, false, false, false])
    // The orchestrator's key, kept: it still signs as the run's orchestrator.
    const after = client({ store, timer: false, verify }, before.provers)
    const polled = async (id: string) =>
      (await after.call(R, 'poll', undefined, `?id=${id}&wait=0`, 't')).json
    // `a`'s queue held a message the restart lost: `a` is lost, `b` goes on.
    expect([await polled(a), await polled(b), await polled(o)]).toEqual([
      { error: 'unknown id' },
      { messages: [] },
      { messages: [{ from: 'relay', body: { type: 'lost', id: a } }] },
    ])
  })

  it('holds an agent’s info only until the orchestrator is told it', async () => {
    const store = memory()
    const c = client({ store, timer: false })
    const a = await c.join(R, 'agent', 'sealed')
    expect(JSON.stringify([...store.kv]).includes('sealed')).toBe(true)
    const o = await c.join(R, 'orchestrator')
    expect(JSON.stringify([...store.kv]).includes('sealed')).toBe(false)
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: 'sealed' } },
    ])
  })

  it('remembers a closed run a day by its hash alone, so its id never opens again', async () => {
    const store = memory()
    const c = client({ store, timer: false })
    const o = await c.join(R, 'orchestrator')
    await c.join(R, 'agent')
    await c.call(R, 'leave', { id: o })
    const clock = Date.now
    const at = (ms: number) => {
      const now = clock()
      Date.now = () => now + ms
      try {
        c.relay.sweep()
      } finally {
        Date.now = clock
      }
    }
    at(11 * 60_000)
    expect([...store.kv]).toEqual([
      [`r/${K}`, { closed: true, closedAt: expect.any(Number), pin: null, cert: null }],
    ])
    expect((await c.call(R, 'join', { role: 'agent' })).status).toBe(410)
    at(25 * 60 * 60_000)
    expect([...store.kv]).toEqual([])
  })

  it('sweeps when its host asks, and says when to ask next', async () => {
    const c = client({ heartbeatMs: 20, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'agent')
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
  it('gives a participant on a socket twelve heartbeats, one polling three', async () => {
    const c = client({ heartbeatMs: 20, timer: false })
    const o = await c.join(R, 'orchestrator')
    const a = await c.join(R, 'agent')
    const b = await c.join(R, 'agent')
    expect(c.relay.attach(K, a, { send() {}, close() {} })).toBe(true)
    await Bun.sleep(70)
    c.relay.seen(K, o, Date.now())
    const next = c.relay.sweep()!
    expect(await c.poll(R, o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: a, info: null } },
      { from: 'relay', body: { type: 'joined', id: b, info: null } },
      { from: 'relay', body: { type: 'lost', id: b } },
    ])
    // The socket's silence is what the next sweep waits for: o polls.
    expect(next - Date.now()).toBeGreaterThan(40)
    await Bun.sleep(200)
    c.relay.seen(K, o, Date.now())
    c.relay.sweep()
    expect(await c.poll(R, o)).toEqual([{ from: 'relay', body: { type: 'lost', id: a } }])
  })

  it('pushes messages down a socket and takes sends from it', async () => {
    const c = client({ upgrade: () => new Response(null, { status: 101 }) })
    const joined = await c.call(R, 'join', { role: 'orchestrator' })
    expect(joined.json.socket).toBe(true)
    const o = joined.json.id
    const a = await c.join(R, 'agent')
    await c.call(R, 'send', { id: o, to: a, body: 'queued' })
    const frames: unknown[] = []
    const socket = { send: (t: string) => void frames.push(JSON.parse(t)), close() {} }
    expect(c.relay.attach(K, a, socket)).toBe(true)
    await c.call(R, 'send', { id: o, to: a, body: 'pushed' })
    expect(
      JSON.parse(c.relay.frame(K, a, JSON.stringify({ n: 1, to: 'orchestrator', body: 3 }))),
    ).toEqual({ n: 1 })
    expect(JSON.parse(c.relay.frame(K, a, JSON.stringify({ n: 2, to: 'nobody' })))).toEqual({
      n: 2,
      status: 404,
      error: 'unknown to',
    })
    // Refused for its size, still answered by its number, or its sender waits on it forever.
    const huge = JSON.stringify({ n: 3, to: 'orchestrator', body: 'x'.repeat(1 << 20) })
    expect(JSON.parse(c.relay.frame(K, a, huge))).toEqual({
      n: 3,
      status: 413,
      error: 'body over 1 MiB',
    })
    expect(frames).toEqual([
      { messages: [{ from: 'orchestrator', body: 'queued' }] },
      { messages: [{ from: 'orchestrator', body: 'pushed' }] },
    ])
    expect((await c.poll(R, o)).at(-1)).toEqual({ from: a, body: 3 })
    c.relay.detach(K, a, socket)
    await c.call(R, 'send', { id: o, to: a, body: 'after' })
    expect(await c.poll(R, a)).toEqual([{ from: 'orchestrator', body: 'after' }])
    expect(c.relay.attach(K, 'gone', socket)).toBe(false)
  })

  it('answers a socket request without the upgrade header 426', async () => {
    const c = client({ upgrade: () => new Response(null, { status: 101 }) })
    const a = await c.join(R, 'agent')
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
      body: JSON.stringify({ role: 'agent' }),
    })
    expect([res.status, typeof ((await res.json()) as { id: unknown }).id]).toEqual([200, 'string'])
  } finally {
    proc.kill()
    await proc.exited
  }
})
