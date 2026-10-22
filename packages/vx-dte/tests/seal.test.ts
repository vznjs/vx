// Encryption over the relay: only a side with the run's key completes the
// Noise handshake, the relay sees no body, and a body it changes or replays
// does not get through.

import { afterEach, expect, it } from 'bun:test'
import { createRelay } from '@vzn/vx-dte-relay'
import { githubProof, SealError, sealAgent, sealOrchestrator, secretProof } from '../src/seal.js'
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
  const o = sealOrchestrator(
    await join(r.url, 'r', 'orchestrator', null, undefined),
    'r',
    secretProof(secret),
  )
  const a = await sealAgent(
    (info) => join(r.url, 'r', 'agent', info, undefined),
    'r',
    secretProof(agentSecret),
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
  // The cache access the run lends its agents is end-to-end encrypted too.
  const welcome = {
    type: 'welcome',
    name: 'agent#1',
    cache: { refs: [], lent: { '@vzn/vx-migrate': 'lent-cache-token' } },
  }
  await o.send(a.id, welcome)
  expect((await until(a)).map((m) => m.body)).toEqual([welcome])
  await a.send('orchestrator', { type: 'start', task: 'app#build-secret-name' })
  expect((await until(o)).map((m) => m.body)).toEqual([
    { type: 'start', task: 'app#build-secret-name' },
  ])
  expect(r.bodies.join('\n')).not.toContain('agent#1')
  expect(r.bodies.join('\n')).not.toContain('lent-cache-token')
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
  const a2 = await sealAgent(
    (info) => join(r.url, 'r2', 'agent', info, undefined),
    'r2',
    secretProof('s'),
    {
      v: 1,
    },
  )
  const [joined] = await until(o2)
  await o2.send((joined!.body as { id: string }).id, { type: 'hello', noise: 'AAAA' })
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
    b.replace(/"seal":\["(\d+)\.(.)/, (_, n, c) => `"seal":["${n}.${c === 'A' ? 'B' : 'A'}`),
  )
  await a.send('orchestrator', { type: 'start', task: 'w' })
  expect((await until(o)).map((m) => m.body)).toEqual([{ type: 'lost', id: a.id }])
})

it('on GitHub, admits by OIDC tokens of this repository whose audience is the key, with no secret', async () => {
  const pairKey = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pairKey.publicKey)
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const ISS = 'https://token.actions.githubusercontent.com'
  let repo = '11'
  // GitHub's token endpoint: a token for the asked audience, of `repo`.
  const issuer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const aud = new URL(req.url).searchParams.get('audience')
      if (req.headers.get('authorization') !== 'bearer req-token')
        return new Response(null, { status: 401 })
      const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ iss: ISS, aud, exp: Date.now() / 1000 + 300, repository_id: repo })}`
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pairKey.privateKey,
        Buffer.from(head),
      )
      return Response.json({ value: `${head}.${Buffer.from(sig).toString('base64url')}` })
    },
  })
  stops.push(async () => {
    await issuer.stop(true)
  })
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = `http://127.0.0.1:${issuer.port}/token?v=1`
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'req-token'
  process.env['GITHUB_REPOSITORY_ID'] = '11'
  const fetched: string[] = []
  const keys = async (url: string): Promise<unknown> => {
    fetched.push(url)
    if (url === `${ISS}/.well-known/openid-configuration`) return { jwks_uri: `${ISS}/jwks` }
    return { keys: [{ ...jwk, kid: 'k1' }] }
  }
  try {
    const r = relay()
    const o = sealOrchestrator(
      await join(r.url, 'g', 'orchestrator', null, undefined),
      'g',
      githubProof(keys),
    )
    const a = await sealAgent(
      (info) => join(r.url, 'g', 'agent', info, undefined),
      'g',
      githubProof(keys),
      { v: 1 },
    )
    expect((await until(o)).map((m) => m.body)).toEqual([
      { type: 'joined', id: a.id, info: { v: 1 } },
    ])
    await o.send(a.id, { type: 'welcome', name: 'agent#1' })
    expect((await until(a)).map((m) => m.body)).toEqual([{ type: 'welcome', name: 'agent#1' }])
    // Each side reads GitHub's keys once, for every check it makes.
    const config = `${ISS}/.well-known/openid-configuration`
    expect(fetched.sort()).toEqual([config, config, `${ISS}/jwks`, `${ISS}/jwks`].sort())

    // A token of another repository is refused.
    repo = '12'
    const b = await sealAgent(
      (info) => join(r.url, 'g', 'agent', info, undefined),
      'g',
      githubProof(keys),
      { v: 1 },
    )
    expect(await o.poll()).toEqual([])
    expect((await until(b)).map((m) => m.body)).toEqual([
      {
        type: 'refused',
        reason: 'its key is not the run’s: run it in a job of this repository with id-token: write',
      },
    ])
  } finally {
    for (const k of [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'GITHUB_REPOSITORY_ID',
    ])
      delete process.env[k]
  }
})
