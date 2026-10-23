// Encryption over the relay: only a side with the run's key completes the
// Noise handshake, the relay sees no body, and a body it changes or replays
// does not get through.

import { afterEach, expect, it } from 'bun:test'
import { githubProof, SealError, sealWorker, sealOrchestrator, secretProof } from '../src/seal.js'
import { join, type Participant, type RelayMessage } from '../src/wire.js'
import { servedRelay } from './served-relay.js'

/** Run ids: random UUIDs, as the relay takes. */
const R = '00000000-0000-4000-8000-000000000001'
const R2 = '00000000-0000-4000-8000-000000000002'
const R3 = '00000000-0000-4000-8000-000000000003'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
})

/** A relay that keeps every send it carries, and can change the next one. */
function relay() {
  const bodies: string[] = []
  let tamper: ((body: string) => string) | undefined
  const served = servedRelay({}, (text) => {
    const frame = JSON.parse(text) as { sends?: unknown[] }
    if (frame.sends === undefined) return text
    frame.sends = frame.sends.map((send) => {
      let one = JSON.stringify(send)
      bodies.push(one)
      if (tamper !== undefined) {
        one = tamper(one)
        tamper = undefined
      }
      return JSON.parse(one) as unknown
    })
    return JSON.stringify(frame)
  })
  stops.push(() => served.stop())
  return {
    url: served.url,
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

async function pair(secret = 's', workerSecret = secret) {
  const r = relay()
  const o = sealOrchestrator(
    await join(r.url, R, 'orchestrator', null, undefined),
    R,
    secretProof(secret),
  )
  const a = await sealWorker(
    (info) => join(r.url, R, 'worker', info, undefined),
    R,
    secretProof(workerSecret),
    {
      v: 1,
      cores: 2,
    },
  )
  return { r, o, a }
}

it('admits a worker its secret signed, and the relay carries no body it can read', async () => {
  const { r, o, a } = await pair()
  const [joined] = await until(o)
  expect(joined!.body).toEqual({ type: 'joined', id: a.id, info: { v: 1, cores: 2 } })
  // The cache access the run lends its workers is end-to-end encrypted too.
  const welcome = {
    type: 'welcome',
    name: 'worker#1',
    cache: { refs: [], lent: { '@vzn/vx-migrate': 'lent-cache-token' } },
  }
  await o.send(a.id, welcome)
  expect((await until(a)).map((m) => m.body)).toEqual([welcome])
  await a.send('orchestrator', { type: 'start', task: 'app#build-secret-name' })
  expect((await until(o)).map((m) => m.body)).toEqual([
    { type: 'start', task: 'app#build-secret-name' },
  ])
  expect(r.bodies.join('\n')).not.toContain('worker#1')
  expect(r.bodies.join('\n')).not.toContain('lent-cache-token')
  expect(r.bodies.join('\n')).not.toContain('build-secret-name')
})

it('pads each body to its size class, so the relay learns no size within one', async () => {
  const { r, o, a } = await pair()
  await until(o)
  await o.send(a.id, { type: 'welcome' })
  await until(a)
  const sent = r.bodies.length
  for (const task of ['a', 'a'.repeat(150), 'a'.repeat(300), 'a'.repeat(100_000)]) {
    await a.send('orchestrator', { type: 'start', task })
    expect((await until(o)).map((m) => m.body)).toEqual([{ type: 'start', task }])
  }
  const sizes = r.bodies.slice(sent).map((b) => b.length)
  expect(sizes[0]).toBe(sizes[1]!)
  expect(sizes[2]).toBeGreaterThan(sizes[1]!)
  // Past one transport message, whole ones: 100 000 bytes fill two.
  expect((JSON.parse(r.bodies.at(-1)!) as { body: { seal: string[] } }).body.seal).toHaveLength(2)
})

it('refuses a worker with another secret, and a worker refuses an orchestrator with another', async () => {
  const { o, a } = await pair('s', 'other')
  expect(await o.poll()).toEqual([])
  expect((await until(a)).map((m) => m.body)).toEqual([
    { type: 'refused', reason: 'its key is not the run’s: set the same VX_DTE_SECRET' },
  ])
  // And off the run: the relay no longer knows it.
  await expect(a.poll()).rejects.toThrow('relay: unknown id')

  const r = relay()
  const o2 = await join(r.url, R2, 'orchestrator', null, undefined)
  const a2 = await sealWorker(
    (info) => join(r.url, R2, 'worker', info, undefined),
    R2,
    secretProof('s'),
    {
      v: 1,
    },
  )
  const [joined] = await until(o2)
  await o2.send((joined!.body as { id: string }).id, { type: 'hello', noise: 'AAAA' })
  await expect(a2.poll()).rejects.toThrow(SealError)
})

it('loses a worker whose body the relay changed, and drops one it replays', async () => {
  const { r, o, a } = await pair()
  await until(o)
  await o.send(a.id, { type: 'welcome', name: 'worker#1' })
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
      await join(r.url, R3, 'orchestrator', null, undefined),
      R3,
      githubProof(keys),
    )
    const a = await sealWorker(
      (info) => join(r.url, R3, 'worker', info, undefined),
      R3,
      githubProof(keys),
      { v: 1 },
    )
    expect((await until(o)).map((m) => m.body)).toEqual([
      { type: 'joined', id: a.id, info: { v: 1 } },
    ])
    await o.send(a.id, { type: 'welcome', name: 'worker#1' })
    expect((await until(a)).map((m) => m.body)).toEqual([{ type: 'welcome', name: 'worker#1' }])
    // Each side reads GitHub's keys once, for every check it makes.
    const config = `${ISS}/.well-known/openid-configuration`
    expect(fetched.sort()).toEqual([config, config, `${ISS}/jwks`, `${ISS}/jwks`].sort())

    // A token of another repository is refused.
    repo = '12'
    const b = await sealWorker(
      (info) => join(r.url, R3, 'worker', info, undefined),
      R3,
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
