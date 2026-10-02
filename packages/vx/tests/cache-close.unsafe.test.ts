// `Cache.close()` closed nothing: bun:sqlite defers a plain `close()` while a
// prepared statement lives, and the cache keeps several, so `cache.db`
// and its `-wal` and `-shm` stayed open: an embedder leaked three
// descriptors per run (O-10). Unsafe: it reads
// this process's /proc/self/fd, which a sandboxed shard's /proc is not.
import { readdirSync, readlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

const heldUnder = (dir: string): string[] =>
  readdirSync('/proc/self/fd')
    .map((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`)
      } catch {
        return ''
      }
    })
    .filter((p) => p.startsWith(dir + path.sep))
    .map((p) => path.basename(p))
    .sort()

describe.skipIf(process.platform !== 'linux')('Cache.close()', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-close-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('leaves no file of the cache open', async () => {
    const cache = new Cache(path.join(root, 'cache'))
    await cache.get('0123456789abcdef')
    // CONTROL: open, the index and its WAL files are held.
    expect(heldUnder(root)).toEqual(['cache.db', 'cache.db-shm', 'cache.db-wal'])
    cache.close()
    expect(heldUnder(root)).toEqual([])
  })
})
