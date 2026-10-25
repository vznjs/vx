// Where a server keeps what it is sent: blobs in a bucket (S3 or R2), the
// rest in a `Store`: SQLite (bun:sqlite or D1, `sqliteStore`) or Postgres
// (`postgresStore`, for many Bun nodes over one database). A store holds
// no node's state: every write is one idempotent statement, so any number
// of nodes may share it and its bucket.

import { TRUSTED } from '@vzn/vx-devtools'

/** A bucket of immutable blobs by name. */
export interface Blobs {
  /** Stores `size` bytes; rejects when the stream ends at another length. */
  put(name: string, body: ReadableStream<Uint8Array>, size: number): Promise<void>
  /** The blob's bytes, or null when the bucket has none by that name. */
  get(name: string): Promise<ReadableStream<Uint8Array> | Blob | null>
  delete(name: string): Promise<void>
}

/** SQLite, over positional `?n` parameters. */
export interface Db {
  all<T>(sql: string, params: readonly unknown[]): Promise<T[]>
  /** Rows changed. */
  run(sql: string, params: readonly unknown[]): Promise<number>
  /** Each statement, in one transaction. */
  batch(statements: readonly string[]): Promise<void>
}

export interface ArtifactRow {
  key: string
  scope: string
  size: number
}

export interface NewArtifact extends ArtifactRow {
  repo: string
  created_at: number
}

/** What the scheduler learns from one run of a task that succeeded. */
export interface Timing {
  /** The task's definition hash, opaque to the server. */
  hash: string
  durationMs: number
  /** CPU cores it kept busy on average. */
  cores: number | null
  /** Its peak memory. */
  rssBytes: number | null
}

/** What the server asks of its database. */
export interface Store {
  /** Makes the tables; any node may, at any time. */
  init(): Promise<void>
  /** Every row of `keys` in `scopes`; `firstScopes` picks one per key. */
  artifacts(
    repo: string,
    keys: readonly string[],
    scopes: readonly string[],
  ): Promise<ArtifactRow[]>
  /** True when this insert made the row; false when one was already held. */
  addArtifact(row: NewArtifact): Promise<boolean>
  /** One statement: a hash already timed at `createdAt` keeps its timing. */
  addTimings(
    repo: string,
    scope: string,
    createdAt: number,
    timings: readonly Timing[],
  ): Promise<void>
  /** Up to `limit` newest timings of each of `hashes` in each of `scopes`, newest first. */
  timings(
    repo: string,
    hashes: readonly string[],
    scopes: readonly string[],
    limit: number,
  ): Promise<(Timing & { scope: string })[]>
  /**
   * Deletes up to `limit` artifact rows written before their scope's
   * cutoff and returns them: a row two nodes sweep at once is returned to
   * one of them.
   */
  takeExpired(
    trustedBefore: number,
    branchBefore: number,
    limit: number,
  ): Promise<(ArtifactRow & { repo: string })[]>
  /** Deletes the timings written before `before`; how many. */
  dropTimings(before: number): Promise<number>
}

export { TRUSTED }

/**
 * A blob's name in the bucket, derived from its row. Two uploads of a key
 * at once write one name only when their sizes match, so the row's size is
 * always its blob's: the bucket keeps one whole upload of the two.
 */
export const blobName = (repo: string, row: ArtifactRow): string =>
  `v1/${encodeURIComponent(repo)}/${encodeURIComponent(row.scope)}/${row.key}/${row.size}`

/** The first of `scopes`, in order, holding each key. */
export function firstScopes(
  rows: readonly ArtifactRow[],
  scopes: readonly string[],
): Map<string, ArtifactRow> {
  const found = new Map<string, ArtifactRow>()
  for (const row of rows) {
    const held = found.get(row.key)
    if (held === undefined || scopes.indexOf(row.scope) < scopes.indexOf(held.scope)) {
      found.set(row.key, row)
    }
  }
  return found
}

// No index beyond each primary key: D1's free plan counts every row an
// insert writes, index rows too (100 000 a day). The daily sweep scans
// instead, which costs reads (5 000 000 a day).
const SQLITE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS artifacts (repo TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (repo, key, scope)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS timings (repo TEXT NOT NULL, hash TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, cores REAL, rss_bytes INTEGER, PRIMARY KEY (repo, hash, scope, created_at, duration_ms)) WITHOUT ROWID`,
]

type TimingRow = {
  hash: string
  scope: string
  duration_ms: number
  cores: number | null
  rss_bytes: number | null
}

export const timingOf = (r: TimingRow): Timing & { scope: string } => ({
  hash: r.hash,
  scope: r.scope,
  durationMs: r.duration_ms,
  cores: r.cores,
  rssBytes: r.rss_bytes,
})

/** A `Store` over SQLite: bun:sqlite on one node, or D1. */
export function sqliteStore(db: Db): Store {
  return {
    init: () => db.batch(SQLITE_SCHEMA),
    artifacts: (repo, keys, scopes) =>
      db.all<ArtifactRow>(
        `SELECT key, scope, size FROM artifacts WHERE repo = ?1 AND key IN (SELECT value FROM json_each(?2)) AND scope IN (SELECT value FROM json_each(?3))`,
        [repo, JSON.stringify(keys), JSON.stringify(scopes)],
      ),
    addArtifact: async (r) =>
      (await db.run(
        `INSERT INTO artifacts (repo, key, scope, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING`,
        [r.repo, r.key, r.scope, r.size, r.created_at],
      )) > 0,
    // `WHERE true`: SQLite reads an upsert's SELECT without one as a join.
    addTimings: async (repo, scope, createdAt, timings) => {
      await db.run(
        `INSERT INTO timings (repo, hash, scope, created_at, duration_ms, cores, rss_bytes) SELECT ?1, value ->> 'hash', ?2, ?3, value ->> 'durationMs', value ->> 'cores', value ->> 'rssBytes' FROM json_each(?4) WHERE true ON CONFLICT DO NOTHING`,
        [repo, scope, createdAt, JSON.stringify(timings)],
      )
    },
    // Per hash and scope, the `limit`th newest timing's time is read off the
    // primary key, then the timings at or after it: about 2 × limit rows
    // each, however many the table holds.
    timings: async (repo, hashes, scopes, limit) =>
      (
        await db.all<TimingRow>(
          `SELECT s.hash, s.scope, s.duration_ms, s.cores, s.rss_bytes FROM json_each(?2) d, json_each(?3) c JOIN timings s ON s.repo = ?1 AND s.hash = d.value AND s.scope = c.value AND s.created_at >= COALESCE((SELECT x.created_at FROM timings x WHERE x.repo = ?1 AND x.hash = d.value AND x.scope = c.value ORDER BY x.created_at DESC LIMIT 1 OFFSET ?4 - 1), 0) ORDER BY s.created_at DESC`,
          [repo, JSON.stringify(hashes), JSON.stringify(scopes), limit],
        )
      ).map(timingOf),
    // One statement: SQLite and D1 run each alone, so two sweeps never take one row.
    takeExpired: (trustedBefore, branchBefore, limit) =>
      db.all(
        `DELETE FROM artifacts WHERE (repo, key, scope) IN (SELECT repo, key, scope FROM artifacts WHERE created_at < CASE WHEN scope = ?1 THEN ?2 ELSE ?3 END LIMIT ?4) RETURNING repo, key, scope, size`,
        [TRUSTED, trustedBefore, branchBefore, limit],
      ),
    dropTimings: (before) => db.run(`DELETE FROM timings WHERE created_at < ?1`, [before]),
  }
}
