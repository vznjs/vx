// The policy `vx cache clean --older-than / --max-size` applies
// (`Cache.prune`): what it evicts, what it keeps, and the row-less
// artifacts and save temps its sweep reaps.

import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { indexDb, Cache } from '../src/cache/index.js'
import { storedArtifact } from './helpers/stored-artifact.js'
import { TAR_STORE } from './helpers/tar-store.js'

const DAY = 86_400_000

describe('Cache.prune', () => {
  let root: string
  let cacheDir: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-prune-'))
    cacheDir = path.join(root, 'cache')
    projectDir = path.join(root, 'proj')
    await mkdir(path.join(projectDir, 'dist'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** `file`: incompressible outputs past INLINE_MAX, so each artifact is a file, not inline. */
  async function seed(cache: Cache, hashes: readonly string[], file = false): Promise<void> {
    for (const hash of hashes) {
      const out = path.join(projectDir, 'dist', `${hash}.txt`)
      await writeFile(
        out,
        file ? crypto.getRandomValues(new Uint8Array(48 * 1024)) : hash.repeat(64),
      )
      await cache.save({
        hash,
        projectDir,
        outputFiles: [out],
        entry: { taskId: `p#${hash}`, command: `echo ${hash}`, durationMs: 1, stdout: '' },
      })
    }
  }

  /** Set an entry's `accessed_at` behind the handle's back (a fresh connection). */
  function age(hash: string, accessedAt: number): void {
    const db = new Database(path.join(cacheDir, 'cache.db'))
    db.query('UPDATE entries SET accessed_at = ? WHERE hash = ?').run(accessedAt, hash)
    db.close()
  }

  function hashes(cache: Cache): string[] {
    return (
      indexDb(cache).query('SELECT hash FROM entries ORDER BY hash').all() as Array<{
        hash: string
      }>
    ).map((r) => r.hash)
  }

  it('evicts an entry unused for longer than maxAge, and only that one', async () => {
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      await seed(cache, ['aa', 'bb'])
      const now = Date.now()
      age('aa', now - 40 * DAY)
      const result = await cache.prune({ olderThanMs: now - 30 * DAY })
      expect(result.evicted).toBe(1)
      expect(hashes(cache)).toEqual(['bb'])
      expect([storedArtifact(cache, 'aa'), storedArtifact(cache, 'bb') !== null]).toEqual([
        null,
        true,
      ])
    } finally {
      cache.close()
    }
  })

  /** Plant a row-less artifact of `bytes`, last written `agoMs` ago. */
  async function orphan(name: string, bytes: number, agoMs: number): Promise<string> {
    const file = path.join(cacheDir, `${name}.tar.zst`)
    await writeFile(file, new Uint8Array(bytes))
    const when = new Date(Date.now() - agoMs)
    await utimes(file, when, when)
    return file
  }

  it('an entry this handle just used is kept, though the index still says old', async () => {
    // The restore's `accessed_at` bump is deferred; prune flushes it first.
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      await seed(cache, ['aa', 'bb'])
      await cache.prune({ olderThanMs: 0 })
      const now = Date.now()
      age('aa', now - 40 * DAY)
      expect(await cache.get('aa')).not.toBeNull()
      // CONTROL: the same age on an entry nobody used is evicted.
      age('bb', now - 40 * DAY)
      expect((await cache.prune({ olderThanMs: now - 30 * DAY })).evicted).toBe(1)
      expect(hashes(cache)).toEqual(['aa'])
    } finally {
      cache.close()
    }
  })

  // Nx's cleanup_keeps_a_result_stored_meanwhile (in a shared database and
  // through a separate one) and put_between_check_and_cleanup: a save that
  // lands while a prune runs is never taken by it, however the two
  // interleave. Its artifact file is renamed in before its row commits, so
  // the prune's orphan sweep may list it row-less; the grace window keeps it.
  for (const shared of [true, false]) {
    it(`an entry saved while a prune runs survives it (${shared ? 'one handle' : 'two handles'})`, async () => {
      const seeding = new Cache(
        cacheDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        TAR_STORE,
      )
      await seed(seeding, ['aa'], true)
      seeding.close()
      age('aa', Date.now() - 40 * DAY)
      const cache = new Cache(
        cacheDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        TAR_STORE,
      )
      const other = shared
        ? cache
        : new Cache(cacheDir, undefined, undefined, undefined, undefined, undefined, TAR_STORE)
      try {
        const pruning = cache.prune({ olderThanMs: Date.now() - 30 * DAY })
        await seed(other, ['bb'], true)
        expect((await pruning).evicted).toBe(1)
        expect(hashes(cache)).toEqual(['bb'])
        const dest = path.join(root, 'restored')
        await other.restoreOutputs('bb', dest)
        expect(existsSync(path.join(dest, 'dist', 'bb.txt'))).toBe(true)
      } finally {
        if (!shared) other.close()
        cache.close()
      }
    })
  }

  it('evicts least-recently-used entries until the cache is under maxSize', async () => {
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      await seed(cache, ['aa', 'bb', 'cc'])
      const now = Date.now()
      age('aa', now - 3000)
      age('bb', now - 2000)
      age('cc', now - 1000)
      const sizes = indexDb(cache).query('SELECT size_bytes AS s FROM entries').all() as Array<{
        s: number
      }>
      const one = Math.max(...sizes.map((r) => r.s))
      // Room for two entries at most: the oldest goes, the two newest stay.
      const result = await cache.prune({ maxBytes: 2 * one })
      expect(result.evicted).toBe(1)
      expect(hashes(cache)).toEqual(['bb', 'cc'])
    } finally {
      cache.close()
    }
  })

  it('reaps row-less artifacts, whatever the index says', async () => {
    // What a SCHEMA_VERSION reset, a deleted cache.db or a crashed save
    // leaves: bytes no entry row counts. `maxSize` summed the rows only, so
    // 9 MiB of these sat under a 1 MB limit (upstream survey, nx#35483).
    const MiB = 1024 * 1024
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      await seed(cache, ['aa'])
      const first = await orphan('00000000000000a1', 3 * MiB, 3 * 3_600_000)
      // Younger than the in-flight grace: a save may still be landing it.
      const young = await orphan('00000000000000a2', 3 * MiB, 60_000)
      expect(await cache.prune({ maxBytes: MiB })).toEqual({
        evicted: 0,
        bytesFreed: 0,
        orphans: 1,
        orphanBytes: 3 * MiB,
      })
      expect(existsSync(first)).toBe(false)
      expect(existsSync(young)).toBe(true)
      // CONTROL: the entry row was never over the limit, so nothing was evicted.
      expect(hashes(cache)).toEqual(['aa'])
    } finally {
      cache.close()
    }
  })

  // Two vx versions share one store, and each open drops the other's rows:
  // a row-less artifact may be in use. It is judged by its file time
  // against the age limit, as a row is by `accessed_at`, never by a
  // one-hour grace.
  it('a row-less artifact younger than the age limit survives the sweep', async () => {
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      const recent = await orphan('00000000000000a1', 1024, 3 * 3_600_000)
      // A hit renews a file time only once it is an hour old, so the last
      // use may be up to an hour after it.
      const edge = await orphan('00000000000000a3', 1024, DAY + 1_800_000)
      const old = await orphan('00000000000000a2', 1024, 2 * DAY)
      expect(await cache.prune({ olderThanMs: Date.now() - DAY })).toEqual({
        evicted: 0,
        bytesFreed: 0,
        orphans: 1,
        orphanBytes: 1024,
      })
      expect([recent, edge, old].map((f) => existsSync(f))).toEqual([true, true, false])
    } finally {
      cache.close()
    }
  })

  it('a row-less artifact counts toward maxSize, oldest use first with the rows', async () => {
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      await seed(cache, ['aa'])
      age('aa', Date.now() - 2 * DAY)
      const one = (
        indexDb(cache).query('SELECT size_bytes AS s FROM entries').get() as {
          s: number
        }
      ).s
      const recent = await orphan('00000000000000a1', 1024, 3 * 3_600_000)
      const old = await orphan('00000000000000a2', 1024, 3 * DAY)
      // Room for the recent artifact alone: the older artifact and the row go.
      expect(await cache.prune({ maxBytes: 1024 + one - 1 })).toEqual({
        evicted: 1,
        bytesFreed: one,
        orphans: 1,
        orphanBytes: 1024,
      })
      expect([existsSync(recent), existsSync(old)]).toEqual([true, false])
      expect(hashes(cache)).toEqual([])
    } finally {
      cache.close()
    }
  })

  // An inline artifact's `at` stands for the file time: renewed the same way,
  // judged the same way.
  for (const where of ['file', 'inline'] as const) {
    it(`a hit or an adopt renews the ${where} artifact's time another version judges by`, async () => {
      // Names the sweep may take: a key `foldKey` prints.
      const keys = ['00000000000000b1', '00000000000000b2', '00000000000000b3', '00000000000000b4']
      const [hit, hitMany, adopted] = keys as [string, string, string, string]
      const present = (cache: Cache): boolean[] =>
        keys.map((h) =>
          where === 'file'
            ? existsSync(path.join(cacheDir, `${h}.tar.zst`))
            : storedArtifact(cache, h) !== null,
        )
      const writer = new Cache(
        cacheDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        TAR_STORE,
      )
      try {
        await seed(writer, keys, where === 'file')
        const when = Date.now() - 2 * DAY
        for (const h of keys) {
          if (where === 'file')
            await utimes(path.join(cacheDir, `${h}.tar.zst`), when / 1000, when / 1000)
          else indexDb(writer).query('UPDATE artifacts SET at = ? WHERE hash = ?').run(when, h)
        }
        expect(present(writer)).toEqual([true, true, true, true])
        expect(await writer.get(hit)).not.toBeNull()
        expect((await writer.getMany([hitMany])).size).toBe(1)
        // Another version's open dropped this row; this one finds the artifact.
        indexDb(writer).query('DELETE FROM entries WHERE hash = ?').run(adopted)
        expect(await writer.get(adopted, { taskId: 'p#b3', command: 'echo b3' })).not.toBeNull()
      } finally {
        writer.close()
      }
      // The other version's open: every row gone.
      const other = new Cache(
        cacheDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        TAR_STORE,
      )
      try {
        indexDb(other).query('DELETE FROM entries').run()
        expect((await other.prune({ olderThanMs: Date.now() - DAY })).orphans).toBe(1)
        // CONTROL: the one never used goes.
        expect(present(other)).toEqual([true, true, true, false])
      } finally {
        other.close()
      }
    })
  }

  // turborepo test_evict_removes_stale_entries: a killed save leaves its
  // temp, and eviction reaps it like a row-less artifact.
  it("reaps a killed save's temp past the age limit", async () => {
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      const temp = path.join(cacheDir, '00000000000000b1.tar.zst.tmp-4242-1-ab12cd34')
      await writeFile(temp, new Uint8Array(1024))
      const when = new Date(Date.now() - 2 * DAY)
      await utimes(temp, when, when)
      expect((await cache.prune({ olderThanMs: Date.now() - DAY })).orphans).toBe(1)
      expect(existsSync(temp)).toBe(false)
    } finally {
      cache.close()
    }
  })

  // turborepo test_evict_empty_cache.
  it('an empty cache prunes to nothing, without error', async () => {
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      expect(await cache.prune({ olderThanMs: Date.now(), maxBytes: 1 })).toEqual({
        evicted: 0,
        bytesFreed: 0,
        orphans: 0,
        orphanBytes: 0,
      })
    } finally {
      cache.close()
    }
  })

  // nx cleanup_keeps_a_result_stored_meanwhile_{in a shared,through a
  // separate}_database: a save landing while a prune runs survives it.
  for (const handles of ['one handle', 'two handles'] as const) {
    it(`an entry saved while a prune runs survives it, through ${handles}`, async () => {
      const cache = new Cache(
        cacheDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        TAR_STORE,
      )
      const writer =
        handles === 'one handle'
          ? cache
          : new Cache(cacheDir, undefined, undefined, undefined, undefined, undefined, TAR_STORE)
      try {
        await seed(cache, ['aa', 'bb', 'cc'], true)
        for (const h of ['aa', 'bb', 'cc']) age(h, Date.now() - 3 * DAY)
        const pruning = cache.prune({ olderThanMs: Date.now() - DAY })
        await seed(writer, ['dd'], true)
        expect((await pruning).evicted).toBe(3)
        expect(hashes(cache)).toEqual(['dd'])
        expect(await cache.has('dd')).toBeTruthy()
      } finally {
        if (writer !== cache) writer.close()
        cache.close()
      }
    })
  }
})
