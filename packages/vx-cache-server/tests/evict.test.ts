// Eviction by age: what outlived its scope's retention goes, row then blob.

import { Database } from 'bun:sqlite'
import { expect, it } from 'bun:test'
import { parseTokens, sha256, tokenAuth } from '../src/auth.js'
import { evict, retentionFrom } from '../src/evict.js'
import { createCacheServer } from '../src/server.js'
import { type Db, sqliteStore } from '../src/store.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const WRITE = 'write-token'

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
  const handle = createCacheServer({
    blobs,
    store,
    authorize: tokenAuth(parseTokens(`write:${await sha256(WRITE)}`)),
    now: () => clock,
  })
  const at = (daysAgo: number) => (clock = NOW - daysAgo * DAY)
  const put = (key: string) =>
    handle(
      new Request(`http://s/v1/artifacts/${key}`, {
        method: 'PUT',
        body: key,
        headers: { authorization: `Bearer ${WRITE}`, 'content-length': String(key.length) },
      }),
    )
  return { store, blobs, objects, sqlite, at, put, handle }
}

it('evicts each scope by its own age, the row and then its blob, and old runs', async () => {
  const s = await store()
  for (const [key, days] of [
    ['a01d', 31],
    ['cee9', 10],
  ] as const) {
    s.at(days)
    expect((await s.put(key)).status).toBe(202)
  }
  // Branch scopes as an OIDC token writes them: straight rows, the same blob names.
  for (const [key, days] of [
    ['b01d', 8],
    ['bcee', 3],
  ] as const) {
    s.sqlite.run(
      `INSERT INTO artifacts (ns, key, scope, blob, size, duration_ms, created_at) VALUES ('default', ?1, 'refs/heads/f', ?2, 1, 1, ?3)`,
      [key, `v1/default/refs%2Fheads%2Ff/${key}/w`, NOW - days * DAY],
    )
    s.objects.set(`v1/default/refs%2Fheads%2Ff/${key}/w`, key)
  }
  for (const days of [91, 5]) {
    s.at(days)
    await s.handle(
      new Request('http://s/v1/runs', {
        method: 'POST',
        body: JSON.stringify({
          id: `r${days}`,
          startedAt: NOW - days * DAY,
          durationMs: 1,
          tasks: [],
        }),
        headers: { authorization: `Bearer ${WRITE}`, 'content-type': 'application/json' },
      }),
    )
  }
  expect(await evict(s.store, s.blobs, retentionFrom({}), NOW)).toEqual({ artifacts: 2, runs: 1 })
  expect(s.sqlite.query('SELECT key FROM artifacts ORDER BY key').values().flat()).toEqual([
    'bcee',
    'cee9',
  ])
  expect([...s.objects.keys()].sort().map((k) => k.replace(/\/[^/]+$/, ''))).toEqual([
    'v1/default/refs%2Fheads%2Ff/bcee',
    'v1/default/trusted/cee9',
  ])
  expect(s.sqlite.query('SELECT id FROM runs').values().flat()).toEqual(['r5'])
})

it('sweeps more than one pass of rows, and makes the tables a first sweep needs', async () => {
  const s = await store()
  expect(await evict(s.store, s.blobs, retentionFrom({}), NOW)).toEqual({ artifacts: 0, runs: 0 })
  s.at(40)
  for (let i = 0; i < 450; i++) await s.put(`f${i}`)
  expect(
    (await evict(s.store, s.blobs, retentionFrom({ TRUSTED_DAYS: '35' }), NOW)).artifacts,
  ).toBe(450)
  expect(s.objects.size).toBe(0)
})

it('reads TRUSTED_DAYS, BRANCH_DAYS and RUN_DAYS, and refuses what is not days', () => {
  expect(retentionFrom({ BRANCH_DAYS: '2', RUN_DAYS: '' })).toEqual({
    trustedDays: 30,
    branchDays: 2,
    runDays: 90,
  })
  expect(() => retentionFrom({ TRUSTED_DAYS: 'a month' })).toThrow(
    'TRUSTED_DAYS: not a number of days above 0: a month',
  )
  expect(() => retentionFrom({ RUN_DAYS: '0' })).toThrow(
    'RUN_DAYS: not a number of days above 0: 0',
  )
})
