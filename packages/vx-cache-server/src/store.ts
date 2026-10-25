// Where a server keeps what it is sent: blobs in a bucket (S3 or R2), the
// rest in SQLite (bun:sqlite or D1). Both backends share the schema and
// every query here, so they answer alike.

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

// One row per artifact and one per run, and no index beyond each primary
// key: D1's free plan counts every row an insert writes, index rows too
// (100 000 a day). A run's tasks are one JSON column for the same reason,
// read back through json_each, so D1 parses it, not the Worker's 10 ms.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS artifacts (ns TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, size INTEGER NOT NULL, duration_ms INTEGER NOT NULL, tag TEXT, sha TEXT, dirty_hash TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (ns, key, scope)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS runs (ns TEXT NOT NULL, scope TEXT NOT NULL, started_at INTEGER NOT NULL, id TEXT NOT NULL, duration_ms INTEGER NOT NULL, task_count INTEGER NOT NULL, failed_count INTEGER NOT NULL, tasks TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (ns, scope, started_at, id)) WITHOUT ROWID`,
]

/** The trusted scope: what a write token stores to, and every read's last. */
export const TRUSTED = 'trusted'

/** A blob's name in the bucket: its namespace, scope and key. */
export const blobName = (ns: string, scope: string, key: string): string =>
  `v1/${encodeURIComponent(ns)}/${encodeURIComponent(scope)}/${key}`

export interface ArtifactRow {
  key: string
  scope: string
  size: number
  duration_ms: number
  tag: string | null
  sha: string | null
  dirty_hash: string | null
}

/** The first of `scopes`, in order, holding each of `keys`. */
export async function findArtifacts(
  db: Db,
  ns: string,
  keys: readonly string[],
  scopes: readonly string[],
): Promise<Map<string, ArtifactRow>> {
  const rows = await db.all<ArtifactRow>(
    `SELECT key, scope, size, duration_ms, tag, sha, dirty_hash FROM artifacts WHERE ns = ?1 AND key IN (SELECT value FROM json_each(?2)) AND scope IN (SELECT value FROM json_each(?3))`,
    [ns, JSON.stringify(keys), JSON.stringify(scopes)],
  )
  const found = new Map<string, ArtifactRow>()
  for (const row of rows) {
    const held = found.get(row.key)
    if (held === undefined || scopes.indexOf(row.scope) < scopes.indexOf(held.scope)) {
      found.set(row.key, row)
    }
  }
  return found
}
