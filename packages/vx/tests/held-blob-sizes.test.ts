import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Cache } from '../src/cache/index.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
let dir: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-held-sizes-'))
  dir = path.join(root, 'cache')
})
afterEach(() => rm(root, { recursive: true, force: true }))

const open = (): Cache =>
  new Cache(dir, undefined, undefined, undefined, undefined, undefined, TAR_STORE)

function stored(): number {
  const db = new Database(path.join(dir, 'cache.db'), { readonly: true })
  try {
    return (db.query('SELECT count(*) AS n FROM blob_sizes').get() as { n: number }).n
  } finally {
    db.close()
  }
}

const sizes = (n: number): Map<string, number> =>
  new Map(Array.from({ length: n }, (_, i) => [`oid${i}`, i]))

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

it('held blob sizes are stored while the run goes on, not when remembered', async () => {
  const cache = open()
  cache.holdBlobSizes()
  cache.rememberBlobSizes(sizes(600))
  expect(stored()).toBe(0)
  cache.storeHeldBlobSizes()
  expect(stored()).toBe(0)
  await turn()
  expect(stored()).toBeGreaterThan(0)
  expect(stored()).toBeLessThan(600)
  for (let i = 0; i < 5; i++) await turn()
  expect(stored()).toBe(600)
  cache.rememberBlobSizes(sizes(1))
  cache.close()
})

it('close stores what is still held, stored or not', () => {
  const never = open()
  never.holdBlobSizes()
  never.rememberBlobSizes(sizes(10))
  never.close()
  expect(stored()).toBe(10)
  const mid = open()
  mid.holdBlobSizes()
  mid.rememberBlobSizes(new Map(Array.from({ length: 600 }, (_, i) => [`x${i}`, i])))
  mid.storeHeldBlobSizes()
  mid.close()
  expect(stored()).toBe(610)
  expect(open().knownBlobSizes(['x599'])).toEqual(new Map([['x599', 599]]))
})

it('an empty memo answers no size', () => {
  const cache = open()
  expect(cache.knownBlobSizes(['a', 'b'])).toEqual(new Map())
  cache.rememberBlobSizes(new Map([['a', 1]]))
  expect(cache.knownBlobSizes(['a', 'b'])).toEqual(new Map([['a', 1]]))
  cache.close()
})
