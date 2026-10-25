// The Bun server: an S3-compatible bucket, and nothing else.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { oidcAuth } from '@vzn/vx-devtools'
import { s3Blobs } from '../src/bun.js'
import { blobName } from '../src/store.js'
import { createCacheServer, limitsFrom } from '../src/server.js'
import { conformance, scopeOf } from './conformance.js'
import { fakeS3, type FakeS3 } from './fake-s3.js'
import { type Issuer, issuer, JOBS, TRUST, MAIN_JOB } from './issuer.js'
import { upload } from './upload.js'

const LIMITS = { maxCheckKeys: 50, maxBatchArtifacts: 20, maxUploadBytes: 7 * 1024 * 1024 }

let s3: FakeS3
let server: Bun.Server<undefined>
let iss: Issuer
let token = ''

beforeAll(async () => {
  s3 = fakeS3()
  iss = await issuer()
  const handle = createCacheServer({
    blobs: s3Blobs(
      new Bun.S3Client({ endpoint: s3.url, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }),
    ),
    authorize: oidcAuth({ trust: TRUST, fetchJson: iss.fetchJson }),
    limits: LIMITS,
  })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle })
  token = await iss.sign(MAIN_JOB, server.url.origin)
})

afterAll(async () => {
  await server.stop(true)
  await s3.stop()
})

conformance('Bun with S3', {
  base: () => server.url.href,
  sign: (job) => iss.sign(JOBS[job], server.url.origin),
  ...LIMITS,
})

it('names an object <issuer>/<id>/<scope>/<hash>, each hashed, and checks it with one HEAD', async () => {
  const k = 'abc123'
  await fetch(new URL('/v1/artifacts/upload', server.url), upload([[k, 'x']], token))
  const main = scopeOf('refs/heads/main')
  const name = await blobName('token.actions.githubusercontent.com', '42', main, k)
  // The write's scope is its token's ref hashed by the server, as a client hashes it.
  expect(name).toBe(
    `${scopeOf('token.actions.githubusercontent.com')}/${scopeOf('42')}/${main}/abc123`,
  )
  expect([...s3.objects.keys()].join()).not.toMatch(/refs|github|\/42\//)
  expect(s3.objects.get(`/b/${name}`)).toEqual(new TextEncoder().encode('x'))
  const before = s3.log.length
  const res = await fetch(new URL('/v1/artifacts/check', server.url), {
    method: 'POST',
    body: JSON.stringify({ keys: [{ scope: main, hash: k }] }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  expect(await res.json()).toEqual({ sizes: [1] })
  expect(s3.log.slice(before).map((l) => l.split('?')[0])).toEqual([`HEAD /b/${name}`])
})

it('names each repository apart', async () => {
  const a = scopeOf('refs/heads/a')
  const name = await blobName('i', '1', a, 'f')
  expect(await blobName('j', '1', a, 'f')).not.toBe(name)
  expect(await blobName('i', '2', a, 'f')).not.toBe(name)
})

it('reads the limits from the environment, and refuses one that is not a count', () => {
  expect(limitsFrom({ MAX_CHECK_KEYS: '9', MAX_UPLOAD_BYTES: '' })).toEqual({ maxCheckKeys: 9 })
  expect(() => limitsFrom({ MAX_BATCH_ARTIFACTS: '1.5' })).toThrow(
    'MAX_BATCH_ARTIFACTS: not a whole number above 0: 1.5',
  )
})

it('streams a 100 MB batch of 40 artifacts both ways, its memory flat', async () => {
  const N = 40
  const SIZE = 2_500_000
  const piece = new Uint8Array(64 * 1024).fill(7)
  /** `size` bytes made as they are read: none held. */
  const made = (size: number) => {
    let left = size
    return new ReadableStream<Uint8Array>({
      pull(c) {
        const n = Math.min(left, piece.length)
        left -= n
        c.enqueue(piece.subarray(0, n))
        if (left === 0) c.close()
      },
    })
  }
  const stored = new Map<string, number>()
  const big = createCacheServer({
    blobs: {
      async put(name, body, size) {
        let n = 0
        for await (const c of body) n += c.length
        if (n !== size) throw new Error(`${n} bytes, not ${size}`)
        stored.set(name, n)
      },
      get: async (name) => {
        const size = stored.get(name)
        return size === undefined ? null : { body: made(size), size }
      },
      size: async (name) => stored.get(name) ?? null,
    },
    authorize: oidcAuth({ trust: TRUST, fetchJson: iss.fetchJson }),
    limits: { maxCheckKeys: 50, maxBatchArtifacts: N, maxUploadBytes: N * SIZE },
  })
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: big, maxRequestBodySize: 2 ** 30 })
  try {
    const auth = `Bearer ${await iss.sign(MAIN_JOB, srv.url.origin)}`
    const hashes = Array.from({ length: N }, (_, i) => `beef${i.toString(16)}`)
    const line = `${JSON.stringify({ artifacts: hashes.map((hash) => ({ hash, size: SIZE })) })}\n`
    async function* body(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode(line)
      for (const _ of hashes) yield* made(SIZE)
    }
    Bun.gc(true)
    const base = process.memoryUsage().rss
    let peak = base
    const watch = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5)
    const t0 = performance.now()
    const it = body()
    const up = await fetch(new URL('/v1/artifacts/upload', srv.url), {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        async pull(c) {
          const { done, value } = await it.next()
          if (done) c.close()
          else c.enqueue(value)
        },
      }),
      headers: {
        authorization: auth,
        'content-type': 'application/vnd.vx-cache.batch',
        'content-length': String(line.length + N * SIZE),
      },
    })
    expect(up.status).toBe(204)
    expect(stored.size).toBe(N)
    const t1 = performance.now()
    const down = await fetch(new URL('/v1/artifacts/download', srv.url), {
      method: 'POST',
      body: JSON.stringify({
        keys: hashes.map((hash) => ({ scope: scopeOf('refs/heads/main'), hash })),
      }),
      headers: { authorization: auth, 'content-type': 'application/json' },
    })
    let n = 0
    for await (const c of down.body!) n += c.length
    const t2 = performance.now()
    clearInterval(watch)
    expect(n).toBeGreaterThan(N * SIZE)
    const mb = (x: number) => Math.round(x / 1e6)
    console.log(
      `100 MB batch: upload ${Math.round(t1 - t0)} ms, download ${Math.round(t2 - t1)} ms, peak rss +${mb(peak - base)} MB`,
    )
    expect(peak - base).toBeLessThan(64e6)
  } finally {
    await srv.stop(true)
  }
})
