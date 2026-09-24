// Opening the cache while another process holds its database's lock. Two
// CLI runs on one workspace open the cache before the run lock is taken —
// the open is the one moment they still overlap — and the journal-mode
// pragma takes a lock of its own. With `busy_timeout` set AFTER it, the
// second opener met `database is locked` at once (macOS CI, 2026-09-16);
// set first, it waits for the holder instead.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/cache.js'

const TIMEOUT = 30_000

/** Hold an EXCLUSIVE lock on `dbPath` for `ms` from another process; prints `held` once it has it. */
function holder(dbPath: string, ms: number): ReturnType<typeof Bun.spawn> {
  const script = `
    import { Database } from 'bun:sqlite'
    const db = new Database(${JSON.stringify(dbPath)}, { create: true })
    db.exec('BEGIN EXCLUSIVE')
    console.log('held')
    await Bun.sleep(${ms})
    db.exec('COMMIT')
    db.close()
  `
  return Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
}

describe('opening the cache under another process’s lock', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-open-busy-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it(
    'waits for the holder instead of failing with `database is locked`',
    async () => {
      const cacheDir = path.join(dir, 'cache')
      await Bun.write(path.join(cacheDir, '.keep'), '')
      const proc = holder(path.join(cacheDir, 'cache.db'), 1500)
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('held')
      const started = Date.now()
      // Without the timeout in front of the journal-mode switch this threw at
      // once; with it, the open waits out the holder's 1.5 s.
      const cache = new Cache(cacheDir)
      const waited = Date.now() - started
      cache.close()
      await proc.exited
      expect(waited).toBeGreaterThan(500)
    },
    TIMEOUT,
  )

  // Two processes opening one NEW cache: both read no version row, both
  // insert one, and the second died with `UNIQUE constraint failed:
  // schema_meta.key` (2 in 100 paired runs on a fresh `.vx`, upstream survey
  // nx#28608). The holder plays the first opener, stopped between its insert
  // and its commit, so this open reads no row and writes after it.
  it(
    'a version row another opener is committing is read, not inserted twice',
    async () => {
      const cacheDir = path.join(dir, 'cache')
      await Bun.write(path.join(cacheDir, '.keep'), '')
      const script = `
        import { Database } from 'bun:sqlite'
        import { SCHEMA_VERSION } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/cache/cache.ts'))}
        const db = new Database(${JSON.stringify(path.join(cacheDir, 'cache.db'))}, { create: true })
        db.exec('PRAGMA journal_mode = WAL')
        db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        db.exec('BEGIN IMMEDIATE')
        db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?)").run(SCHEMA_VERSION)
        console.log('held')
        await Bun.sleep(1000)
        db.exec('COMMIT')
        db.close()
      `
      const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('held')
      const cache = new Cache(cacheDir)
      expect(cache.schemaReset).toBeNull()
      cache.close()
      expect(await proc.exited).toBe(0)
    },
    TIMEOUT,
  )
})
