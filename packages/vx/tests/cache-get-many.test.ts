// `getMany` is the short-circuit classify's batched `get`: one query per
// chunk instead of two per hash. Its contract is "the same answers as N
// calls to `get`" — including the answers that are NOT rows: the read gate
// (a `--force` run must not classify anything as a hit), an artifact
// deleted under the index (a hit `restore` cannot serve), and the deferred
// `accessed_at` touch that LRU pruning reads. A batch that drifted on any of
// these would classify tasks the lazy path then refuses, or let prune evict
// entries a warm run just used.

import { rm, mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

describe('Cache.getMany agrees with Cache.get', () => {
  let cacheDir: string
  let projectDir: string

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-getmany-'))
    cacheDir = path.join(root, 'cache')
    projectDir = path.join(root, 'proj')
    await mkdir(path.join(projectDir, 'dist'), { recursive: true })
  })

  afterEach(async () => {
    await rm(path.dirname(cacheDir), { recursive: true, force: true })
  })

  async function seed(cache: Cache, hashes: readonly string[]): Promise<void> {
    for (const hash of hashes) {
      const out = path.join(projectDir, 'dist', `${hash}.txt`)
      await writeFile(out, hash)
      await cache.save({
        hash,
        projectDir,
        outputFiles: [out],
        entry: { taskId: `p#${hash}`, command: `echo ${hash}`, durationMs: 1, stdout: `${hash}\n` },
      })
    }
  }

  it('returns exactly the entries get() returns, and nothing for a row whose artifact is gone', async () => {
    const cache = new Cache(cacheDir)
    try {
      await seed(cache, ['aa', 'bb', 'cc'])
      await unlink(path.join(cacheDir, 'bb.tar.zst')) // index row survives, bytes do not
      const many = await cache.getMany(['aa', 'bb', 'cc', 'zz'])
      expect([...many.keys()].sort()).toEqual(['aa', 'cc'])
      for (const hash of ['aa', 'bb', 'cc', 'zz']) {
        expect(many.get(hash) ?? null).toEqual(await cache.get(hash))
      }
    } finally {
      cache.close()
    }
  })

  it('honours the local read gate exactly like get()', async () => {
    const writer = new Cache(cacheDir)
    await seed(writer, ['aa'])
    writer.close()
    const gated = new Cache(cacheDir, { read: false, write: true })
    try {
      expect(await gated.get('aa')).toBeNull()
      expect((await gated.getMany(['aa'])).size).toBe(0)
    } finally {
      gated.close()
    }
    // CONTROL: the same store, gate open, serves it both ways.
    const open = new Cache(cacheDir)
    try {
      expect(await open.get('aa')).not.toBeNull()
      expect((await open.getMany(['aa'])).size).toBe(1)
    } finally {
      open.close()
    }
  })

  it('bumps accessed_at for a batched hit the way a single get() does', async () => {
    const cache = new Cache(cacheDir)
    try {
      await seed(cache, ['aa', 'bb'])
      const db = cache.dbHandle()
      const stamp = (hash: string): number =>
        (db.query('SELECT accessed_at AS t FROM entries WHERE hash = ?').get(hash) as { t: number })
          .t
      db.query('UPDATE entries SET accessed_at = 1').run() // ancient, both
      expect([stamp('aa'), stamp('bb')]).toEqual([1, 1])
      await cache.get('aa')
      await cache.getMany(['bb'])
      cache.stats() // flushes the deferred touches
      expect(stamp('aa')).toBeGreaterThan(1)
      expect(stamp('bb')).toBeGreaterThan(1)
    } finally {
      cache.close()
    }
  })
})
