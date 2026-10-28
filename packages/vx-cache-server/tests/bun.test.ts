// The Bun server: an S3-compatible bucket, and nothing else.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { oidcAuth } from '@vzn/vx-devtools'
import { s3Blobs } from '../src/bun.js'
import { blobName } from '../src/store.js'
import { createCacheServer, limitsFrom } from '../src/server.js'
import { conformance, scopeOf } from './conformance.js'
import { fakeS3, type FakeS3 } from './fake-s3.js'
import { ALLOW, GITHUB, type Issuer, issuer, JOBS, MAIN_JOB, NAMED, REPO } from './issuer.js'

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
    "Unknown option '--bogus'",
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
    [2, 'ALLOW: acme/app is not issuer:owner/repo:workflow\n'],
    [2, 'ALLOW: https://x:acme:ci.yml is not issuer:owner/repo:workflow\n'],
  ])
})

// Unset, the audience was the origin the request named, its Host header:
// a token minted for another service was taken by sending its host.
it('refuses to start without AUDIENCE', () => {
  const cli = Bun.spawnSync(['bun', `${import.meta.dir}/../src/bun.ts`, '--port', '0'], {
    env: { ...process.env, S3_BUCKET: 'b', ALLOW: '', AUDIENCE: '' },
    stderr: 'pipe',
  })
  expect([cli.exitCode, cli.stderr.toString().split('\n')[0]]).toEqual([
    2,
    'set AUDIENCE: the aud a CI token names, the URL clients reach this server at',
  ])
})

it('refuses an empty --port: Number of it is 0, a random port', () => {
  const cli = Bun.spawnSync(['bun', `${import.meta.dir}/../src/bun.ts`, '--port', ''], {
    env: { ...process.env, S3_BUCKET: 'b', ALLOW: '' },
    stderr: 'pipe',
  })
  expect([cli.exitCode, cli.stderr.toString()]).toEqual([2, '--port: not a port: \n'])
})
