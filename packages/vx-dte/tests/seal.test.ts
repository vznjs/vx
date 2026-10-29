// Encryption over the relay: only a side with the run's key completes the
// Noise handshake, the relay sees no body, and a body it changes or replays
// does not get through.

import { afterEach, expect, it } from 'bun:test'
import {
  githubProof,
  oidcToken,
  SealError,
  sealWorker,
  sealOrchestrator,
  secretProof,
} from '../src/seal.js'
import { join, RelayError, type Participant, type RelayMessage } from '../src/wire.js'
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

/** A send as the relay carries it: numbered by the wire, its body sealed. */
type Envelope = { body: { body: { seal: string[] } } }
/** Random text: a body is compressed before it is sealed, and this one barely shrinks. */
const noise = (n: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(n)))
    .toString('base64')
    .slice(0, n)

const sealOf = (send: string): string[] => (JSON.parse(send) as Envelope).body.body.seal

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

// Sealing is async: a big body sealed first reached the wire after a small
// one sealed next (a worker's `end` before its `ran`, 2026-10-26).
it('sends bodies in the order they were asked for, however long each takes to seal', async () => {
  const { o, a } = await pair()
  await until(o)
  await o.send(a.id, { type: 'welcome' })
  await until(a)
  const big = noise(400_000)
  await Promise.all([
    a.send('orchestrator', { type: 'ran', task: big }),
    a.send('orchestrator', { type: 'end', task: 't' }),
  ])
  expect((await until(o, 2)).map((m) => (m.body as { type: string }).type)).toEqual(['ran', 'end'])
})

it('pads each body to its size class, so the relay learns no size within one', async () => {
  const { r, o, a } = await pair()
  await until(o)
  await o.send(a.id, { type: 'welcome' })
  await until(a)
  const sent = r.bodies.length
  for (const task of ['a', noise(150), noise(600), noise(100_000)]) {
    await a.send('orchestrator', { type: 'start', task })
    expect((await until(o)).map((m) => m.body)).toEqual([{ type: 'start', task }])
  }
  // The seal's own size: its envelope's number and ack say nothing of the body.
  const sizes = r.bodies.slice(sent).map((b) => JSON.stringify(sealOf(b)).length)
  expect(sizes[0]).toBe(sizes[1]!)
  expect(sizes[2]).toBeGreaterThan(sizes[1]!)
  // Past one transport message, whole ones: 100 000 bytes fill two.
  expect(sealOf(r.bodies.at(-1)!)).toHaveLength(2)
})

it('compresses a body before it seals it, which no relay can after', async () => {
  const { r, o, a } = await pair()
  await until(o)
  await o.send(a.id, { type: 'welcome' })
  await until(a)
  const sent = r.bodies.length
  const log = 'PASS tests/a.test.ts\n'.repeat(5_000)
  await a.send('orchestrator', { type: 'done', log })
  expect((await until(o)).map((m) => m.body)).toEqual([{ type: 'done', log }])
  // 105 000 bytes of JSON, sealed in the smallest class.
  const seal = sealOf(r.bodies[sent]!)
  expect(seal).toHaveLength(1)
  expect(JSON.stringify(seal).length).toBeLessThan(1_000)
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

// 2026-10-23: a fault is at least a warning. A token check that could
// not run (GitHub's keys unreachable) was refused as a key mismatch, and
// the orchestrator said nothing.
it('a token it could not check refuses the worker by that cause, and says it', async () => {
  const r = relay()
  const said: string[] = []
  const proof = (check: () => Promise<boolean>) => ({
    sign: async () => 'token',
    check,
    mismatch: 'run both in this repository',
  })
  const o = sealOrchestrator(
    await join(r.url, R3, 'orchestrator', null, undefined),
    R3,
    proof(() => Promise.reject(new Error('GitHub keys: HTTP 503'))),
    (m) => said.push(m),
  )
  const a = await sealWorker(
    (info) => join(r.url, R3, 'worker', info, undefined),
    R3,
    proof(async () => true),
    { v: 1 },
  )
  expect(await o.poll()).toEqual([])
  const reason = 'its token could not be checked: GitHub keys: HTTP 503'
  expect((await until(a)).map((m) => m.body)).toEqual([{ type: 'refused', reason }])
  expect(said).toEqual([`dte: refused a worker: ${reason}`])
})

it('loses a worker whose body the relay changed, and drops one it replays', async () => {
  const { r, o, a } = await pair()
  await until(o)
  await o.send(a.id, { type: 'welcome', name: 'worker#1' })
  await until(a)
  await a.send('orchestrator', { type: 'start', task: 't' })
  const sent = sealOf(r.bodies.at(-1)!)
  await until(o)
  // The same sealed body again, in a new send: its seal's number was seen.
  r.tamperNext((b) => {
    const send = JSON.parse(b) as Envelope
    send.body.body.seal = sent
    return JSON.stringify(send)
  })
  await a.send('orchestrator', { type: 'start', task: 'u' })
  await a.send('orchestrator', { type: 'start', task: 'v' })
  expect((await until(o)).map((m) => m.body)).toEqual([{ type: 'start', task: 'v' }])
  r.tamperNext((b) =>
    b.replace(/"seal":\["(\d+)\.(.)/, (_, n, c) => `"seal":["${n}.${c === 'A' ? 'B' : 'A'}`),
  )
  await a.send('orchestrator', { type: 'start', task: 'w' })
  expect((await until(o)).map((m) => m.body)).toEqual([{ type: 'lost', id: a.id }])
})

// A send to a worker already lost failed as a plain Error: the run's batch
// still chained to that worker took it for a refusal and failed tasks
// that had already gone back to the queue, some running elsewhere.
it('a send to a worker it lost is refused as one the relay does not know (404)', async () => {
  const { o, a } = await pair()
  await until(o)
  await a.leave()
  expect((await until(o)).map((m) => (m.body as { type: string }).type)).toEqual(['lost'])
  const err = await o.send(a.id, { type: 'batch' }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(RelayError)
  expect((err as RelayError).status).toBe(404)
})

it('loses a worker whose body the relay spliced from two, each part sealed', async () => {
  const { r, o, a } = await pair()
  await until(o)
  await o.send(a.id, { type: 'welcome', name: 'worker#1' })
  await until(a)
  // Over 64 KiB compressed: two parts each.
  const body = noise(100_000)
  await a.send('orchestrator', body)
  const first = sealOf(r.bodies.at(-1)!)
  expect(first).toHaveLength(2)
  expect((await until(o)).map((m) => m.body)).toEqual([body])
  // A fresh first part, then the delivered body's second: only the first was checked.
  r.tamperNext((b) => {
    const send = JSON.parse(b) as Envelope
    send.body.body.seal = [send.body.body.seal[0]!, first[1]!]
    return JSON.stringify(send)
  })
  await a.send('orchestrator', noise(100_000))
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

it('names exactly the GitHub variables a proof lacks', () => {
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = 'http://127.0.0.1:1/token?v=1'
  delete process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']
  delete process.env['GITHUB_REPOSITORY_ID']
  try {
    expect(() => githubProof()).toThrow(
      /^not a GitHub Actions job with id-token: write \(ACTIONS_ID_TOKEN_REQUEST_TOKEN, GITHUB_REPOSITORY_ID\)$/,
    )
  } finally {
    delete process.env['ACTIONS_ID_TOKEN_REQUEST_URL']
  }
})

it('says a token check GitHub’s keys could not answer, never a key mismatch', async () => {
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = 'http://127.0.0.1:1/token?v=1'
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'req-token'
  process.env['GITHUB_REPOSITORY_ID'] = '11'
  try {
    const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
    const token = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'x',
      exp: Date.now() / 1000 + 300,
    })}.${'A'.repeat(342)}`
    const proof = githubProof(async (url) => {
      throw new Error(`${url}: 503`)
    })
    await expect(proof.check!(token, ['join', R3, 'n'])).rejects.toThrow(
      'https://token.actions.githubusercontent.com/.well-known/openid-configuration: 503',
    )
  } finally {
    for (const k of [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'GITHUB_REPOSITORY_ID',
    ])
      delete process.env[k]
  }
})

// A run's id is a dispatch input, which anyone who reads the repository's
// Actions sees: a job of this repository that is none of the runs the
// orchestrator dispatched (a branch's own dispatch of vx-worker.yml) joined
// main's run as a worker, and got its task env and its cache's write.
it('admits only a worker of a workflow run the orchestrator dispatched, when it names them', async () => {
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
  const ISS = 'https://token.actions.githubusercontent.com'
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const aud = (parts: string[]): string =>
    `vx-dte:${new Bun.CryptoHasher('sha256').update(parts.join('\0')).digest('base64url')}`
  const tokenOf = async (claims: object): Promise<string> => {
    const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ iss: ISS, aud: aud(['join', R3, 'n']), exp: Date.now() / 1000 + 300, repository_id: '11', ...claims })}`
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(head))
    return `${head}.${Buffer.from(sig).toString('base64url')}`
  }
  const keys = async (url: string): Promise<unknown> =>
    url.endsWith('/openid-configuration')
      ? { jwks_uri: `${ISS}/jwks` }
      : { keys: [{ ...jwk, kid: 'k1' }] }
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = 'http://127.0.0.1:1/token?v=1'
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'req-token'
  process.env['GITHUB_REPOSITORY_ID'] = '11'
  try {
    let runs: Set<string> | undefined = new Set(['5'])
    const proof = githubProof(keys, () => runs)
    const parts = ['join', R3, 'n']
    expect(await proof.check!(await tokenOf({ run_id: '5' }), parts)).toBe(true)
    expect(await proof.check!(await tokenOf({ run_id: '6' }), parts)).toBe(false)
    expect(await proof.check!(await tokenOf({}), parts)).toBe(false)
    // A dispatch that named no run: any job of this repository, as before.
    runs = undefined
    expect(await proof.check!(await tokenOf({ run_id: '6' }), parts)).toBe(true)
  } finally {
    for (const k of [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'GITHUB_REPOSITORY_ID',
    ])
      delete process.env[k]
  }
})

// PR #4146, 2026-10-23: one 503 from GitHub's token endpoint ended small#2
// before it joined.
it('asks GitHub for an OIDC token again after a 5xx, three tries at most, never after a 4xx', async () => {
  let calls = 0
  let fail = [503, 502]
  const issuer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      calls++
      const status = fail.shift()
      return status === undefined ? Response.json({ value: 'tok' }) : new Response(null, { status })
    },
  })
  stops.push(async () => {
    await issuer.stop(true)
  })
  const url = `http://127.0.0.1:${issuer.port}/token?v=1`
  expect(await oidcToken(url, 'b', 'aud')).toBe('tok')
  expect(calls).toBe(3)
  calls = 0
  fail = [503, 503, 503, 503]
  await expect(oidcToken(url, 'b', 'aud')).rejects.toThrow("GitHub's OIDC token: HTTP 503")
  expect(calls).toBe(3)
  calls = 0
  fail = [401]
  await expect(oidcToken(url, 'b', 'aud')).rejects.toThrow("GitHub's OIDC token: HTTP 401")
  expect(calls).toBe(1)
})

// A refusal said only its status, and an answer with no token returned
// undefined, which the relay then refused as no token at all.
it("says GitHub's own words when it refuses a token, and an answer that holds none", async () => {
  let answer = (): Response => Response.json({ message: 'audience not allowed' }, { status: 403 })
  const issuer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => answer() })
  stops.push(async () => {
    await issuer.stop(true)
  })
  const url = `http://127.0.0.1:${issuer.port}/token?v=1`
  await expect(oidcToken(url, 'b', 'aud')).rejects.toThrow(
    "GitHub's OIDC token: HTTP 403: audience not allowed",
  )
  answer = () => Response.json({})
  await expect(oidcToken(url, 'b', 'aud')).rejects.toThrow(
    "GitHub's OIDC token: no token in its answer",
  )
})
