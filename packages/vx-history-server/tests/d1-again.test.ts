// D1 fails some statements with an error Cloudflare says to retry
// (developers.cloudflare.com/d1/best-practices/retry-queries): each failed
// a query or an upload 500, which vxHistory does not send again. Asked
// again as the cache server asks R2: three tries, 50 then 100 ms apart.

import { Database } from 'bun:sqlite'
import { expect, it } from 'bun:test'
import { sqliteStore } from '../src/store.js'
import { type D1Database, d1Db } from '../src/worker.js'

function fixture(fails: (string | null)[]) {
  let calls = 0
  const d1: D1Database = {
    prepare: () => {
      const statement = {
        bind: () => statement,
        all: async <T>() => {
          calls++
          const err = fails.shift()
          if (err) throw new Error(err)
          return { results: [{ n: 1 }] as T[] }
        },
        run: async () => {
          calls++
          const err = fails.shift()
          if (err) throw new Error(err)
          return { meta: { changes: 1 } }
        },
      }
      return statement
    },
  }
  return { db: d1Db(d1), calls: () => calls }
}

const LOST = 'D1_ERROR: Network connection lost.'
const RESET = 'D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.'
const UPDATED = 'D1_ERROR: Durable Object reset because its code was updated.'

it('asks D1 again on an error it says to retry', async () => {
  const f = fixture([LOST, RESET])
  expect([await f.db.all('SELECT 1', []), f.calls()]).toEqual([[{ n: 1 }], 3])
  const g = fixture([UPDATED])
  expect([await g.db.run('UPDATE x', []), g.calls()]).toEqual([1, 2])
})

it('fails after three tries, and never asks again on another error', async () => {
  const f = fixture([LOST, LOST, LOST])
  await expect(f.db.run('UPDATE x', [])).rejects.toThrow(LOST)
  expect(f.calls()).toBe(3)
  const g = fixture(['D1_ERROR: no such table: timings'])
  await expect(g.db.all('SELECT 1', [])).rejects.toThrow('no such table')
  expect(g.calls()).toBe(1)
})

/** D1 over a bun:sqlite database; each statement in `lose` lands, then says the connection was lost. */
function landedD1(db: Database, lose: (sql: string) => boolean): D1Database {
  return {
    prepare: (sql) => {
      let params: unknown[] = []
      const statement = {
        bind: (...values: unknown[]) => ((params = values), statement),
        all: async <T>() => ({ results: db.query(sql).all(...(params as never[])) as T[] }),
        run: async () => {
          const changes = db.query(sql).run(...(params as never[])).changes
          if (lose(sql)) throw new Error(LOST)
          return { meta: { changes } }
        },
      }
      return statement
    },
  }
}

// 2026-11-24: a fold that landed and then lost its connection was sent
// again and folded twice: a run counted two runs, and its duration
// weighed twice, where Bun's SQLite folds it once.
it('folds a report once when D1 lost the connection after it landed', async () => {
  const sqlite = new Database(':memory:', { strict: true })
  let lost = 0
  const store = sqliteStore(
    d1Db(landedD1(sqlite, (sql) => sql.startsWith('INSERT INTO timings') && lost++ % 2 === 0)),
  )
  await store.init()
  const repo = { issuer: 'https://token.actions.githubusercontent.com', repository: 'acme/app' }
  await store.fold(repo, 'refs/heads/main', 1_000, [{ hash: 'h1', durationMs: 1000 }])
  await store.fold(repo, 'refs/heads/main', 2_000, [{ hash: 'h1', durationMs: 2000 }])
  const row = (await store.read(repo, ['refs/heads/main'], ['h1'])).get('h1')
  expect([row?.runs, row?.durationMs]).toEqual([2, 1300])
})

// 2026-11-24: Bun refused a file whose tables were another tool's; a D1
// database of another tool's took ALTER, then failed every upload 500.
it("refuses a D1 database whose tables are not this server's, and leaves them", async () => {
  const sqlite = new Database(':memory:', { strict: true })
  sqlite.run('CREATE TABLE timings (task TEXT, ms INTEGER)')
  await expect(sqliteStore(d1Db(landedD1(sqlite, () => false))).init()).rejects.toThrow(
    "its table timings is not this server's: it has no column issuer, repository, ref, hash, duration_ms, cores, rss_bytes, runs, updated_at",
  )
  expect(sqlite.query('SELECT name FROM pragma_table_info(?1)').all('timings')).toEqual([
    { name: 'task' },
    { name: 'ms' },
  ])
})
