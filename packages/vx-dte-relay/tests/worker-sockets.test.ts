// src/worker.ts in workerd, the runtime Workers deploy to: participants
// hold websockets on their run's Durable Object.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createProver, PROOF_HEADER } from '../src/index.js'
import { conformance } from './conformance.js'

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

/** A socket at `path`, and the frames it got. */
async function dial(
  path: string,
  orchestrator = false,
): Promise<{ ws: WebSocket; next(): Promise<unknown> }> {
  const ws = new WebSocket(new URL(path, base).href.replace(/^http/, 'ws'), {
    headers: orchestrator ? await signed('GET', path) : auth,
    protocols: ['switchboard.v1'],
  } as never)
  const frames: unknown[] = []
  let wake: (() => void) | undefined
  ws.onmessage = (e) => {
    frames.push(JSON.parse(String(e.data)))
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

/** A participant that joined on its socket, and what that socket said first. */
const join = async (role: string, run = R) => {
  const body = JSON.stringify(role === 'host' ? { role, key: prover.key } : { role })
  const s = await dial(
    `/v1/sessions/${run}/socket?join=${encodeURIComponent(body)}`,
    role === 'host',
  )
  const first = (await s.next()) as { joined?: { id: string }; close?: number; error?: string }
  return { ...s, id: first.joined?.id ?? '', first }
}

// A failed upgrade tells a client nothing it can read: one the relay does
// not know is let in and closed as gone, so it stops dialing.
it('closes a socket of a run or id it does not know as gone, and refuses one without a token', async () => {
  await join('host', R3)
  const a = await join('peer', R3)
  // A join refused is let in and closed saying why: a failed upgrade says nothing.
  expect((await join('peer', R2)).first).toEqual({ close: 4410, error: 'no live session' })
  // Said in a frame first: workerd never ends TCP after its close, and Bun
  // 1.4.4's client fires onclose only when it does, 10 s on (PR #4171).
  const closed = async (run: string, id: string): Promise<number> => {
    const path = `/v1/sessions/${run}/socket?id=${id}`
    const ws = new WebSocket(new URL(path, base).href.replace(/^http/, 'ws'), {
      headers: auth,
      protocols: ['switchboard.v1'],
    } as never)
    const code = await new Promise<number>(
      (resolve) => (ws.onmessage = (e) => resolve(JSON.parse(String(e.data)).close)),
    )
    ws.close()
    return code
  }
  expect([await closed(R2, a.id), await closed(R3, 'nobody')]).toEqual([4404, 4404])
  const bare = new WebSocket(
    new URL(`/v1/sessions/${R3}/socket?id=${a.id}`, base).href.replace(/^http/, 'ws'),
    ['switchboard.v1'],
  )
  const said = await new Promise(
    (resolve) => (bare.onmessage = (e) => resolve(JSON.parse(String(e.data)))),
  )
  bare.close()
  expect(said).toEqual({ close: 4401, error: 'no bearer token' })
})

it('reads an issuer’s keys once for all the runs it carries', async () => {
  // Each run is its own object; keys read per object cost every join two
  // fetches of the issuer (2026-10-22).
  await join('peer', '00000000-0000-4000-8000-000000000004')
  await join('peer', '00000000-0000-4000-8000-000000000005')
  expect(fetched).toEqual([`${ISS}/.well-known/openid-configuration`, `${ISS}/jwks`])
})

// Refused before any run's object (ALLOW admits no one), a socket is still
// let in and closed saying why: the client stops dialing on a 4xx.
it('refuses a socket at the door, saying why, when ALLOW admits no run', async () => {
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, '..', 'src', 'worker.ts')],
    target: 'browser',
    format: 'esm',
  })
  const closed = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await built.outputs[0]!.text(),
      compatibilityDate: '2026-10-01',
      durableObjects: { RELAY: { className: 'RelayRun', useSQLite: true } },
      bindings: { ALLOW: ' ' },
    }),
  )
  try {
    const url = (await closed.ready).href.replace(/^http/, 'ws')
    const ws = new WebSocket(
      `${url}v1/sessions/${R}/socket?join=${encodeURIComponent('{"role":"peer"}')}`,
      ['switchboard.v1'],
    )
    const said = await new Promise(
      (resolve) => (ws.onmessage = (e) => resolve(JSON.parse(String(e.data)))),
    )
    ws.close()
    expect(said).toEqual({ close: 4403, error: "this relay's ALLOW is empty: it admits no run" })
  } finally {
    await closed.dispose()
  }
}, 30_000)

conformance('the Workers relay', { base: () => base.href, headers: () => auth })
