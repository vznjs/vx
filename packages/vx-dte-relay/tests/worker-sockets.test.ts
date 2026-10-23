// src/worker.ts in workerd, the runtime Workers deploy to: participants
// hold websockets on their run's Durable Object.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createProver, PROOF_HEADER } from '../src/index.js'

/** Run ids: random UUIDs, as the relay takes. */
const R = '00000000-0000-4000-8000-000000000001'
const R2 = '00000000-0000-4000-8000-000000000002'
const R3 = '00000000-0000-4000-8000-000000000003'

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
const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({
  iss: ISS,
  aud: 'vx-dte-relay',
  exp: Date.now() / 1000 + 600,
  project_id: 1,
  project_path: 'o/r',
  ci_config_ref_uri: 'issuer.example/o/r//.gitlab-ci.yml@refs/heads/main',
})}`
const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(head))
const auth = { authorization: `Bearer ${head}.${Buffer.from(sig).toString('base64url')}` }

let mf: Miniflare
let base: URL
/** The issuer URLs the relay fetched. */
const fetched: string[] = []
beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, '..', 'src', 'worker.ts')],
    target: 'browser',
    format: 'esm',
  })
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await built.outputs[0]!.text(),
      compatibilityDate: '2026-10-01',
      durableObjects: { RELAY: { className: 'RelayRun', useSQLite: true } },
      bindings: { ALLOW: `${ISS}:o/r:.gitlab-ci.yml`, AUDIENCE: 'vx-dte-relay' },
      outboundService: (req: Request) => {
        fetched.push(req.url)
        return new URL(req.url).pathname === '/jwks'
          ? Response.json({ keys: [{ ...jwk, kid: 'k1' }] })
          : Response.json({ jwks_uri: `${ISS}/jwks` })
      },
    }),
  )
  base = await mf.ready
}, 30_000)
afterAll(() => mf?.dispose())

/** The orchestrator's key: it signs each request as the orchestrator. */
const prover = await createProver()
const signed = async (
  method: string,
  path: string,
  body = '',
): Promise<Record<string, string>> => ({
  ...auth,
  [PROOF_HEADER]: await prover.proof(method, path, body),
})

const join = async (role: string, run = R): Promise<{ id: string; socket?: boolean }> => {
  const path = `/v1/runs/${run}/join`
  const body = JSON.stringify(role === 'orchestrator' ? { role, key: prover.key } : { role })
  const res = await fetch(new URL(path, base), {
    method: 'POST',
    headers: role === 'orchestrator' ? await signed('POST', path, body) : auth,
    body,
  })
  return (await res.json()) as { id: string; socket?: boolean }
}

/** A participant's socket, and the frames it got. */
async function open(
  id: string,
  orchestrator = false,
): Promise<{ ws: WebSocket; next(): Promise<unknown> }> {
  const path = `/v1/runs/${R}/socket?id=${id}`
  const ws = new WebSocket(new URL(path, base).href.replace(/^http/, 'ws'), {
    headers: orchestrator ? await signed('GET', path) : auth,
  })
  const frames: unknown[] = []
  let wake: (() => void) | undefined
  ws.onmessage = (e) => {
    frames.push(e.data === 'pong' ? 'pong' : JSON.parse(String(e.data)))
    wake?.()
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const next = async (): Promise<unknown> => {
    while (frames.length === 0) await new Promise<void>((r) => (wake = r))
    return frames.shift()
  }
  return { ws, next }
}

it('offers sockets, pushes each message down one and takes sends from it', async () => {
  const o = await join('orchestrator')
  const a = await join('agent')
  expect([o.socket, a.socket]).toEqual([true, true])
  const os = await open(o.id, true)
  const as = await open(a.id)
  expect(await os.next()).toEqual({
    messages: [{ from: 'relay', body: { type: 'joined', id: a.id, info: null } }],
  })
  os.ws.send(JSON.stringify({ n: 1, sends: [{ to: a.id, body: 'build' }] }))
  expect([await os.next(), await as.next()]).toEqual([
    { n: 1 },
    { messages: [{ from: 'orchestrator', body: 'build' }] },
  ])
  as.ws.send(JSON.stringify({ n: 1, sends: [{ to: 'nobody' }] }))
  as.ws.send('ping')
  expect([await as.next(), await as.next()]).toEqual([
    { n: 1, results: [{ status: 404, error: 'unknown to' }] },
    'pong',
  ])
  os.ws.send(JSON.stringify({ n: 2, leave: true }))
  expect(await as.next()).toEqual({ messages: [{ from: 'relay', body: { type: 'closed' } }] })
})

// A failed upgrade tells a client nothing it can read: one the relay does
// not know is let in and closed as gone, so it stops dialing.
it('closes a socket of a run or id it does not know as gone, and refuses one without a token', async () => {
  const a = await join('agent', R3)
  expect(a.socket).toBe(true)
  const closed = async (run: string, id: string): Promise<number> => {
    const path = `/v1/runs/${run}/socket?id=${id}`
    const ws = new WebSocket(new URL(path, base).href.replace(/^http/, 'ws'), { headers: auth })
    return new Promise((resolve) => (ws.onclose = (e) => resolve(e.code)))
  }
  expect([await closed(R2, a.id), await closed(R3, 'nobody')]).toEqual([4404, 4404])
  const bare = await fetch(new URL(`/v1/runs/${R3}/socket?id=${a.id}`, base), {
    headers: { upgrade: 'websocket' },
  })
  expect(bare.status).toBe(401)
})

it('reads an issuer’s keys once for all the runs it carries', async () => {
  // Each run is its own object; keys read per object cost every join two
  // fetches of the issuer (2026-10-22).
  await join('agent', '00000000-0000-4000-8000-000000000004')
  await join('agent', '00000000-0000-4000-8000-000000000005')
  expect(fetched).toEqual([`${ISS}/.well-known/openid-configuration`, `${ISS}/jwks`])
})
