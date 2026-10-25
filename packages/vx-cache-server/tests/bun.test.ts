// The Bun server: an S3-compatible bucket and a SQLite file.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseTokens, sha256, tokenAuth } from '../src/auth.js'
import { s3Blobs, sqliteDb } from '../src/bun.js'
import { createCacheServer } from '../src/server.js'
import { firstScopes, sqliteStore } from '../src/store.js'
import { conformance } from './conformance.js'
import { fakeS3, type FakeS3 } from './fake-s3.js'

const READ = 'read-token'
const WRITE = 'write-token'
const MAX = 7 * 1024 * 1024

let s3: FakeS3
let server: Bun.Server<undefined>
const dir = mkdtempSync(path.join(tmpdir(), 'vx-cache-server-'))

beforeAll(async () => {
  s3 = fakeS3()
  const handle = createCacheServer({
    blobs: s3Blobs(
      new Bun.S3Client({ endpoint: s3.url, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }),
    ),
    store: sqliteStore(sqliteDb(path.join(dir, 'db.sqlite'))),
    authorize: tokenAuth(parseTokens(`read:${await sha256(READ)} write:${await sha256(WRITE)}`)),
    maxArtifactBytes: MAX,
  })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle })
})

afterAll(async () => {
  await server.stop(true)
  await s3.stop()
  rmSync(dir, { recursive: true, force: true })
})

conformance('Bun with S3', {
  base: () => server.url.href,
  read: READ,
  write: WRITE,
  maxArtifactBytes: MAX,
})

it('names blobs by namespace, scope, key and write, and reads no blob for a HEAD', async () => {
  const k = 'abc123'
  const auth = { authorization: `Bearer ${WRITE}` }
  await fetch(new URL(`/v1/artifacts/${k}`, server.url), {
    method: 'PUT',
    body: 'x',
    headers: auth,
  })
  expect([...s3.objects.keys()].filter((n) => n.startsWith(`/b/v1/default/trusted/${k}/`))).toEqual(
    [expect.stringMatching(/^\/b\/v1\/default\/trusted\/abc123\/[0-9a-f-]{36}$/)],
  )
  const before = s3.log.length
  await fetch(new URL(`/v1/artifacts/${k}`, server.url), { method: 'HEAD', headers: auth })
  expect(s3.log.slice(before)).toEqual([])
})

it('answers each key from the first scope that holds it, in the order sent', async () => {
  const db = sqliteDb(':memory:')
  const store = sqliteStore(db)
  await store.init()
  const add = (key: string, scope: string, size: number) =>
    db.run(
      'INSERT INTO artifacts (ns, key, scope, blob, size, duration_ms, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)',
      ['n', key, scope, `${key}/${scope}`, size],
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

it('refuses a TOKENS entry that is no hash', () => {
  expect(() => parseTokens('write:abc')).toThrow('write:abc is not read:<sha256> or write:<sha256>')
  expect(parseTokens('').size).toBe(0)
})

it('answers 404 for an artifact whose blob the bucket dropped', async () => {
  const k = 'd0aa1'
  const auth = { authorization: `Bearer ${WRITE}` }
  await fetch(new URL(`/v1/artifacts/${k}`, server.url), {
    method: 'PUT',
    body: 'abc',
    headers: auth,
  })
  for (const n of s3.objects.keys())
    if (n.startsWith(`/b/v1/default/trusted/${k}/`)) s3.objects.delete(n)
  const res = await fetch(new URL(`/v1/artifacts/${k}`, server.url), { headers: auth })
  expect(res.status).toBe(404)
})
