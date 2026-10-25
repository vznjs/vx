// The Bun server: an S3-compatible bucket and a SQLite file.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseTokens, sha256, tokenAuth } from '../src/auth.js'
import { s3Blobs, sqliteDb } from '../src/bun.js'
import { createCacheServer } from '../src/server.js'
import { findArtifacts, SCHEMA } from '../src/store.js'
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
    db: sqliteDb(path.join(dir, 'db.sqlite')),
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

it('names blobs by namespace, scope and key, and reads no blob for a HEAD', async () => {
  const k = 'abc123'
  const auth = { authorization: `Bearer ${WRITE}` }
  await fetch(new URL(`/v1/artifacts/${k}`, server.url), {
    method: 'PUT',
    body: 'x',
    headers: auth,
  })
  expect([...s3.objects.keys()]).toContain(`/b/v1/default/trusted/${k}`)
  const before = s3.log.length
  await fetch(new URL(`/v1/artifacts/${k}`, server.url), { method: 'HEAD', headers: auth })
  expect(s3.log.slice(before)).toEqual([])
})

it('answers each key from the first scope that holds it, in the order sent', async () => {
  const db = sqliteDb(':memory:')
  await db.batch(SCHEMA)
  const add = (key: string, scope: string, size: number) =>
    db.run(
      'INSERT INTO artifacts (ns, key, scope, size, duration_ms, created_at) VALUES (?1, ?2, ?3, ?4, 0, 0)',
      ['n', key, scope, size],
    )
  await add('a', 'trusted', 1)
  await add('a', 'refs/heads/f', 2)
  await add('b', 'trusted', 3)
  await add('c', 'refs/heads/other', 4)
  const found = await findArtifacts(db, 'n', ['a', 'b', 'c'], ['refs/heads/f', 'trusted'])
  expect([...found].map(([k, r]) => [k, r.scope, r.size])).toEqual([
    ['a', 'refs/heads/f', 2],
    ['b', 'trusted', 3],
  ])
  const trustedFirst = await findArtifacts(db, 'n', ['a'], ['trusted', 'refs/heads/f'])
  expect(trustedFirst.get('a')?.size).toBe(1)
})

it('refuses a TOKENS entry that is no hash', () => {
  expect(() => parseTokens('write:abc')).toThrow('write:abc is not read:<sha256> or write:<sha256>')
  expect(parseTokens('').size).toBe(0)
})

it('answers 404 for an artifact whose blob the bucket dropped', async () => {
  const k = 'dropped1'
  const auth = { authorization: `Bearer ${WRITE}` }
  await fetch(new URL(`/v1/artifacts/${k}`, server.url), {
    method: 'PUT',
    body: 'abc',
    headers: auth,
  })
  s3.objects.delete(`/b/v1/default/trusted/${k}`)
  const res = await fetch(new URL(`/v1/artifacts/${k}`, server.url), { headers: auth })
  expect(res.status).toBe(404)
})
