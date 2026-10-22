// The Workers entry: every request of a run reaches that run's one
// Durable Object, and an object without ISSUERS and REPOSITORIES refuses to start.

import { afterEach, expect, it } from 'bun:test'
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
  env = { RELAY: ns, ISSUERS: 'https://gitlab.com', REPOSITORIES: 'o/r' }
  expect((await join(env, 'a')).status).toBe(401)
  expect((await join(env, 'a')).status).toBe(401)
  expect((await join(env, 'b')).status).toBe(401)
  expect(ns.made).toEqual(['a', 'b'])
  const res = await worker.fetch(new Request('https://relay.example.com/health'), env)
  expect([res.status, await res.json()]).toEqual([404, { error: 'no such route' }])
})

it('will not start without ISSUERS and REPOSITORIES', () => {
  const none: Env = { RELAY: namespace(() => none), ISSUERS: ' ', REPOSITORIES: 'o/r' }
  expect(() => new RelayRun({}, none)).toThrow('vx-dte-relay: set ISSUERS and REPOSITORIES')
  const open: Env = { RELAY: namespace(() => open), ISSUERS: 'https://gitlab.com' }
  expect(() => new RelayRun({}, open)).toThrow('vx-dte-relay: set ISSUERS and REPOSITORIES')
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
  env = { RELAY: namespace(() => env), ISSUERS: ISS, REPOSITORIES: 'o/r' }
  const token = (aud: string) =>
    sign({
      iss: ISS,
      aud,
      exp: Date.now() / 1000 + 300,
      project_id: 1,
      project_path: 'o/r',
    })
  const mine = await join(env, 'c', await token('https://relay.example.com'))
  const other = await join(env, 'd', await token('https://other.example.com'))
  const elsewhere = await join(
    env,
    'e',
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
