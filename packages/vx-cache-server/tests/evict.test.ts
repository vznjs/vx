// Eviction by age: what outlived its scope's retention goes, row then blob.

import { Database } from 'bun:sqlite'
import { expect, it } from 'bun:test'
import { evict, retentionFrom } from '../src/evict.js'
import { oidcAuth } from '../src/oidc.js'
import { createCacheServer } from '../src/server.js'
import { type Db, sqliteStore } from '../src/store.js'
import { issuer, TRUST, TRUSTED_JOB } from './issuer.js'
import { upload } from './upload.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

async function store() {
  const sqlite = new Database(':memory:', { strict: true })
  const db: Db = {
    all: async <T>(sql: string, p: readonly unknown[]) =>
      sqlite.query(sql).all(...(p as never[])) as T[],
    run: async (sql, p) => sqlite.query(sql).run(...(p as never[])).changes,
    batch: async (s) => s.forEach((x) => sqlite.run(x)),
  }
  const store = sqliteStore(db)
  const objects = new Map<string, string>()
  const blobs = {
    async put(name: string, body: ReadableStream<Uint8Array>) {
      objects.set(name, await new Response(body).text())
    },
    get: async (name: string) => (objects.has(name) ? new Blob([objects.get(name)!]) : null),
    delete: async (name: string) => void objects.delete(name),
  }
  let clock = NOW
  const iss = await issuer()
  const handle = createCacheServer({
    blobs,
    store,
    authorize: oidcAuth({ trust: TRUST, audience: 'http://s', fetchJson: iss.fetchJson }),
    now: () => clock,
  })
  const write = await iss.sign(TRUSTED_JOB, 'http://s')
  const at = (daysAgo: number) => (clock = NOW - daysAgo * DAY)
  const put = (key: string) =>
    handle(new Request('http://s/v1/artifacts/upload', upload([[key, key]], write)))
  return { store, blobs, objects, sqlite, at, put, handle, write }
}

it('evicts each scope by its own age, the row and then its blob, and old timings', async () => {
  const s = await store()
  for (const [key, days] of [
    ['a01d', 31],
    ['cee9', 10],
  ] as const) {
    s.at(days)
    expect((await s.put(key)).status).toBe(204)
  }
  // Branch scopes as an OIDC token writes them: straight rows, the same blob names.
  for (const [key, days] of [
    ['b01d', 8],
    ['bcee', 3],
  ] as const) {
    s.sqlite.run(
      `INSERT INTO artifacts (repo, key, scope, size, created_at) VALUES ('42', ?1, 'refs/heads/f', 4, ?2)`,
      [key, NOW - days * DAY],
    )
    s.objects.set(`v1/42/refs%2Fheads%2Ff/${key}/4`, key)
  }
  for (const days of [31, 5]) {
    s.at(days)
    await s.handle(
      new Request('http://s/v1/timings/upload', {
        method: 'POST',
        body: JSON.stringify({ timings: [{ hash: `h${days}`, durationMs: 1 }] }),
        headers: { authorization: `Bearer ${s.write}`, 'content-type': 'application/json' },
      }),
    )
  }
  expect(await evict(s.store, s.blobs, retentionFrom({}), NOW)).toEqual({
    artifacts: 2,
    timings: 1,
  })
  expect(s.sqlite.query('SELECT key FROM artifacts ORDER BY key').values().flat()).toEqual([
    'bcee',
    'cee9',
  ])
  expect([...s.objects.keys()].sort().map((k) => k.replace(/\/[^/]+$/, ''))).toEqual([
    'v1/42/refs%2Fheads%2Ff/bcee',
    'v1/42/trusted/cee9',
  ])
  expect(s.sqlite.query('SELECT hash FROM timings').values().flat()).toEqual(['h5'])
})

it('sweeps more than one pass of rows, and makes the tables a first sweep needs', async () => {
  const s = await store()
  expect(await evict(s.store, s.blobs, retentionFrom({}), NOW)).toEqual({
    artifacts: 0,
    timings: 0,
  })
  s.at(40)
  for (let i = 0; i < 450; i++) await s.put(`f${i}`)
  expect(
    (await evict(s.store, s.blobs, retentionFrom({ TRUSTED_DAYS: '35' }), NOW)).artifacts,
  ).toBe(450)
  expect(s.objects.size).toBe(0)
})

it('reads TRUSTED_DAYS, BRANCH_DAYS and TIMING_DAYS, and refuses what is not days', () => {
  expect(retentionFrom({ BRANCH_DAYS: '2', TIMING_DAYS: '' })).toEqual({
    trustedDays: 30,
    branchDays: 2,
    timingDays: 30,
  })
  expect(() => retentionFrom({ TRUSTED_DAYS: 'a month' })).toThrow(
    'TRUSTED_DAYS: not a number of days above 0: a month',
  )
  expect(() => retentionFrom({ TIMING_DAYS: '0' })).toThrow(
    'TIMING_DAYS: not a number of days above 0: 0',
  )
})
