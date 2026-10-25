// src/worker.ts in workerd, the runtime Workers deploy to, with R2.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { conformance, scopeOf } from './conformance.js'
import { GITHUB, type Issuer, issuer, JOBS, TRUST } from './issuer.js'

const MAX = 7 * 1024 * 1024
/** The Worker's own origin, its tokens' audience. */
const AUD = 'https://cache.example.com'

let mf: Miniflare
let base: URL
let iss: Issuer

async function start(bindings: Record<string, string>): Promise<Miniflare> {
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, '..', 'src', 'worker.ts')],
    target: 'browser',
    format: 'esm',
  })
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await built.outputs[0]!.text(),
      compatibilityDate: '2026-10-01',
      r2Buckets: ['BLOBS'],
      bindings: { AUDIENCE: AUD, ...bindings },
      // The issuer's keys, served to the Worker's fetch without a network.
      outboundService: async (req: Request) =>
        new URL(req.url).origin === GITHUB
          ? Response.json(await iss.fetchJson(req.url))
          : new Response(null, { status: 502 }),
    }),
  )
}

beforeAll(async () => {
  iss = await issuer()
  mf = await start({
    MAX_UPLOAD_BYTES: String(MAX),
    MAX_CHECK_HASHES: '1000',
    TRUST: JSON.stringify(TRUST),
  })
  base = await mf.ready
})

afterAll(() => mf.dispose())

// MAX_CHECK_HASHES 1000 is clamped to what a request's 1000 service calls fit.
conformance('Workers with R2', {
  base: () => base.href,
  sign: (job) => iss.sign(JOBS[job], AUD),
  maxCheckHashes: 990,
  maxUploadBytes: MAX,
})

it('refuses every request, saying why, while TRUST or a limit is unset or wrong', async () => {
  for (const [bindings, status, detail] of [
    [{ TRUST: '' }, 401, 'the server trusts no CI: set TRUST'],
    [
      { TRUST: '[{"iss":"https://gitlab.com"}]' },
      500,
      'TRUST: rule 0: names no project_id (one repository, no *)',
    ],
    [
      { TRUST: JSON.stringify(TRUST), MAX_UPLOAD_BYTES: '104857601' },
      500,
      'MAX_UPLOAD_BYTES: at most 104857600: Workers take a body of 100 MB',
    ],
    [
      { TRUST: JSON.stringify(TRUST), MAX_CHECK_HASHES: '0' },
      500,
      'MAX_CHECK_HASHES: not a whole number above 0: 0',
    ],
  ] as const) {
    const other = await start(bindings)
    try {
      const res = await fetch(new URL('/v1/artifacts/abc', await other.ready))
      expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([
        status,
        detail,
      ])
    } finally {
      await other.dispose()
    }
  }
})

it("answers a read from the data center's cache once R2 served it", async () => {
  const hash = crypto.randomUUID().replaceAll('-', '')
  const url = new URL(`/v1/artifacts/${hash}`, base)
  const auth = (job: 'main' | 'read') => iss.sign(JOBS[job], AUD).then((t) => `Bearer ${t}`)
  const put = await fetch(url, {
    method: 'PUT',
    body: 'cached',
    headers: { authorization: await auth('main') },
  })
  expect(put.status).toBe(204)
  const read = async () =>
    fetch(url, {
      headers: {
        authorization: await auth('read'),
        'x-artifact-scope': scopeOf('refs/heads/main'),
      },
    })
  const first = await read()
  expect([first.status, first.headers.get('cache-control'), await first.text()]).toEqual([
    200,
    'private, max-age=31536000, immutable',
    'cached',
  ])
  await Bun.sleep(200)
  // Gone from R2: only the data center's copy can answer now.
  const bucket = (await mf.getR2Bucket('BLOBS')) as unknown as {
    list(): Promise<{ objects: { key: string }[] }>
    delete(keys: string[]): Promise<void>
  }
  await bucket.delete((await bucket.list()).objects.map((o) => o.key))
  const again = await read()
  expect([again.status, await again.text()]).toEqual([200, 'cached'])
  // A check and a HEAD answer from it too.
  const head = await fetch(url, {
    method: 'HEAD',
    headers: { authorization: await auth('read'), 'x-artifact-scope': scopeOf('refs/heads/main') },
  })
  expect([head.status, head.headers.get('content-length')]).toEqual([200, '6'])
  const check = await fetch(new URL('/v1/artifacts', base), {
    method: 'POST',
    body: JSON.stringify({ hashes: [hash], scopes: [scopeOf('refs/heads/main')] }),
    headers: { authorization: await auth('read'), 'content-type': 'application/json' },
  })
  expect(await check.json()).toEqual({ [hash]: { size: 6, scope: scopeOf('refs/heads/main') } })
  // The token is still checked first: no token, no bytes.
  expect(
    (await fetch(url, { headers: { 'x-artifact-scope': scopeOf('refs/heads/main') } })).status,
  ).toBe(401)
})

it('checks 6 lookups by default: one round of the calls a request has waiting', async () => {
  const other = await start({ TRUST: JSON.stringify(TRUST) })
  try {
    const res = await fetch(new URL('/v1/capabilities', await other.ready), {
      headers: { authorization: `Bearer ${await iss.sign(JOBS.read, AUD)}` },
    })
    expect(((await res.json()) as { maxCheckHashes: number }).maxCheckHashes).toBe(6)
  } finally {
    await other.dispose()
  }
})
