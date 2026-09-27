// The cache on a full disk (A-14). SQLite answers a full disk with
// `SQLITE_FULL`, not an `ENOSPC` errno, and each write below reached the
// user as a stack: the file-hash memo (the run never started), the output
// snapshot flush after a green restore, and `vx cache prune`, the one verb
// meant to free the disk, which freed nothing. A failed in-memory save also
// left its temp behind. Memo writes now give way, and prune unlinks first.
//
// The index is filled for real (`max_page_count` caps it at its size), except
// for prune's delete, which a full disk fails on its journal and a page cap
// cannot: that one is a spy.

import * as fsp from 'node:fs/promises'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Cache, FILE_HASH_RACY_MS } from '../src/cache/index.js'

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
  const db = cache.dbHandle()
  const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number }
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

async function save(cache: Cache, hash: string): Promise<void> {
  const out = path.join(proj, 'dist', `${hash}.txt`)
  writeFileSync(out, hash.repeat(50))
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
      const junk = cache
        .dbHandle()
        .prepare(
          'INSERT INTO file_hashes(path, mtime_ms, size_bytes, ctime_ms, ino, content_hash, seen_at) VALUES (?, 0, 0, 0, 0, ?, 0)',
        )
      fill(cache, (i, pad) => junk.run(`/junk/${i}`, pad))
      const before = cache.dbHandle().prepare('SELECT COUNT(*) AS n FROM file_hashes').get()
      expect(await cache.hashFile(a)).toMatch(/^[0-9a-f]{40}$/)
      expect((await cache.hashFiles([b])).get(b)).toMatch(/^[0-9a-f]{40}$/)
      expect(cache.dbHandle().prepare('SELECT COUNT(*) AS n FROM file_hashes').get()).toEqual(
        before,
      )
    } finally {
      cache.close()
    }
  })

  it('the output snapshot flush gives way: the rows still read', async () => {
    const cache = new Cache(cacheDir)
    try {
      await save(cache, 'h1')
      const junk = cache
        .dbHandle()
        .prepare(
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
    const cache = new Cache(cacheDir)
    const spy = spyOn(fsp, 'writeFile').mockImplementation((async (file: string) => {
      writeFileSync(file, 'partial')
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }) as typeof fsp.writeFile)
    try {
      await expect(save(cache, 'h1')).rejects.toThrow('ENOSPC')
      expect(readdirSync(cacheDir).filter((n) => n.includes('.tmp-'))).toEqual([])
    } finally {
      spy.mockRestore()
      cache.close()
    }
  })

  it('prune unlinks the artifacts, then deletes the rows once the space is back', async () => {
    const cache = new Cache(cacheDir)
    try {
      await save(cache, 'h1')
      await save(cache, 'h2')
      const db = cache.dbHandle()
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
      expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: 0 })
    } finally {
      cache.close()
    }
  })
})
