// Many Bun nodes over one bucket and one Postgres: each request of the
// conformance suite goes to the next node, so a write on one is read on
// another, and racing writes and sweeps meet across nodes.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { parseTokens, sha256, tokenAuth } from '../src/auth.js'
import { s3Blobs } from '../src/bun.js'
import { evict } from '../src/evict.js'
import { postgresStore } from '../src/postgres.js'
import { createCacheServer } from '../src/server.js'
import { conformance } from './conformance.js'
import { fakeS3, type FakeS3 } from './fake-s3.js'
import { postgresBin, startPostgres } from './postgres.js'

const READ = 'read-token'
const WRITE = 'write-token'
const MAX = 7 * 1024 * 1024
const DAY = 86_400_000
const NODES = 3

const bin = postgresBin()
// CI's runners carry Postgres: there a missing one fails, never skips.
if (bin === undefined && process.env['CI'] !== undefined) {
  it('finds Postgres on CI', () => {
    expect('no initdb on PATH or under /usr/lib/postgresql').toBe('')
  })
}

if (bin !== undefined) {
  let pg: Awaited<ReturnType<typeof startPostgres>>
  let s3: FakeS3
  let clock = Date.now()
  const nodes: { server: Bun.Server<undefined>; store: ReturnType<typeof postgresStore> }[] = []
  let turn = 0
  const blobsOf = () =>
    s3Blobs(
      new Bun.S3Client({ endpoint: s3.url, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }),
    )

  beforeAll(async () => {
    pg = await startPostgres(bin)
    s3 = fakeS3()
    const auth = `read:${await sha256(READ)} write:${await sha256(WRITE)}`
    for (let i = 0; i < NODES; i++) {
      const store = postgresStore(pg.url)
      const handle = createCacheServer({
        blobs: blobsOf(),
        store,
        authorize: tokenAuth(parseTokens(auth)),
        maxArtifactBytes: MAX,
        now: () => clock,
      })
      nodes.push({ store, server: Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle }) })
    }
  }, 30_000)

  afterAll(async () => {
    for (const n of nodes) {
      await n.server.stop(true)
      await n.store.close()
    }
    await s3?.stop()
    await pg?.stop()
  })

  conformance(`${NODES} Bun nodes over one bucket and one Postgres`, {
    base: () => nodes[turn++ % NODES]!.server.url.href,
    read: READ,
    write: WRITE,
    maxArtifactBytes: MAX,
  })

  const put = (node: number, key: string, body: string) =>
    fetch(new URL(`/v1/artifacts/${key}`, nodes[node]!.server.url), {
      method: 'PUT',
      body,
      headers: { authorization: `Bearer ${WRITE}` },
    })
  const blobsUnder = (key: string) =>
    [...s3.objects.keys()].filter((n) => n.startsWith(`/b/v1/default/trusted/${key}/`))

  it('leaves one blob per hash when every node writes it at once', async () => {
    const key = crypto.randomUUID().replaceAll('-', '')
    const res = await Promise.all(
      nodes.map((_, i) => put(i, key, String(i).repeat(1000 * (i + 1)))),
    )
    expect(res.map((r) => r.status)).toEqual(nodes.map(() => 202))
    expect(blobsUnder(key)).toHaveLength(1)
  })

  it('sweeps from every node at once, each row and blob deleted once', async () => {
    const old = Array.from({ length: 450 }, () => crypto.randomUUID().replaceAll('-', ''))
    const now = clock
    clock = now - 40 * DAY
    for (let i = 0; i < old.length; i += 50) {
      await Promise.all(old.slice(i, i + 50).map((k, j) => put(j % NODES, k, k)))
    }
    clock = now
    const swept = await Promise.all(
      nodes.map((n) =>
        evict(n.store, blobsOf(), { trustedDays: 30, branchDays: 7, runDays: 90 }, now),
      ),
    )
    // Each sweep deletes at most 800; together they take every old row, none twice.
    expect(swept.reduce((sum, s) => sum + s.artifacts, 0)).toBe(old.length)
    expect(old.flatMap(blobsUnder)).toEqual([])
    const res = await fetch(new URL(`/v1/artifacts/${old[0]}`, nodes[1]!.server.url), {
      method: 'HEAD',
      headers: { authorization: `Bearer ${READ}` },
    })
    expect(res.status).toBe(404)
  })
}
