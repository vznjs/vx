// A key's stored artifact wherever the cache keeps it: inline in the index
// (`artifacts`, at most INLINE_MAX compressed bytes) or a file at
// `outputsPath`. A test that damages, removes or reads the stored bytes goes
// through here, so it reaches the copy a restore reads.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Cache } from '../../src/cache/index.js'

export function storedArtifact(cache: Cache, hash: string): Uint8Array | null {
  const row = cache.dbHandle().query('SELECT bytes FROM artifacts WHERE hash = ?').get(hash) as {
    bytes: Uint8Array
  } | null
  if (row !== null) return row.bytes
  const file = cache.outputsPath(hash)
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null
}

/** Whether the key's artifact is inline in the index. */
export function isInline(cache: Cache, hash: string): boolean {
  return cache.dbHandle().query('SELECT 1 FROM artifacts WHERE hash = ?').get(hash) !== null
}

/** Put `bytes` where the key's artifact is (inline when it is inline), as damage on disk would. */
export function replaceStoredArtifact(cache: Cache, hash: string, bytes: Uint8Array): void {
  const updated = cache
    .dbHandle()
    .query('UPDATE artifacts SET bytes = ? WHERE hash = ?')
    .run(bytes, hash).changes
  if (updated === 0) writeFileSync(cache.outputsPath(hash), bytes)
}

/** Remove the key's artifact and leave its rows: a hand-deleted file, a raced prune. */
export function removeStoredArtifact(cache: Cache, hash: string): void {
  cache.dbHandle().query('DELETE FROM artifacts WHERE hash = ?').run(hash)
  rmSync(cache.outputsPath(hash), { force: true })
}

/**
 * The keys with an artifact in a store directory, inline (its `dbFile`) or
 * as a `<hash>.tar.zst` file, sorted: what a test that listed the files
 * asked.
 */
export function storedKeys(dir: string, dbFile = 'cache.db'): string[] {
  const keys = new Set(
    readdirSync(dir)
      .filter((n) => n.endsWith('.tar.zst'))
      .map((n) => n.slice(0, -'.tar.zst'.length)),
  )
  const file = path.join(dir, dbFile)
  if (existsSync(file)) {
    const db = new Database(file, { readonly: true })
    try {
      const has = db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'")
        .get()
      if (has !== null) {
        for (const r of db.query('SELECT hash FROM artifacts').all() as Array<{ hash: string }>) {
          keys.add(r.hash)
        }
      }
    } finally {
      db.close()
    }
  }
  return [...keys].sort()
}

/**
 * Every stored artifact's bytes under `root`, files and inline blobs of any
 * `*.db` index or store, by where each lives: what a test that scanned for
 * `*.tar.zst` files to prove something never landed must scan now.
 */
export function storedBytesUnder(root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  for (const f of new Bun.Glob('**/*.tar.zst').scanSync({ cwd: root, dot: true })) {
    out.set(f, new Uint8Array(readFileSync(path.join(root, f))))
  }
  for (const f of new Bun.Glob('**/*.db').scanSync({ cwd: root, dot: true })) {
    const db = new Database(path.join(root, f), { readonly: true })
    try {
      const has = db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'")
        .get()
      if (has === null) continue
      const rows = db.query('SELECT hash, bytes FROM artifacts').all() as Array<{
        hash: string
        bytes: Uint8Array
      }>
      for (const r of rows) out.set(`${f}#${r.hash}`, r.bytes)
    } finally {
      db.close()
    }
  }
  return out
}
