// src/worker.ts in workerd, the runtime Workers deploy to: participants
// hold websockets on their run's Durable Object.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

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
})}`
const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(head))
const auth = { authorization: `Bearer ${head}.${Buffer.from(sig).toString('base64url')}` }

let mf: Miniflare
let base: URL
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
      bindings: { ISSUERS: ISS, REPOSITORIES: 'o/r', AUDIENCE: 'vx-dte-relay' },
      outboundService: (req: Request) =>
        new URL(req.url).pathname === '/jwks'
          ? Response.json({ keys: [{ ...jwk, kid: 'k1' }] })
          : Response.json({ jwks_uri: `${ISS}/jwks` }),
    }),
  )
  base = await mf.ready
}, 30_000)
afterAll(() => mf?.dispose())

const join = async (role: string, run = R): Promise<{ id: string; socket?: boolean }> =>
  (await (
    await fetch(new URL(`/v1/runs/${run}/join`, base), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ role }),
    })
  ).json()) as { id: string; socket?: boolean }

/** A participant's socket, and the frames it got. */
async function open(id: string): Promise<{ ws: WebSocket; next(): Promise<unknown> }> {
  const ws = new WebSocket(
    new URL(`/v1/runs/${R}/socket?id=${id}`, base).href.replace(/^http/, 'ws'),
    {
      headers: auth,
    },
  )
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
  const os = await open(o.id)
  const as = await open(a.id)
  expect(await os.next()).toEqual({
    messages: [{ from: 'relay', body: { type: 'joined', id: a.id, info: null } }],
  })
  os.ws.send(JSON.stringify({ n: 1, to: a.id, body: 'build' }))
  expect([await os.next(), await as.next()]).toEqual([
    { n: 1 },
    { messages: [{ from: 'orchestrator', body: 'build' }] },
  ])
  as.ws.send(JSON.stringify({ n: 1, to: 'nobody' }))
  as.ws.send('ping')
  expect([await as.next(), await as.next()]).toEqual([
    { n: 1, status: 404, error: 'unknown to' },
    'pong',
  ])
  const left = await fetch(new URL(`/v1/runs/${R}/leave`, base), {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ id: o.id }),
  })
  expect([left.status, await as.next()]).toEqual([
    204,
    { messages: [{ from: 'relay', body: { type: 'closed' } }] },
  ])
})

it('refuses a socket without a token of the run', async () => {
  const a = await join('agent', R3)
  expect(a.socket).toBe(true)
  const res = await fetch(new URL(`/v1/runs/${R2}/socket?id=${a.id}`, base), {
    headers: { ...auth, upgrade: 'websocket' },
  })
  expect([res.status, await res.json()]).toEqual([404, { error: 'unknown run' }])
  const bare = await fetch(new URL(`/v1/runs/${R3}/socket?id=${a.id}`, base), {
    headers: { upgrade: 'websocket' },
  })
  expect(bare.status).toBe(401)
})
