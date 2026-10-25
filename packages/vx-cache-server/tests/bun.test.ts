// The Bun server: an S3-compatible bucket, and nothing else.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { oidcAuth } from '@vzn/vx-devtools'
import { s3Blobs } from '../src/bun.js'
import { createCacheServer, limitsFrom } from '../src/server.js'
import { conformance } from './conformance.js'
import { fakeS3, type FakeS3 } from './fake-s3.js'
import { type Issuer, issuer, JOBS, TRUST, TRUSTED_JOB } from './issuer.js'
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
  token = await iss.sign(TRUSTED_JOB, server.url.origin)
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

it('names an object by scope, repository and hash, and checks it with one HEAD', async () => {
  const k = 'abc123'
  await fetch(new URL('/v1/artifacts/upload', server.url), upload([[k, 'x']], token))
  expect(s3.objects.get(`/b/trusted/42/${k}`)).toEqual(new TextEncoder().encode('x'))
  const before = s3.log.length
  const res = await fetch(new URL('/v1/artifacts/check', server.url), {
    method: 'POST',
    body: JSON.stringify({ keys: [{ scope: 'refs/heads/main', hash: k }] }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  expect(await res.json()).toEqual({ sizes: [1] })
  expect(s3.log.slice(before).map((l) => l.split('?')[0])).toEqual([`HEAD /b/trusted/42/${k}`])
})

it('reads the limits from the environment, and refuses one that is not a count', () => {
  expect(limitsFrom({ MAX_CHECK_KEYS: '9', MAX_UPLOAD_BYTES: '' })).toEqual({ maxCheckKeys: 9 })
  expect(() => limitsFrom({ MAX_BATCH_ARTIFACTS: '1.5' })).toThrow(
    'MAX_BATCH_ARTIFACTS: not a whole number above 0: 1.5',
  )
})
