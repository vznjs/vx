// The Workers entry: every request of a run reaches that run's one
// Durable Object, and an object without ISSUERS and AUDIENCE refuses to start.

import { expect, it } from 'bun:test'
import worker, { RelayRun, type DurableObjectNamespace, type Env } from '../src/worker.js'

/** Durable Objects by name, as the runtime keeps them. */
function namespace(env: () => Env): DurableObjectNamespace & { made: string[] } {
  const objects = new Map<string, RelayRun>()
  const made: string[] = []
  return {
    made,
    idFromName: (name) => name,
    get(id) {
      const name = id as string
      let o = objects.get(name)
      if (o === undefined) {
        o = new RelayRun({}, env())
        objects.set(name, o)
        made.push(name)
      }
      return { fetch: (req) => o.fetch(req) }
    },
  }
}

it('routes each run to its own object, which checks tokens', async () => {
  let env: Env
  const ns = namespace(() => env)
  env = { RELAY: ns, ISSUERS: 'https://gitlab.com', AUDIENCE: 'https://relay.example.com' }
  const post = (run: string) =>
    worker.fetch(
      new Request(`https://relay.example.com/v1/runs/${run}/join`, {
        method: 'POST',
        body: JSON.stringify({ role: 'agent' }),
      }),
      env,
    )
  expect((await post('a')).status).toBe(401)
  expect((await post('a')).status).toBe(401)
  expect((await post('b')).status).toBe(401)
  expect(ns.made).toEqual(['a', 'b'])
  const res = await worker.fetch(new Request('https://relay.example.com/health'), env)
  expect([res.status, await res.json()]).toEqual([404, { error: 'no such route' }])
})

it('will not start without ISSUERS and AUDIENCE', () => {
  const env: Env = { RELAY: namespace(() => env), ISSUERS: ' ', AUDIENCE: 'x' }
  expect(() => new RelayRun({}, env)).toThrow('vx-dte-relay: set ISSUERS and AUDIENCE')
})
