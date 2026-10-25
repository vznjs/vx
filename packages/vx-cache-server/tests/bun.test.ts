// The Bun server: an S3-compatible bucket, and nothing else.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { oidcAuth } from '@vzn/vx-devtools'
import { s3Blobs } from '../src/bun.js'
import { blobName } from '../src/store.js'
import { createCacheServer, limitsFrom } from '../src/server.js'
import { conformance, scopeOf } from './conformance.js'
import { fakeS3, type FakeS3 } from './fake-s3.js'
import { type Issuer, issuer, JOBS, TRUST, MAIN_JOB } from './issuer.js'

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
  await fetch(new URL(`/v1/artifacts/${k}`, server.url), {
    method: 'PUT',
    body: 'x',
    headers: { authorization: `Bearer ${token}` },
  })
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
