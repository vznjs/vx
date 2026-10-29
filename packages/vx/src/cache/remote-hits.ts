// What the remotes said they hold, kept across runs and processes: `vx dte
// plan` and `vx run` are separate commands on GitLab, and a run trusts this
// at once instead of waiting on a has-many (2026-10-23). Only hits are
// kept: a key not here is a miss. Every has-many that answers rewrites the
// keys it asked, and a GET that finds nothing forgets its key.

import type { Database } from 'bun:sqlite'
import { inHashes } from './schema.js'

export interface RemoteHit {
  readonly size?: number
  readonly durationMs?: number
}

/** What a layered cache asks of the remote-hit rows; the rows stay core's (`IndexRemoteHits`). */
export interface RemoteHits {
  /** The keys of `hashes` a remote last said it holds. */
  get(hashes: readonly string[]): Map<string, RemoteHit>
  record(asked: readonly string[], found: ReadonlyMap<string, RemoteHit>, now?: number): void
  forget(hash: string): void
}

export class IndexRemoteHits implements RemoteHits {
  constructor(
    private readonly db: Database,
    /** Off for a reading verb or an index this user cannot write. */
    private readonly write: boolean,
  ) {}

  /** The keys of `hashes` a remote last said it holds. */
  get(hashes: readonly string[]): Map<string, RemoteHit> {
    const out = new Map<string, RemoteHit>()
    if (hashes.length === 0) return out
    const { test, params } = inHashes(hashes)
    try {
      const rows = this.db
        .query(`SELECT hash, size, duration_ms FROM remote_hits WHERE hash ${test}`)
        .all(...params) as Array<{ hash: string; size: number | null; duration_ms: number | null }>
      for (const r of rows)
        out.set(r.hash, {
          ...(r.size === null ? {} : { size: r.size }),
          ...(r.duration_ms === null ? {} : { durationMs: r.duration_ms }),
        })
    } catch {
      // An unreadable or busy index knows no hit.
    }
    return out
  }

  /** A has-many's whole answer: `found` are hits, the rest of `asked` no longer are. */
  record(asked: readonly string[], found: ReadonlyMap<string, RemoteHit>, now = Date.now()): void {
    if (!this.write || asked.length === 0) return
    try {
      const upsert = this.db.query(
        'INSERT OR REPLACE INTO remote_hits(hash, size, duration_ms, seen_at) VALUES (?, ?, ?, ?)',
      )
      const gone = asked.filter((h) => !found.has(h))
      this.db.transaction(() => {
        for (const [hash, info] of found)
          upsert.run(hash, info.size ?? null, info.durationMs ?? null, now)
        if (gone.length > 0) {
          const { test, params } = inHashes(gone)
          this.db.query(`DELETE FROM remote_hits WHERE hash ${test}`).run(...params)
        }
      })()
    } catch {
      // A busy index keeps nothing: the next run asks again.
    }
  }

  /** No remote served `hash`: a miss from now on. */
  forget(hash: string): void {
    if (!this.write) return
    try {
      this.db.query('DELETE FROM remote_hits WHERE hash = ?').run(hash)
    } catch {
      // A busy index keeps the row: its next GET forgets it.
    }
  }
}
