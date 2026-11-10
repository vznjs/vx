// The cache on a full disk (A-14). SQLite answers a full disk with
// `SQLITE_FULL`, not an `ENOSPC` errno, and each write below reached the
// user as a stack: the file-hash memo (the run never started), the output
// snapshot flush after a green restore, and `vx cache clean`, the one verb
// meant to free the disk, which freed nothing. A failed in-memory save also
// left its temp behind. Memo writes now give way, and prune unlinks first.
//
// The index is filled for real (`max_page_count` caps it at its size), except
// for prune's delete, which a full disk fails on its journal and a page cap
// cannot: that one is a spy.

import * as fsp from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { indexDb, Cache, FILE_HASH_RACY_MS } from '../src/cache/index.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
let cacheDir: string
let proj: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-disk-full-'))
  cacheDir = path.join(root, 'cache')
  proj = path.join(root, 'p')
  mkdirSync(path.join(proj, 'dist'), { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/**
 * Cap the index at its size and fill `table`'s own pages (each table keeps
 * free space of its own) with rows from `insert`, big ones then smaller
 * ones into the gaps, down to one byte: any write that needs a page there is
 * then SQLITE_FULL.
 */
function fill(cache: Cache, insert: (i: number, pad: string) => void): void {
  const db = indexDb(cache)
  const { page_count } = db.query('PRAGMA page_count').get() as { page_count: number }
  db.exec(`PRAGMA max_page_count = ${page_count}`)
  let i = 0
  for (const size of [2000, 200, 20, 1]) {
    try {
      for (;;) insert(i++, 'y'.repeat(size))
    } catch (err) {
      expect((err as { code: string }).code).toBe('SQLITE_FULL')
    }
  }
}

/** `file`: an incompressible output past INLINE_MAX, so the artifact is a file, not inline. */
async function save(cache: Cache, hash: string, file = false): Promise<void> {
  const out = path.join(proj, 'dist', `${hash}.txt`)
  writeFileSync(out, file ? crypto.getRandomValues(new Uint8Array(48 * 1024)) : hash.repeat(50))
  await cache.save({
    hash,
    projectDir: proj,
    outputFiles: [out],
    entry: { taskId: 'p#build', command: 'c', durationMs: 1, stdout: '' },
  })
}

describe('a full index', () => {
  it('the file-hash memo gives way: both forms answer, nothing is stored', async () => {
    const cache = new Cache(cacheDir)
    try {
      const a = path.join(root, 'a.txt')
      const b = path.join(root, 'b.txt')
      writeFileSync(a, 'alpha')
      writeFileSync(b, 'beta')
      await Bun.sleep(FILE_HASH_RACY_MS + 20) // past the racy window: a row would be written
      const junk = indexDb(cache).query(
        'INSERT INTO file_hashes(path, mtime_ms, size_bytes, ctime_ms, ino, content_hash, seen_at) VALUES (?, 0, 0, 0, 0, ?, 0)',
      )
      fill(cache, (i, pad) => junk.run(`/junk/${i}`, pad))
      const before = indexDb(cache).query('SELECT COUNT(*) AS n FROM file_hashes').get()
      expect(await cache.hashFile(a)).toMatch(/^[0-9a-f]{40}$/)
      expect((await cache.hashFiles([b])).get(b)).toMatch(/^[0-9a-f]{40}$/)
      expect(indexDb(cache).query('SELECT COUNT(*) AS n FROM file_hashes').get()).toEqual(before)
    } finally {
      cache.close()
    }
  })

  it('the output snapshot flush gives way: the rows still read', async () => {
    const cache = new Cache(cacheDir)
    try {
      await save(cache, 'h1')
      const junk = indexDb(cache).query(
        "INSERT INTO output_files(entry_hash, path, size_bytes, mode, mtime_ms) VALUES ('h1', ?, 0, 0, 0)",
      )
      fill(cache, (i, pad) => junk.run(`junk/${i}/${pad}`))
      cache.recordOutputStamps('h1', proj, root)
      const paths =
        cache
          .loadOutputFilesBatch(['h1'])
          .get('h1')
          ?.map((r) => r.path) ?? []
      expect(paths.filter((p) => !p.startsWith('junk/'))).toEqual(['dist/h1.txt'])
    } finally {
      cache.close()
    }
  })
})

describe('a full disk', () => {
  it('a save whose temp write fails leaves no temp', async () => {
    // The tar form writes one temp file; the tree form's is the next test's.
    const cache = new Cache(
      cacheDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    const spy = spyOn(fsp, 'writeFile').mockImplementation((async (file: string) => {
      writeFileSync(file, 'partial')
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }) as typeof fsp.writeFile)
    try {
      await expect(save(cache, 'h1', true)).rejects.toThrow('ENOSPC')
      expect(readdirSync(cacheDir).filter((n) => n.includes('.tmp-'))).toEqual([])
    } finally {
      spy.mockRestore()
      cache.close()
    }
  })

  it('a tree save whose first file write fails leaves no temp tree', async () => {
    // The tree form writes its files at once: a write still in flight when
    // the first one failed made its parent directory again after the
    // cleanup removed the temp, and a full disk kept every such temp.
    const cache = new Cache(cacheDir, undefined, undefined, undefined, undefined, undefined, {
      embeddings: 0,
      decompress: true,
    })
    const out = path.join(proj, 'dist')
    for (const f of ['a', 'b', 'c']) {
      mkdirSync(path.join(out, f))
      writeFileSync(path.join(out, f, 'x.bin'), crypto.getRandomValues(new Uint8Array(1024)))
    }
    const real = Bun.write
    let calls = 0
    const spy = spyOn(Bun, 'write').mockImplementation((async (
      ...args: Parameters<typeof real>
    ) => {
      if (calls++ === 0) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      await Bun.sleep(50)
      return real(...args)
    }) as typeof Bun.write)
    try {
      await expect(
        cache.save({
          hash: 'h1',
          projectDir: proj,
          outputFiles: ['a', 'b', 'c'].map((f) => path.join(out, f, 'x.bin')),
          entry: { taskId: 'p#build', command: 'c', durationMs: 1, stdout: '' },
        }),
      ).rejects.toThrow('ENOSPC')
      await Bun.sleep(150)
      const left = readdirSync(cacheDir, { recursive: true }).map(String)
      expect(left.filter((n) => n.includes('.tmp-'))).toEqual([])
    } finally {
      spy.mockRestore()
      cache.close()
    }
  })

  it('prune unlinks the artifacts, then deletes the rows once the space is back', async () => {
    const cache = new Cache(cacheDir)
    try {
      await save(cache, 'h1', true)
      await save(cache, 'h2', true)
      const db = indexDb(cache)
      const real = db.transaction.bind(db)
      let failed = false
      const spy = spyOn(db, 'transaction').mockImplementation(((fn: () => void) => {
        const tx = real(fn)
        return (() => {
          // The first delete meets the full disk; it succeeds once the
          // artifacts are gone. Other transactions pass through.
          if (!failed && fn.toString().includes('DELETE FROM entries')) {
            failed = true
            if (existsSync(path.join(cacheDir, 'h1.tar.zst'))) {
              throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
            }
          }
          return tx()
        }) as typeof tx
      }) as typeof db.transaction)
      try {
        expect((await cache.prune({ maxBytes: 1 })).evicted).toBe(2)
      } finally {
        spy.mockRestore()
      }
      expect(readdirSync(cacheDir).filter((n) => n.endsWith('.tar.zst'))).toEqual([])
      expect(db.query('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: 0 })
    } finally {
      cache.close()
    }
  })

  it('prune retries its row delete once when the first meets a full index (A-37)', async () => {
    // The row above frees the space before the delete runs, so the retry
    // itself was never reached: here the first delete fails regardless.
    const cache = new Cache(cacheDir)
    try {
      await save(cache, 'h1')
      const db = indexDb(cache)
      const real = db.transaction.bind(db)
      let failed = 0
      const spy = spyOn(db, 'transaction').mockImplementation(((fn: () => void) => {
        const tx = real(fn)
        return (() => {
          if (failed === 0 && fn.toString().includes('DELETE FROM entries')) {
            failed++
            throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
          }
          return tx()
        }) as typeof tx
      }) as typeof db.transaction)
      try {
        expect((await cache.prune({ maxBytes: 1 })).evicted).toBe(1)
      } finally {
        spy.mockRestore()
      }
      expect([failed, db.query('SELECT COUNT(*) AS n FROM entries').get()]).toEqual([1, { n: 0 }])
    } finally {
      cache.close()
    }
  })

  it('a restore that meets a full disk names the code once', async () => {
    // Bun's message opens with the code: `(ENOSPC: ENOSPC: …)` read as a stutter.
    const cache = new Cache(cacheDir, undefined, undefined, undefined, undefined, undefined, {
      embeddings: 0,
      decompress: true,
    })
    await save(cache, 'h1', true)
    rmSync(path.join(proj, 'dist'), { recursive: true })
    const spy = spyOn(Bun, 'write').mockImplementation((async (to: unknown) => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
        code: 'ENOSPC',
        path: String(to),
      })
    }) as typeof Bun.write)
    try {
      const err = await cache.restoreOutputs('h1', proj).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err?.message).toContain('could not write its outputs (ENOSPC: no space left')
      expect(err?.message).not.toContain('ENOSPC: ENOSPC')
    } finally {
      spy.mockRestore()
      cache.close()
    }
  })

  it('the access-time flush gives way to a full index (A-37)', async () => {
    const cache = new Cache(cacheDir)
    try {
      await save(cache, 'h1')
      expect(await cache.get('h1')).not.toBeNull() // queues an accessed_at write
      const db = indexDb(cache)
      const real = db.prepare.bind(db)
      const spy = spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        if (sql.startsWith('UPDATE entries SET accessed_at')) {
          throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
        }
        return real(sql)
      }) as typeof db.prepare)
      try {
        expect(cache.stats().entryCount).toBe(1)
      } finally {
        spy.mockRestore()
      }
    } finally {
      cache.close()
    }
  })
})
