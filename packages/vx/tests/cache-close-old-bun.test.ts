// Below the Bun floor (1.3.14), `Database.close(true)` with a prepared
// statement alive answers SQLITE_BUSY instead of finalizing it, and every
// `vx run` exited 1 with "database is locked" after its tasks passed (M-44).
// This runtime finalizes, so the row stands that answer in for it.
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

describe('Cache.close() on a close(true) that refuses', () => {
  let root: string
  const original = Database.prototype.close
  let calls: (boolean | undefined)[]

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-close-old-'))
    calls = []
  })

  afterEach(async () => {
    Database.prototype.close = original
    await rm(root, { recursive: true, force: true })
  })

  it('closes through the deferred close', async () => {
    Database.prototype.close = function (this: Database, throwOnError?: boolean) {
      calls.push(throwOnError)
      if (throwOnError === true) throw new Error('database is locked')
      original.call(this)
    }
    const cache = new Cache(path.join(root, 'cache'))
    await cache.get('0123456789abcdef')
    expect(() => cache.close()).not.toThrow()
    expect(calls).toEqual([true, undefined])
  })

  it('CONTROL: a close(true) that closes is the only close', async () => {
    Database.prototype.close = function (this: Database, throwOnError?: boolean) {
      calls.push(throwOnError)
      original.call(this, throwOnError)
    }
    const cache = new Cache(path.join(root, 'cache'))
    await cache.get('0123456789abcdef')
    cache.close()
    expect(calls).toEqual([true])
  })
})
