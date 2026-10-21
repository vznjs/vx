// Encryption over the relay: the run's secret admits a key, the relay sees
// no body, and a body it changes or replays does not get through.

import { afterEach, expect, it } from 'bun:test'
import { createRelay } from '@vzn/vx-dte-relay'
import { SealError, sealAgent, sealOrchestrator } from '../src/seal.js'
import { join, type Participant, type RelayMessage } from '../src/wire.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
})

/** A relay that keeps every body it carries, and can change the next one. */
function relay() {
  const r = createRelay()
  const bodies: string[] = []
  let tamper: ((body: string) => string) | undefined
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST' || !req.url.endsWith('/send')) return r.fetch(req)
      let text = await req.text()
      bodies.push(text)
      if (tamper !== undefined) {
        text = tamper(text)
        tamper = undefined
      }
      return r.fetch(new Request(req.url, { method: 'POST', headers: req.headers, body: text }))
    },
  })
  stops.push(async () => {
    r.close()
    await server.stop(true)
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    bodies,
    tamperNext(f: (body: string) => string) {
      tamper = f
    },
  }
}

async function until(p: Participant, n = 1): Promise<RelayMessage[]> {
  const got: RelayMessage[] = []
  while (got.length < n) got.push(...(await p.poll()))
  return got
}

async function pair(secret = 's', agentSecret = secret) {
  const r = relay()
  const o = sealOrchestrator(await join(r.url, 'r', 'orchestrator', null, undefined), 'r', secret)
  const a = await sealAgent(
    (info) => join(r.url, 'r', 'agent', info, undefined),
    'r',
    agentSecret,
    {
      v: 1,
      cores: 2,
    },
  )
  return { r, o, a }
}

it('admits an agent its secret signed, and the relay carries no body it can read', async () => {
  const { r, o, a } = await pair()
  const [joined] = await until(o)
  expect(joined!.body).toEqual({ type: 'joined', id: a.id, info: { v: 1, cores: 2 } })
  await o.send(a.id, { type: 'welcome', name: 'agent#1' })
  expect((await until(a)).map((m) => m.body)).toEqual([{ type: 'welcome', name: 'agent#1' }])
  await a.send('orchestrator', { type: 'start', task: 'app#build-secret-name' })
  expect((await until(o)).map((m) => m.body)).toEqual([
    { type: 'start', task: 'app#build-secret-name' },
  ])
  expect(r.bodies.join('\n')).not.toContain('agent#1')
  expect(r.bodies.join('\n')).not.toContain('build-secret-name')
})

it('refuses an agent with another secret, and an agent refuses an orchestrator with another', async () => {
  const { o, a } = await pair('s', 'other')
  expect(await o.poll()).toEqual([])
  expect((await until(a)).map((m) => m.body)).toEqual([
    { type: 'refused', reason: 'its key is not the run’s: set the same VX_DTE_SECRET' },
  ])

  const r = relay()
  const o2 = await join(r.url, 'r2', 'orchestrator', null, undefined)
  const a2 = await sealAgent((info) => join(r.url, 'r2', 'agent', info, undefined), 'r2', 's', {
    v: 1,
  })
  const [joined] = await until(o2)
  await o2.send((joined!.body as { id: string }).id, { type: 'hello', pub: 'AAAA', mac: 'forged' })
  await expect(a2.poll()).rejects.toThrow(SealError)
})

it('loses an agent whose body the relay changed, and drops one it replays', async () => {
  const { r, o, a } = await pair()
  await until(o)
  await o.send(a.id, { type: 'welcome', name: 'agent#1' })
  await until(a)
  await a.send('orchestrator', { type: 'start', task: 't' })
  const sent = r.bodies.at(-1)!
  await until(o)
  // The same body again: its number was seen.
  r.tamperNext(() => sent)
  await a.send('orchestrator', { type: 'start', task: 'u' })
  await a.send('orchestrator', { type: 'start', task: 'v' })
  expect((await until(o)).map((m) => m.body)).toEqual([{ type: 'start', task: 'v' }])
  r.tamperNext((b) =>
    b.replace(
      /"seal":"(\d+)\.([^.]+)\.(.)/,
      (_, n, iv, c) => `"seal":"${n}.${iv}.${c === 'A' ? 'B' : 'A'}`,
    ),
  )
  await a.send('orchestrator', { type: 'start', task: 'w' })
  expect((await until(o)).map((m) => m.body)).toEqual([{ type: 'lost', id: a.id }])
})
