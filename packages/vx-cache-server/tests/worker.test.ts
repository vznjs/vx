// src/worker.ts in workerd, the runtime Workers deploy to, with R2.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { conformance, scopeOf } from './conformance.js'
import { ALLOW_VAR, GITHUB, type Issuer, issuer, JOBS, NAMED, REPO } from './issuer.js'

const MAX = 7 * 1024 * 1024
/** The Worker's own origin, its tokens' audience. */
const AUD = 'https://cache.example.com'

let mf: Miniflare
let base: URL
let iss: Issuer

async function start(bindings: Record<string, unknown>, r2Buckets = ['BLOBS']): Promise<Miniflare> {
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
      r2Buckets,
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
    MAX_CHECK_HASHES: '40',
    ALLOW: ALLOW_VAR,
  })
  base = await mf.ready
})

afterAll(() => mf.dispose())

conformance('Workers with R2', {
  base: () => base.href,
  sign: (job) => iss.sign(JOBS[job], AUD),
  issuer: GITHUB,
  repository: REPO,
  maxCheckHashes: 40,
  maxUploadBytes: MAX,
})

it('refuses every request, saying why, while ALLOW, a limit or READ_ACCESS is unset or wrong', async () => {
  for (const [bindings, status, detail] of [
    [{ ALLOW: '' }, 401, 'the server admits no CI: set ALLOW'],
    [
      { ALLOW: 'https://gitlab.com:group/app' },
      500,
      'ALLOW: https://gitlab.com:group/app is not issuer:owner/repo:workflow',
    ],
    // wrangler.jsonc may write a var as a JSON list: "list.split is not a function".
    [
      { ALLOW: [ALLOW_VAR] },
      500,
      'ALLOW: one string of issuer:owner/repo:workflow entries, space separated',
    ],
    [
      { ALLOW: ALLOW_VAR, MAX_CHECK_HASHES: '0' },
      500,
      'MAX_CHECK_HASHES: not a whole number above 0: 0',
    ],
    // A blank AUDIENCE was taken: every token was then "wrong audience".
    [
      { ALLOW: ALLOW_VAR, AUDIENCE: ' ' },
      500,
      'AUDIENCE: the aud CI tokens name, or unset, not blank',
    ],
    [{ ALLOW: ALLOW_VAR, READ_ACCESS: 'yes' }, 500, 'READ_ACCESS: public, or unset, not yes'],
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

// No bucket bound: /v1/capabilities answered 200, and every artifact
// route 502, "Cannot read properties of undefined", blaming R2.
it('refuses every request, saying why, while no R2 bucket is bound as BLOBS', async () => {
  const other = await start({ ALLOW: ALLOW_VAR }, [])
  try {
    const headers = { ...NAMED, authorization: `Bearer ${await iss.sign(JOBS.main, AUD)}` }
    for (const [method, route] of [
      ['GET', '/v1/capabilities'],
      ['GET', '/v1/artifacts/abc'],
      ['PUT', '/v1/artifacts/abc'],
    ] as const) {
      const res = await fetch(new URL(route, await other.ready), {
        method,
        headers,
        ...(method === 'PUT' ? { body: 'x' } : {}),
      })
      expect([route, res.status, await res.json()]).toEqual([
        route,
        500,
        {
          code: 'internal_error',
          message: 'BLOBS: bind an R2 bucket as BLOBS (wrangler.jsonc r2_buckets)',
        },
      ])
    }
  } finally {
    await other.dispose()
  }
})

// jose matches aud exactly: a pasted newline refused every token as the
// wrong audience. A blank one is refused above.
it('reads AUDIENCE without the blanks around it', async () => {
  const other = await start({ ALLOW: ALLOW_VAR, AUDIENCE: ` ${AUD}\n` })
  try {
    const res = await fetch(new URL('/v1/capabilities', await other.ready), {
      headers: { ...NAMED, authorization: `Bearer ${await iss.sign(JOBS.main, AUD)}` },
    })
    expect(res.status).toBe(200)
  } finally {
    await other.dispose()
  }
})

it("answers a read from the data center's cache once R2 served it, and whether it holds one from R2 alone", async () => {
  const hash = crypto.randomUUID().replaceAll('-', '')
  const url = new URL(`/v1/artifacts/${hash}`, base)
  const auth = (job: 'main' | 'read') => iss.sign(JOBS[job], AUD).then((t) => `Bearer ${t}`)
  const put = await fetch(url, {
    method: 'PUT',
    body: 'cached',
    headers: { ...NAMED, authorization: await auth('main') },
  })
  expect(put.status).toBe(204)
  const read = async () =>
    fetch(url, {
      headers: {
        ...NAMED,
        authorization: await auth('read'),
        'vx-scope': scopeOf('refs/heads/main'),
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
  // Not a check, a HEAD or a PUT: R2 alone says what it holds, so a
  // writer sends it again and every data center can read it.
  const head = await fetch(url, {
    method: 'HEAD',
    headers: {
      ...NAMED,
      authorization: await auth('read'),
      'vx-scope': scopeOf('refs/heads/main'),
    },
  })
  expect(head.status).toBe(404)
  const check = await fetch(new URL('/v1/artifacts', base), {
    method: 'POST',
    body: JSON.stringify({ hashes: [hash], scopes: [scopeOf('refs/heads/main')] }),
    headers: { ...NAMED, authorization: await auth('read'), 'content-type': 'application/json' },
  })
  expect(await check.json()).toEqual({ [hash]: null })
  const resent = await fetch(url, {
    method: 'PUT',
    body: 'cached',
    headers: { ...NAMED, authorization: await auth('main') },
  })
  expect(resent.status).toBe(204)
  expect((await bucket.list()).objects).toHaveLength(1)
  // The token is still checked first: no token, no bytes.
  expect(
    (await fetch(url, { headers: { ...NAMED, 'vx-scope': scopeOf('refs/heads/main') } })).status,
  ).toBe(401)
})

// R2 expired an artifact the data center still held, and a writer sent
// it again: every read there answered the old copy for a year, a corrupt
// one too, which the client distrusted and the writer could not replace.
it("drops the data center's copy when R2 takes the artifact again", async () => {
  const hash = crypto.randomUUID().replaceAll('-', '')
  const url = new URL(`/v1/artifacts/${hash}`, base)
  const auth = (job: 'main' | 'read') => iss.sign(JOBS[job], AUD).then((t) => `Bearer ${t}`)
  const put = async (body: string) =>
    (
      await fetch(url, {
        method: 'PUT',
        body,
        headers: { ...NAMED, authorization: await auth('main') },
      })
    ).status
  const read = async () =>
    (
      await fetch(url, {
        headers: {
          ...NAMED,
          authorization: await auth('read'),
          'vx-scope': scopeOf('refs/heads/main'),
        },
      })
    ).text()
  expect(await put('old')).toBe(204)
  expect(await read()).toBe('old')
  await Bun.sleep(200)
  const bucket = (await mf.getR2Bucket('BLOBS')) as unknown as {
    list(): Promise<{ objects: { key: string }[] }>
    delete(keys: string[]): Promise<void>
  }
  await bucket.delete((await bucket.list()).objects.map((o) => o.key))
  expect(await put('new')).toBe(204)
  expect(await read()).toBe('new')
})

it('checks 6 lookups by default: one round of the calls a request has waiting', async () => {
  const other = await start({ ALLOW: ALLOW_VAR })
  try {
    const res = await fetch(new URL('/v1/capabilities', await other.ready), {
      headers: { ...NAMED, authorization: `Bearer ${await iss.sign(JOBS.read, AUD)}` },
    })
    expect(((await res.json()) as { maxCheckHashes: number }).maxCheckHashes).toBe(6)
  } finally {
    await other.dispose()
  }
})
