import { afterEach, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { createRelay, type Relay } from '../src/index.js'

const relays: Relay[] = []
afterEach(() => {
  for (const r of relays.splice(0)) r.close()
})

function client(opts: Parameters<typeof createRelay>[0] = {}) {
  const relay = createRelay(opts)
  relays.push(relay)
  const call = async (
    run: string,
    verb: string,
    body?: unknown,
    query = '',
    token?: string,
  ): Promise<{ status: number; json: any }> => {
    const res = await relay.fetch(
      new Request(`http://relay/v1/runs/${run}/${verb}${query}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: res.status, json: res.status === 204 ? null : await res.json() }
  }
  const join = async (run: string, role: string, info?: unknown): Promise<string> =>
    (await call(run, 'join', { role, info })).json.id
  const poll = async (run: string, id: string, wait = 0) =>
    (await call(run, 'poll', undefined, `?id=${id}&wait=${wait}`)).json.messages
  return { relay, call, join, poll }
}

describe('the relay carries one run between its orchestrator and agents', () => {
  it('tells the orchestrator of agents that joined before and after it', async () => {
    const c = client()
    const early = await c.join('r1', 'agent', { size: 'small' })
    const o = await c.join('r1', 'orchestrator')
    const late = await c.join('r1', 'agent', { size: 'large' })
    expect(await c.poll('r1', o)).toEqual([
      { from: 'relay', body: { type: 'joined', id: early, info: { size: 'small' } } },
      { from: 'relay', body: { type: 'joined', id: late, info: { size: 'large' } } },
    ])
  })

  it('passes messages both ways, and an agent reaches only the orchestrator', async () => {
    const c = client()
    const o = await c.join('r', 'orchestrator')
    const a = await c.join('r', 'agent')
    const b = await c.join('r', 'agent')
    await c.poll('r', o)
    expect((await c.call('r', 'send', { id: o, to: a, body: { run: 'x#build' } })).status).toBe(204)
    expect(await c.poll('r', a)).toEqual([{ from: 'orchestrator', body: { run: 'x#build' } }])
    expect((await c.call('r', 'send', { id: a, to: 'orchestrator', body: 'done' })).status).toBe(
      204,
    )
    expect(await c.poll('r', o)).toEqual([{ from: a, body: 'done' }])
    expect((await c.call('r', 'send', { id: a, to: b, body: 'hi' })).status).toBe(404)
    expect(await c.poll('r', b)).toEqual([])
  })

  it('holds a poll until a message arrives', async () => {
    const c = client()
    const o = await c.join('r', 'orchestrator')
    const a = await c.join('r', 'agent')
    const held = c.poll('r', a, 5_000)
    await Bun.sleep(20)
    await c.call('r', 'send', { id: o, to: a, body: 1 })
    const t = performance.now()
    expect(await held).toEqual([{ from: 'orchestrator', body: 1 }])
    expect(performance.now() - t).toBeLessThan(1_000)
  })

  it('answers a held poll empty when its wait ends', async () => {
    const c = client()
    const a = await c.join('r', 'agent')
    expect(await c.poll('r', a, 30)).toEqual([])
  })

  it('refuses a second orchestrator', async () => {
    const c = client()
    await c.join('r', 'orchestrator')
    expect((await c.call('r', 'join', { role: 'orchestrator' })).status).toBe(409)
  })

  it('reports a lost agent and closes the run when the orchestrator goes', async () => {
    const c = client({ heartbeatMs: 20 })
    const o = await c.join('r', 'orchestrator')
    const a = await c.join('r', 'agent')
    const b = await c.join('r', 'agent')
    await c.poll('r', o)
    // a keeps polling; b falls silent past three heartbeats.
    const deadline = Date.now() + 2_000
    let lost: unknown[] = []
    while (lost.length === 0 && Date.now() < deadline) {
      await c.poll('r', a)
      lost = (await c.poll('r', o, 10)).filter((m: any) => m.body.type === 'lost')
    }
    expect(lost).toEqual([{ from: 'relay', body: { type: 'lost', id: b } }])
    const held = c.poll('r', a, 5_000)
    await Bun.sleep(5)
    expect((await c.call('r', 'leave', { id: o })).status).toBe(204)
    expect(await held).toEqual([{ from: 'relay', body: { type: 'closed' } }])
    expect((await c.call('r', 'join', { role: 'agent' })).status).toBe(410)
  })

  it('answers malformed requests with their status', async () => {
    const c = client()
    expect((await c.call('bad run', 'join', { role: 'agent' })).status).toBe(400)
    expect((await c.call('r', 'join', { role: 'boss' })).status).toBe(400)
    expect((await c.call('r', 'send', { id: 'nope', to: 'orchestrator' })).status).toBe(404)
    expect((await c.call('r', 'join', { role: 'agent', info: 'x'.repeat(1 << 20) })).json).toEqual({
      error: 'body over 1 MiB',
    })
    expect((await c.call('r', 'poll', { id: 'x' })).status).toBe(405)
  })

  it('holds at most 64 MiB for a participant that does not poll', async () => {
    const c = client()
    const o = await c.join('r', 'orchestrator')
    const a = await c.join('r', 'agent')
    const body = 'x'.repeat((1 << 20) - 100)
    const statuses: number[] = []
    for (let i = 0; i < 66; i++) {
      statuses.push((await c.call('r', 'send', { id: o, to: a, body })).status)
    }
    expect(statuses.indexOf(429)).toBe(64)
    expect((await c.poll('r', a)).length).toBe(64)
    expect((await c.call('r', 'send', { id: o, to: a, body })).status).toBe(204)
  })

  it('wants a bearer token when it verifies', async () => {
    const c = client({ verify: async () => ({ iss: 'i', run: ['1'] }) })
    expect((await c.call('r', 'join', { role: 'agent' })).status).toBe(401)
    expect((await c.call('r', 'join', { role: 'agent' }, '', 't')).status).toBe(200)
  })

  it('names a run by its id and its repository: another repository cannot take its id', async () => {
    // The token names its repository; a GitHub run id is guessable, so
    // another tenant of the relay could open it first.
    const c = client({ verify: async (t) => ({ iss: 'https://gitlab.com', run: [t] }) })
    const theirs = (await c.call('r', 'join', { role: 'orchestrator' }, '', 'other')).json.id
    const mine = await c.call('r', 'join', { role: 'orchestrator' }, '', 'mine')
    const agent = (await c.call('r', 'join', { role: 'agent' }, '', 'mine')).json.id
    const polled = async (id: string, token: string) =>
      (await c.call('r', 'poll', undefined, `?id=${id}&wait=0`, token)).json
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
    const res = await fetch(`${url}/v1/runs/r/join`, {
      method: 'POST',
      body: JSON.stringify({ role: 'orchestrator' }),
    })
    expect([res.status, typeof ((await res.json()) as { id: unknown }).id]).toEqual([200, 'string'])
  } finally {
    proc.kill()
    await proc.exited
  }
})
