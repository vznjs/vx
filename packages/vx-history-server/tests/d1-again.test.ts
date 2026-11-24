// D1 fails some statements with an error Cloudflare says to retry
// (developers.cloudflare.com/d1/best-practices/retry-queries): each failed
// a query or an upload 500, which vxHistory does not send again. Asked
// again as the cache server asks R2: three tries, 50 then 100 ms apart.

import { expect, it } from 'bun:test'
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
