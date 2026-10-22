// The relay client: over the websocket a relay offers, and over HTTP polls
// when it offers none or the socket goes.

import { afterEach, expect, it } from 'bun:test'
import { createRelay, serveRelay, type RelayServer } from '@vzn/vx-dte-relay'
import { join } from '../src/wire.js'

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

it('talks over the socket the relay offers, polling nothing', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  const asked = verbs()
  const o = await join(s.url, 'r', 'orchestrator', null, undefined)
  const a = await join(s.url, 'r', 'agent', { size: 'small' }, undefined)
  expect(await o.poll()).toEqual([
    { from: 'relay', body: { type: 'joined', id: a.id, info: { size: 'small' } } },
  ])
  await o.send(a.id, { run: 'x#build' })
  expect(await a.poll()).toEqual([{ from: 'orchestrator', body: { run: 'x#build' } }])
  await a.send('orchestrator', 'done')
  expect(await o.poll()).toEqual([{ from: a.id, body: 'done' }])
  await expect(a.send('nobody', 1)).rejects.toThrow('relay send: 404 unknown to')
  await a.leave()
  await o.leave()
  expect(asked).toEqual(['join', 'join', 'leave', 'leave'])
})

it('polls over HTTP once its socket is gone', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  const o = await join(s.url, 'r', 'orchestrator', null, undefined)
  const a = await join(s.url, 'r', 'agent', null, undefined)
  await o.poll()
  // Left by HTTP alone, so the relay closes the agent's socket and its next poll asks HTTP.
  await realFetch(`${s.url}/v1/runs/r/leave`, {
    method: 'POST',
    body: JSON.stringify({ id: a.id }),
  })
  expect(await o.poll()).toEqual([{ from: 'relay', body: { type: 'lost', id: a.id } }])
  const asked = verbs()
  await expect(a.poll()).rejects.toThrow('relay poll: 404 unknown id')
  expect(asked).toEqual(['poll'])
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
  const o = await join(url, 'r', 'orchestrator', null, undefined)
  const a = await join(url, 'r', 'agent', null, undefined)
  expect(await o.poll()).toEqual([
    { from: 'relay', body: { type: 'joined', id: a.id, info: null } },
  ])
  expect(asked).toEqual(['join', 'join', 'poll'])
})
