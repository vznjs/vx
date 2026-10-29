// A lockfile claimant's parse, kept in cache.db's `lockfile_memos` (v50; a
// `lockfile-claims/` file before): what orchestrator/lockfile-claim.ts reads
// so a warm run never parses the lockfile. Its readers run where no `Cache`
// is open yet — a `discover` hook, `--affected`'s selection, a verb that
// opens none — so each call opens the index on its own and closes it. Only
// an index that exists and holds this vx's schema is read or written: one
// another vx wrote is reset by the next run, and a directory with none is
// left for the run that makes it. A failure of any kind is a miss: the memo
// is a speed-up, never a requirement.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { closeDb, SCHEMA_VERSION, SQLITE_FCNTL_PERSIST_WAL } from './cache.js'

/** One claimant's parse of one lockfile's content. */
export interface LockfileMemo {
  /** The claimant's own counter: bumped when it digests differently. */
  version: number
  /** xxh3 of the lockfile's bytes. */
  lock: string
  /** Each extra file the digests read → its content hash then. */
  extras: Record<string, string>
  importers: Record<string, string>
  edges: Record<string, unknown>
  /** Each importer's recorded dependency names; absent when the claimant reads none. */
  recorded?: Record<string, readonly string[]>
}

function withIndex<T>(cacheDir: string, use: (db: Database) => T): T | undefined {
  const file = path.join(cacheDir, 'cache.db')
  if (!existsSync(file)) return undefined
  let db: Database
  try {
    db = new Database(file, { readwrite: true })
  } catch {
    return undefined
  }
  try {
    // As `Cache` opens it: wait for another run's write, and keep `-wal`
    // and `-shm` when this is the last connection to close (O-10).
    db.exec('PRAGMA busy_timeout = 5000')
    db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 1)
    db.exec('PRAGMA journal_size_limit = 67108864')
    return use(db)
  } catch {
    return undefined
  } finally {
    closeDb(db)
  }
}

const CURRENT = "(SELECT value FROM schema_meta WHERE key = 'version') = ?"

/** The memo `claimant` kept of `file`; undefined when none or another content's. */
export function readLockfileMemo(
  cacheDir: string,
  file: string,
  claimant: string,
): LockfileMemo | undefined {
  return withIndex(cacheDir, (db) => {
    const row = db
      .query(
        `SELECT version, lock, extras, importers, edges, recorded FROM lockfile_memos
         WHERE file = ? AND claimant = ? AND ${CURRENT}`,
      )
      .get(file, claimant, SCHEMA_VERSION) as {
      version: number
      lock: string
      extras: string
      importers: string
      edges: string
      recorded: string | null
    } | null
    if (row === null) return undefined
    return {
      version: row.version,
      lock: row.lock,
      extras: JSON.parse(row.extras) as Record<string, string>,
      importers: JSON.parse(row.importers) as Record<string, string>,
      edges: JSON.parse(row.edges) as Record<string, unknown>,
      ...(row.recorded !== null
        ? { recorded: JSON.parse(row.recorded) as Record<string, readonly string[]> }
        : {}),
    }
  })
}

/** Keep `memo` as `claimant`'s of `file`, replacing the last; false when it was not kept. */
export function writeLockfileMemo(
  cacheDir: string,
  file: string,
  claimant: string,
  memo: LockfileMemo,
): boolean {
  return (
    withIndex(
      cacheDir,
      (db) =>
        db
          .query(
            `INSERT OR REPLACE INTO lockfile_memos
               (file, claimant, version, lock, extras, importers, edges, recorded)
             SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${CURRENT}`,
          )
          .run(
            file,
            claimant,
            memo.version,
            memo.lock,
            JSON.stringify(memo.extras),
            JSON.stringify(memo.importers),
            JSON.stringify(memo.edges),
            memo.recorded === undefined ? null : JSON.stringify(memo.recorded),
            SCHEMA_VERSION,
          ).changes > 0,
    ) ?? false
  )
}
