// The Workers entry: every request of a run reaches that run's one
// Durable Object, and an object without ALLOW refuses to start.

import { afterEach, expect, it } from 'bun:test'
import worker, {
  RelayRun,
  type DurableObjectNamespace,
  type DurableObjectState,
  type Env,
} from '../src/worker.js'
import { runKey } from '../src/relay.js'

/** Run ids: random UUIDs, as the relay takes. */
const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const C = '00000000-0000-4000-8000-000000000003'
const D = '00000000-0000-4000-8000-000000000004'
const E = '00000000-0000-4000-8000-000000000005'
const R = '00000000-0000-4000-8000-000000000006'

// Only the runtime has it; these tests make no websocket.
Object.assign(globalThis, { WebSocketRequestResponsePair: class {} })

/** An object's state with no websocket, its storage in memory. */
function state(): DurableObjectState {
  const kv = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    storage: {
      kv: {
        put: (k, v) => kv.set(k, v),
        delete: (k) => kv.delete(k),
        list: ({ prefix }) => [...kv].filter(([k]) => k.startsWith(prefix)),
      },
      getAlarm: async () => alarm,
      setAlarm: async (at) => {
        alarm = at
      },
      deleteAll: async () => {
        kv.clear()
        alarm = null
      },
    },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: () => null,
  }
}

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
        o = new RelayRun(state(), env())
        objects.set(name, o)
        made.push(name)
      }
      return { fetch: (req) => o.fetch(req) }
    },
  }
}

const join = (env: Env, run: string, token?: string, origin = 'https://relay.example.com') =>
  worker.fetch(
    new Request(`${origin}/v1/runs/${run}/join`, {
      method: 'POST',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: 'agent' }),
    }),
    env,
  )

it('routes each run to its own object, which checks tokens', async () => {
  let env: Env
  const ns = namespace(() => env)
  env = { RELAY: ns, ALLOW: 'https://gitlab.com:o/r:.gitlab-ci.yml' }
  expect((await join(env, A)).status).toBe(401)
  expect((await join(env, A)).status).toBe(401)
  expect((await join(env, B)).status).toBe(401)
  expect(ns.made).toEqual([await runKey(A, undefined), await runKey(B, undefined)])
  const res = await worker.fetch(new Request('https://relay.example.com/health'), env)
  expect([res.status, await res.json()]).toEqual([404, { error: 'no such route' }])
})

it('gives the same run id of two repositories two objects', async () => {
  let env: Env
  const ns = namespace(() => env)
  env = { RELAY: ns, ALLOW: 'https://gitlab.com:o/r:.gitlab-ci.yml' }
  const unsigned = (project: number) =>
    `${b64({ alg: 'RS256' })}.${b64({ iss: 'https://gitlab.com', project_id: project })}.x`
  await join(env, R, unsigned(1))
  await join(env, R, unsigned(2))
  await join(env, R, unsigned(1))
  const run = (project: string) => runKey(R, { iss: 'https://gitlab.com', run: [project] })
  expect(ns.made).toEqual([await run('1'), await run('2')])
})

it('will not start without ALLOW, or with an entry it cannot read', () => {
  const none: Env = { RELAY: namespace(() => none), ALLOW: ' ' }
  expect(() => new RelayRun(state(), none)).toThrow('vx-dte-relay: set ALLOW')
  const bad: Env = { RELAY: namespace(() => bad), ALLOW: 'o/r' }
  expect(() => new RelayRun(state(), bad)).toThrow(
    'vx-dte-relay: ALLOW: o/r is not issuer:owner/repo:workflow',
  )
})

const ISS = 'https://issuer.example'
const pair = (await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
async function sign(claims: Record<string, unknown>): Promise<string> {
  const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(head))
  return `${head}.${Buffer.from(sig).toString('base64url')}`
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

it('takes its own URL as the audience when AUDIENCE is not set', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === `${ISS}/.well-known/openid-configuration`) {
      return Response.json({ jwks_uri: `${ISS}/jwks` })
    }
    if (url === `${ISS}/jwks`) return Response.json({ keys: [{ ...jwk, kid: 'k1' }] })
    return new Response(null, { status: 404 })
  }) as typeof fetch
  let env: Env
  env = { RELAY: namespace(() => env), ALLOW: `${ISS}:o/r:.gitlab-ci.yml` }
  const token = (aud: string) =>
    sign({
      iss: ISS,
      aud,
      exp: Date.now() / 1000 + 300,
      project_id: 1,
      project_path: 'o/r',
      ci_config_ref_uri: 'issuer.example/o/r//.gitlab-ci.yml@refs/heads/main',
    })
  const mine = await join(env, C, await token('https://relay.example.com'))
  const other = await join(env, D, await token('https://other.example.com'))
  const elsewhere = await join(
    env,
    E,
    await token('https://other.example.com'),
    'https://other.example.com',
  )
  expect([mine.status, other.status, await other.json(), elsewhere.status]).toEqual([
    200,
    401,
    { error: 'wrong audience' },
    200,
  ])
})
