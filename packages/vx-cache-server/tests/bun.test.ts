// The Bun server: an S3-compatible bucket and a SQLite file.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { s3Blobs, sqliteDb } from '../src/bun.js'
import { oidcAuth } from '@vzn/vx/oidc'
import { createCacheServer } from '../src/server.js'
import { firstScopes, sqliteStore } from '../src/store.js'
import { conformance } from './conformance.js'
import { fakeS3, type FakeS3 } from './fake-s3.js'
import { type Issuer, issuer, TRUST, TRUSTED_JOB } from './issuer.js'
import { upload } from './upload.js'

const MAX = 7 * 1024 * 1024

let s3: FakeS3
let server: Bun.Server<undefined>
let iss: Issuer
let token = ''
let auth: { authorization: string }
const dir = mkdtempSync(path.join(tmpdir(), 'vx-cache-server-'))

beforeAll(async () => {
  s3 = fakeS3()
  iss = await issuer()
  const handle = createCacheServer({
    blobs: s3Blobs(
      new Bun.S3Client({ endpoint: s3.url, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }),
    ),
    store: sqliteStore(sqliteDb(path.join(dir, 'db.sqlite'))),
    authorize: oidcAuth({ trust: TRUST, fetchJson: iss.fetchJson }),
    maxUploadBytes: MAX,
  })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle })
  token = await iss.sign(TRUSTED_JOB, server.url.origin)
  auth = { authorization: `Bearer ${token}` }
})

afterAll(async () => {
  await server.stop(true)
  await s3.stop()
  rmSync(dir, { recursive: true, force: true })
})

conformance('Bun with S3', {
  base: () => server.url.href,
  sign: (claims) => iss.sign(claims, server.url.origin),
  maxUploadBytes: MAX,
})

it('names blobs by repository, scope, key and size, and reads no blob for a check', async () => {
  const k = 'abc123'
  await fetch(new URL('/v1/artifacts/upload', server.url), upload([[k, 'x']], token))
  expect([...s3.objects.keys()].filter((n) => n.startsWith(`/b/v1/42/trusted/${k}/`))).toEqual([
    `/b/v1/42/trusted/${k}/1`,
  ])
  const before = s3.log.length
  await fetch(new URL('/v1/artifacts/check', server.url), {
    method: 'POST',
    body: JSON.stringify({ hashes: [k] }),
    headers: { ...auth, 'content-type': 'application/json' },
  })
  expect(s3.log.slice(before)).toEqual([])
})

it('answers each key from the first scope that holds it, in the order sent', async () => {
  const db = sqliteDb(':memory:')
  const store = sqliteStore(db)
  await store.init()
  const add = (key: string, scope: string, size: number) =>
    db.run(
      'INSERT INTO artifacts (repo, key, scope, size, created_at) VALUES (?1, ?2, ?3, ?4, 0)',
      ['n', key, scope, size],
    )
  await add('a', 'trusted', 1)
  await add('a', 'refs/heads/f', 2)
  await add('b', 'trusted', 3)
  await add('c', 'refs/heads/other', 4)
  const find = async (keys: string[], scopes: string[]) =>
    firstScopes(await store.artifacts('n', keys, scopes), scopes)
  const found = await find(['a', 'b', 'c'], ['refs/heads/f', 'trusted'])
  expect([...found].map(([k, r]) => [k, r.scope, r.size])).toEqual([
    ['a', 'refs/heads/f', 2],
    ['b', 'trusted', 3],
  ])
  const trustedFirst = await find(['a'], ['trusted', 'refs/heads/f'])
  expect(trustedFirst.get('a')?.size).toBe(1)
})

it('answers 404 for an artifact whose blob the bucket dropped', async () => {
  const k = 'd0aa1'
  await fetch(new URL('/v1/artifacts/upload', server.url), upload([[k, 'abc']], token))
  s3.objects.delete(`/b/v1/42/trusted/${k}/3`)
  const res = await fetch(new URL(`/v1/artifacts/download/${k}`, server.url), { headers: auth })
  expect(res.status).toBe(404)
})
