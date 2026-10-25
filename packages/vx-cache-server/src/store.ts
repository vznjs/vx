// Where a server keeps what it is sent: blobs in a bucket (S3 or R2), the
// rest in a `Store`: SQLite (bun:sqlite or D1, `sqliteStore`) or Postgres
// (`postgresStore`, for many Bun nodes over one database). A store holds
// no node's state: every write is one idempotent statement, so any number
// of nodes may share it and its bucket.

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
  /** Its blob's name: each write names its own, so racing writes never share one. */
  blob: string
  size: number
  duration_ms: number
  tag: string | null
  sha: string | null
  dirty_hash: string | null
}

export interface NewArtifact extends ArtifactRow {
  ns: string
  created_at: number
}

export interface RunRow {
  id: string
  scope: string
  started_at: number
  duration_ms: number
  task_count: number
  failed_count: number
}

export interface NewRun extends RunRow {
  ns: string
  /** Its tasks, a JSON list. */
  tasks: string
  created_at: number
}

/** What the server asks of its database. */
export interface Store {
  /** Makes the tables; any node may, at any time. */
  init(): Promise<void>
  /** Every row of `keys` in `scopes`; `firstScopes` picks one per key. */
  artifacts(ns: string, keys: readonly string[], scopes: readonly string[]): Promise<ArtifactRow[]>
  held(ns: string, key: string, scope: string): Promise<boolean>
  /** True when this insert made the row; false when one was already held. */
  addArtifact(row: NewArtifact): Promise<boolean>
  addRun(row: NewRun): Promise<boolean>
  runs(ns: string, scopes: readonly string[], limit: number): Promise<RunRow[]>
  /**
   * Up to `limit` newest records of each of `tasks` among the newest
   * `scanned` runs in `scopes`, newest first; `task` is the record's JSON.
   */
  samples(
    ns: string,
    scopes: readonly string[],
    tasks: readonly string[],
    limit: number,
    scanned: number,
  ): Promise<{ run: string; scope: string; task: string }[]>
  /**
   * Deletes up to `limit` artifact rows written before their scope's
   * cutoff and returns them: a row two nodes sweep at once is returned to
   * one of them.
   */
  takeExpired(
    trustedBefore: number,
    branchBefore: number,
    limit: number,
  ): Promise<{ blob: string }[]>
  /** Deletes up to `limit` runs written before `before`; how many. */
  dropRuns(before: number, limit: number): Promise<number>
}

/** The trusted scope: what a write token stores to, and every read's last. */
export const TRUSTED = 'trusted'

/** A blob's name in the bucket: its namespace, scope, key and the write that made it. */
export const blobName = (ns: string, scope: string, key: string, write: string): string =>
  `v1/${encodeURIComponent(ns)}/${encodeURIComponent(scope)}/${key}/${write}`

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

// One row per artifact and one per run, and no index beyond each primary
// key: D1's free plan counts every row an insert writes, index rows too
// (100 000 a day). A run's tasks are one JSON column for the same reason,
// read back through json_each, so D1 parses it, not the Worker's 10 ms.
const SQLITE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS artifacts (ns TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, blob TEXT NOT NULL, size INTEGER NOT NULL, duration_ms INTEGER NOT NULL, tag TEXT, sha TEXT, dirty_hash TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (ns, key, scope)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runs (ns TEXT NOT NULL, scope TEXT NOT NULL, started_at INTEGER NOT NULL, id TEXT NOT NULL, duration_ms INTEGER NOT NULL, task_count INTEGER NOT NULL, failed_count INTEGER NOT NULL, tasks TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (ns, scope, started_at, id)) WITHOUT ROWID`,
]

/** A `Store` over SQLite: bun:sqlite on one node, or D1. */
export function sqliteStore(db: Db): Store {
  return {
    init: () => db.batch(SQLITE_SCHEMA),
    artifacts: (ns, keys, scopes) =>
      db.all<ArtifactRow>(
        `SELECT key, scope, blob, size, duration_ms, tag, sha, dirty_hash FROM artifacts WHERE ns = ?1 AND key IN (SELECT value FROM json_each(?2)) AND scope IN (SELECT value FROM json_each(?3))`,
        [ns, JSON.stringify(keys), JSON.stringify(scopes)],
      ),
    held: async (ns, key, scope) =>
      (
        await db.all(`SELECT 1 FROM artifacts WHERE ns = ?1 AND key = ?2 AND scope = ?3`, [
          ns,
          key,
          scope,
        ])
      ).length > 0,
    addArtifact: async (r) =>
      (await db.run(
        `INSERT INTO artifacts (ns, key, scope, blob, size, duration_ms, tag, sha, dirty_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT DO NOTHING`,
        [
          r.ns,
          r.key,
          r.scope,
          r.blob,
          r.size,
          r.duration_ms,
          r.tag,
          r.sha,
          r.dirty_hash,
          r.created_at,
        ],
      )) > 0,
    addRun: async (r) =>
      (await db.run(
        `INSERT INTO runs (ns, scope, started_at, id, duration_ms, task_count, failed_count, tasks, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT DO NOTHING`,
        [
          r.ns,
          r.scope,
          r.started_at,
          r.id,
          r.duration_ms,
          r.task_count,
          r.failed_count,
          r.tasks,
          r.created_at,
        ],
      )) > 0,
    runs: (ns, scopes, limit) =>
      db.all<RunRow>(
        `SELECT id, scope, started_at, duration_ms, task_count, failed_count FROM runs WHERE ns = ?1 AND scope IN (SELECT value FROM json_each(?2)) ORDER BY started_at DESC, id LIMIT ?3`,
        [ns, JSON.stringify(scopes), limit],
      ),
    samples: (ns, scopes, tasks, limit, scanned) =>
      db.all(
        `SELECT run, scope, task FROM (SELECT r.id AS run, r.scope AS scope, r.started_at AS at, t.value AS task, ROW_NUMBER() OVER (PARTITION BY json_extract(t.value, '$.task') ORDER BY r.started_at DESC, r.id) AS n FROM (SELECT id, scope, started_at, tasks FROM runs WHERE ns = ?1 AND scope IN (SELECT value FROM json_each(?2)) ORDER BY started_at DESC, id LIMIT ?5) r, json_each(r.tasks) t WHERE json_extract(t.value, '$.task') IN (SELECT value FROM json_each(?3))) WHERE n <= ?4 ORDER BY at DESC, run`,
        [ns, JSON.stringify(scopes), JSON.stringify(tasks), limit, scanned],
      ),
    // One statement: SQLite and D1 run each alone, so two sweeps never take one row.
    takeExpired: (trustedBefore, branchBefore, limit) =>
      db.all(
        `DELETE FROM artifacts WHERE (ns, key, scope) IN (SELECT ns, key, scope FROM artifacts WHERE created_at < CASE WHEN scope = ?1 THEN ?2 ELSE ?3 END LIMIT ?4) RETURNING blob`,
        [TRUSTED, trustedBefore, branchBefore, limit],
      ),
    dropRuns: (before, limit) =>
      db.run(
        `DELETE FROM runs WHERE (ns, scope, started_at, id) IN (SELECT ns, scope, started_at, id FROM runs WHERE created_at < ?1 LIMIT ?2)`,
        [before, limit],
      ),
  }
}
