// The Bun server: an S3-compatible bucket, and nothing else.

import { createServer, type AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test'
import { oidcAuth } from '@vzn/vx-devtools'
import { listen, s3Blobs } from '../src/bun.js'
import { blobName } from '../src/store.js'
import { createCacheServer, limitsFrom } from '../src/server.js'
import { conformance, scopeOf } from './conformance.js'
import { fakeS3, type FakeS3 } from './fake-s3.js'
import {
  ALLOW,
  ALLOW_VAR,
  GITHUB,
  type Issuer,
  issuer,
  JOBS,
  MAIN_JOB,
  NAMED,
  REPO,
} from './issuer.js'

const LIMITS = { maxCheckHashes: 50, maxUploadBytes: 7 * 1024 * 1024 }

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
    authorize: oidcAuth({ allow: ALLOW, fetchJson: iss.fetchJson }),
    limits: LIMITS,
  })
  server = listen(handle, '127.0.0.1', 0)
  token = await iss.sign(MAIN_JOB, server.url.origin)
})

afterAll(async () => {
  await server.stop(true)
  await s3.stop()
})

conformance('Bun with S3', {
  base: () => server.url.href,
  sign: (job) => iss.sign(JOBS[job], server.url.origin),
  issuer: GITHUB,
  repository: REPO,
  ...LIMITS,
})

it('names an object <issuer>/<repository>/<scope>/<hash>, each hashed, and checks one HEAD per hash and scope', async () => {
  const k = 'abc123'
  await fetch(new URL(`/v1/artifacts/${k}`, server.url), {
    method: 'PUT',
    body: 'x',
    headers: { ...NAMED, authorization: `Bearer ${token}` },
  })
  const main = scopeOf('refs/heads/main')
  const name = await blobName(GITHUB, REPO, main, k)
  // The write's scope is its token's ref hashed by the server, as a client hashes it.
  expect(name).toBe(`${NAMED['vx-issuer']}/${NAMED['vx-repository']}/${main}/abc123`)
  expect([...s3.objects.keys()].join()).not.toMatch(/refs|github|acme/)
  expect(s3.objects.get(`/b/${name}`)).toEqual(new TextEncoder().encode('x'))
  const before = s3.log.length
  const check = async (hashes: string[]) =>
    (
      await fetch(new URL('/v1/artifacts', server.url), {
        method: 'POST',
        body: JSON.stringify({ hashes, scopes: [main] }),
        headers: { ...NAMED, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      })
    ).json()
  expect(await check([k])).toEqual({ [k]: { size: 1, scope: main } })
  expect(s3.log.slice(before).map((l) => l.split('?')[0])).toEqual([`HEAD /b/${name}`])
})

it('names each repository apart', async () => {
  const a = scopeOf('refs/heads/a')
  const name = await blobName('i', '1', a, 'f')
  expect(await blobName('j', '1', a, 'f')).not.toBe(name)
  expect(await blobName('i', '2', a, 'f')).not.toBe(name)
})

it('reads the limits from the environment, and refuses one that is not a count', () => {
  expect(limitsFrom({ MAX_CHECK_HASHES: '9', MAX_UPLOAD_BYTES: '' })).toEqual({ maxCheckHashes: 9 })
  expect(() => limitsFrom({ MAX_CHECK_HASHES: '1.5' })).toThrow(
    'MAX_CHECK_HASHES: not a whole number above 0: 1.5',
  )
})

// wrangler.jsonc writes a var as JSON: a number was skipped, and the
// default limit served in its place.
it('reads a limit a Worker var gives as a number, and refuses another type', () => {
  expect(limitsFrom({ MAX_UPLOAD_BYTES: 5 })).toEqual({ maxUploadBytes: 5 })
  expect(() => limitsFrom({ MAX_UPLOAD_BYTES: [5] })).toThrow(
    'MAX_UPLOAD_BYTES: not a whole number above 0: [5]',
  )
})

// A truncated upload stored would be a wrong artifact under a right key:
// the worst a cache does.
it('refuses a body of another length than its Content-Length, and stores nothing', async () => {
  const before = s3.objects.size
  for (const [body, length, said] of [
    ['abc', '5', 'the body is 3 bytes, not 5'],
    ['abcdef', '2', 'the body is longer than 2 bytes'],
  ] as const) {
    const res = await createCacheServer({
      blobs: s3Blobs(
        new Bun.S3Client({ endpoint: s3.url, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }),
      ),
      authorize: oidcAuth({ allow: ALLOW, fetchJson: iss.fetchJson }),
    })(
      new Request(`http://x.test/v1/artifacts/fe${length}`, {
        method: 'PUT',
        body: new Blob([body]).stream(),
        headers: {
          ...NAMED,
          authorization: `Bearer ${await iss.sign(MAIN_JOB, 'http://x.test')}`,
          'content-length': length,
        },
        duplex: 'half',
      } as RequestInit),
    )
    expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([400, said])
  }
  expect(s3.objects.size).toBe(before)
})

// Past 5 MB Bun's S3 client uploads in parts: a body that ends short
// must abort the upload, never complete it with the parts sent.
it('stores nothing of a multipart upload that ends short', async () => {
  const before = s3.objects.size
  const blobs = s3Blobs(
    new Bun.S3Client({ endpoint: s3.url, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }),
  )
  const sent = 12 * 1024 * 1024
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= sent) return c.close()
      pulled += 1024 * 1024
      c.enqueue(new Uint8Array(1024 * 1024).fill(97))
    },
  })
  await expect(blobs.put('short', body, sent + 1)).rejects.toThrow(
    `the body is ${sent} bytes, not ${sent + 1}`,
  )
  // The abort goes out after the write rejects.
  const aborted = () => s3.log.some((l) => l.startsWith('DELETE /b/short?uploadId='))
  for (let i = 0; i < 100 && !aborted(); i++) await Bun.sleep(50)
  expect(s3.log.filter((l) => l.startsWith('POST /b/short?')).map((l) => l.split('=')[0])).toEqual([
    'POST /b/short?uploads',
  ])
  expect(aborted()).toBe(true)
  expect(s3.objects.size).toBe(before)
})

it('answers a flag it does not know with its usage', () => {
  const cli = Bun.spawnSync(['bun', `${import.meta.dir}/../src/bun.ts`, '--bogus'], {
    stderr: 'pipe',
  })
  const [said, usage] = cli.stderr.toString().split('\n')
  expect([cli.exitCode, said, usage?.split(' ').slice(0, 2).join(' ')]).toEqual([
    2,
    "✗ vx-cache-server  Unknown option '--bogus'",
    'usage: vx-cache-server',
  ])
})

it('names ALLOW when it cannot be read', () => {
  const said = (allow: string) => {
    const cli = Bun.spawnSync(['bun', `${import.meta.dir}/../src/bun.ts`, '--port', '0'], {
      env: { ...process.env, S3_BUCKET: 'b', ALLOW: allow },
      stderr: 'pipe',
    })
    return [cli.exitCode, cli.stderr.toString()]
  }
  expect([said('acme/app'), said('https://x:acme:ci.yml')]).toEqual([
    [2, '✗ vx-cache-server  ALLOW: acme/app is not issuer:owner/repo:workflow\n'],
    [2, '✗ vx-cache-server  ALLOW: https://x:acme:ci.yml is not issuer:owner/repo:workflow\n'],
  ])
})

it('refuses to start with ALLOW empty: it would refuse every request', () => {
  for (const allow of [undefined, '', ' ']) {
    const cli = Bun.spawnSync(['bun', `${import.meta.dir}/../src/bun.ts`, '--port', '0'], {
      env: { ...process.env, S3_BUCKET: 'b', ...(allow === undefined ? {} : { ALLOW: allow }) },
      stderr: 'pipe',
      // Started, it would listen until killed.
      timeout: 10_000,
    })
    const [said, usage] = cli.stderr.toString().split('\n')
    expect([cli.exitCode, said, usage?.split(' ').slice(0, 2).join(' ')]).toEqual([
      2,
      '✗ vx-cache-server  set ALLOW',
      'usage: vx-cache-server',
    ])
  }
})

it('refuses an empty --port: Number of it is 0, a random port', () => {
  const cli = Bun.spawnSync(['bun', `${import.meta.dir}/../src/bun.ts`, '--port', ''], {
    env: { ...process.env, S3_BUCKET: 'b', ALLOW: '' },
    stderr: 'pipe',
  })
  expect([cli.exitCode, cli.stderr.toString()]).toEqual([
    2,
    '✗ vx-cache-server  --port: not a port: \n',
  ])
})

// With no S3 credentials the server listened, said so, and answered every
// request 502: a deploy looked up while it could serve nothing.
it('refuses to start with no S3 credentials', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(S3|AWS)_/.test(k)))
  const cli = Bun.spawnSync(['bun', `${import.meta.dir}/../src/bun.ts`, '--port', '0'], {
    env: { ...env, S3_BUCKET: 'b', ALLOW: ALLOW_VAR },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 3000,
  })
  expect([cli.exitCode, cli.stdout.toString(), cli.stderr.toString()]).toEqual([
    2,
    '',
    expect.stringMatching(/^✗ vx-cache-server {2}S3: Missing S3 credentials\./),
  ])
})

// Bun's fetch asks for gzip and inflates what it is sent, so a bucket (or
// a proxy before it) that compressed an answer named the compressed
// Content-Length as the artifact's size: a check and a download said
// fewer bytes than the artifact holds.
it('reads sizes off the bytes as stored, never a compressed answer', async () => {
  const bytes = 'vx '.repeat(10_000)
  const gzipping = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (!/gzip/.test(req.headers.get('accept-encoding') ?? '')) {
        return new Response(req.method === 'HEAD' ? null : bytes, {
          headers: { 'content-length': String(bytes.length) },
        })
      }
      const z = Bun.gzipSync(bytes)
      return new Response(req.method === 'HEAD' ? null : z, {
        headers: { 'content-encoding': 'gzip', 'content-length': String(z.byteLength) },
      })
    },
  })
  try {
    const blobs = s3Blobs(
      new Bun.S3Client({
        endpoint: gzipping.url.href,
        bucket: 'b',
        accessKeyId: 'a',
        secretAccessKey: 's',
      }),
    )
    const got = (await blobs.get('x'))!
    expect([got.size, (await new Response(got.body).text()).length, await blobs.size('x')]).toEqual(
      [bytes.length, bytes.length, bytes.length],
    )
  } finally {
    await gzipping.stop(true)
  }
})

// Number(null) is 0: a HEAD naming no Content-Length was an artifact of
// 0 bytes to a check and a HEAD. A download sent chunked still serves:
// Bun frames a streamed answer itself.
it('takes no size the bucket did not state', async () => {
  const unsized = createServer((sock) =>
    sock.once('data', () =>
      sock.end('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n'),
    ),
  )
  await new Promise<void>((r) => unsized.listen(0, '127.0.0.1', r))
  try {
    const blobs = s3Blobs(
      new Bun.S3Client({
        endpoint: `http://127.0.0.1:${(unsized.address() as AddressInfo).port}`,
        bucket: 'b',
        accessKeyId: 'a',
        secretAccessKey: 's',
      }),
    )
    await expect(blobs.size('x')).rejects.toThrow('the bucket answered HEAD with no Content-Length')
    expect(await new Response((await blobs.get('x'))!.body).text()).toBe('abc')
  } finally {
    unsized.close()
  }
})

// The bucket's fault is not the server's: a 500 said the server broke,
// where the bucket an operator runs is what to look at.
it("answers a bucket that cannot be read 502, naming the bucket's answer", async () => {
  const down = async (): Promise<never> => {
    throw new Error('the bucket answered HEAD 503')
  }
  const handle = createCacheServer({
    blobs: { get: down, size: down, put: down },
    authorize: oidcAuth({ allow: ALLOW, fetchJson: iss.fetchJson }),
  })
  const headers = {
    ...NAMED,
    authorization: `Bearer ${await iss.sign(MAIN_JOB, 'http://x.test')}`,
    'vx-scope': scopeOf('refs/heads/main'),
  }
  const said = async (path: string, init: RequestInit = {}) => {
    const res = await handle(new Request(`http://x.test${path}`, { headers, ...init }))
    return [res.status, await res.json()]
  }
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const bucket = {
    code: 'bad_gateway',
    message: 'the bucket could not be read: the bucket answered HEAD 503',
  }
  expect([
    await said('/v1/artifacts/ab'),
    await said('/v1/artifacts', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: ['ab'], scopes: [scopeOf('refs/heads/main')] }),
    }),
    await said('/v1/artifacts/ab', {
      method: 'PUT',
      headers: { ...headers, 'content-length': '1' },
      body: 'x',
    }),
  ]).toEqual([
    [502, bucket],
    [502, bucket],
    [502, bucket],
  ])
  // The operator sees it too: a 502 is no client's to fix.
  expect(logged.mock.calls.map(([line]) => line)).toEqual([
    `vx-cache-server: GET /v1/artifacts/ab: ${bucket.message}`,
    `vx-cache-server: POST /v1/artifacts: ${bucket.message}`,
    `vx-cache-server: PUT /v1/artifacts/ab: ${bucket.message}`,
  ])
  logged.mockRestore()
})

// A failed request logged the bare error, no server name, method or route,
// beside the history server's `vx-history-server: <method> <path>: <why>`.
it('logs a request it failed with its name, method and path', async () => {
  const errors: string[] = []
  const logged = console.error
  console.error = (...args: unknown[]) => void errors.push(args.join(' '))
  try {
    const res = await createCacheServer({
      blobs: {
        put: async () => {},
        get: async () => null,
        size: async () => {
          throw new Error('the bucket is down')
        },
      },
      authorize: oidcAuth({ allow: ALLOW, fetchJson: iss.fetchJson }),
    })(
      new Request('http://x.test/v1/artifacts/abc', {
        method: 'HEAD',
        headers: {
          ...NAMED,
          'vx-scope': 'a'.repeat(32),
          authorization: `Bearer ${await iss.sign(MAIN_JOB, 'http://x.test')}`,
        },
      }),
    )
    expect(res.status).toBe(500)
  } finally {
    console.error = logged
  }
  expect(errors).toEqual(['vx-cache-server: HEAD /v1/artifacts/abc: Error: the bucket is down'])
})
