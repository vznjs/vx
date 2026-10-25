// A `Store` over Postgres through Bun's own client (`Bun.SQL`): one
// database many Bun nodes share. Every write is one statement, the sweep
// takes its rows with SKIP LOCKED, and the server keeps no node's state,
// so nodes come and go freely.

import { type ArtifactRow, type RunRow, type Store, TRUSTED } from './store.js'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS artifacts (ns TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, blob TEXT NOT NULL, size BIGINT NOT NULL, duration_ms BIGINT NOT NULL, tag TEXT, sha TEXT, dirty_hash TEXT, created_at BIGINT NOT NULL, PRIMARY KEY (ns, key, scope))`,
  `CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts (created_at)`,
  `CREATE TABLE IF NOT EXISTS runs (ns TEXT NOT NULL, scope TEXT NOT NULL, started_at BIGINT NOT NULL, id TEXT NOT NULL, duration_ms BIGINT NOT NULL, task_count INTEGER NOT NULL, failed_count INTEGER NOT NULL, tasks JSONB NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (ns, scope, started_at, id))`,
  `CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at)`,
]

/** Any constant: nodes making the tables at once take turns on it. */
const SCHEMA_LOCK = 0x76_78_63_61

// BIGINT reads back as a string; these columns are milliseconds and bytes, exact as doubles.
const ARTIFACT = `key, scope, blob, size::float8 AS size, duration_ms::float8 AS duration_ms, tag, sha, dirty_hash`

/** `url`: `postgres://user:pass@host:5432/db`. */
export function postgresStore(url: string): Store & { close(): Promise<void> } {
  const sql = new Bun.SQL(url)
  const q = <T>(text: string, params: unknown[]): Promise<T[]> =>
    sql.unsafe(text, params) as unknown as Promise<T[]>
  return {
    // Two nodes' CREATE TABLE IF NOT EXISTS at once can still collide on
    // Postgres's catalog: the advisory lock makes them take turns.
    init: () =>
      sql.begin(async (tx) => {
        await tx.unsafe(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`)
        for (const s of SCHEMA) await tx.unsafe(s)
      }),
    artifacts: (ns, keys, scopes) =>
      q<ArtifactRow>(
        `SELECT ${ARTIFACT} FROM artifacts WHERE ns = $1 AND key IN (SELECT jsonb_array_elements_text(($2::text)::jsonb)) AND scope IN (SELECT jsonb_array_elements_text(($3::text)::jsonb))`,
        [ns, JSON.stringify(keys), JSON.stringify(scopes)],
      ),
    held: async (ns, key, scope) =>
      (
        await q(`SELECT 1 FROM artifacts WHERE ns = $1 AND key = $2 AND scope = $3`, [
          ns,
          key,
          scope,
        ])
      ).length > 0,
    addArtifact: async (r) =>
      (
        await q(
          `INSERT INTO artifacts (ns, key, scope, blob, size, duration_ms, tag, sha, dirty_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING 1`,
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
        )
      ).length > 0,
    addRun: async (r) =>
      (
        await q(
          `INSERT INTO runs (ns, scope, started_at, id, duration_ms, task_count, failed_count, tasks, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, ($8::text)::jsonb, $9) ON CONFLICT DO NOTHING RETURNING 1`,
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
        )
      ).length > 0,
    runs: (ns, scopes, limit) =>
      q<RunRow>(
        `SELECT id, scope, started_at::float8 AS started_at, duration_ms::float8 AS duration_ms, task_count, failed_count FROM runs WHERE ns = $1 AND scope IN (SELECT jsonb_array_elements_text(($2::text)::jsonb)) ORDER BY started_at DESC, id LIMIT $3`,
        [ns, JSON.stringify(scopes), limit],
      ),
    samples: (ns, scopes, tasks, limit, scanned) =>
      q(
        `SELECT run, scope, task FROM (SELECT r.id AS run, r.scope AS scope, r.started_at AS at, t.value::text AS task, ROW_NUMBER() OVER (PARTITION BY t.value ->> 'task' ORDER BY r.started_at DESC, r.id) AS n FROM (SELECT id, scope, started_at, tasks FROM runs WHERE ns = $1 AND scope IN (SELECT jsonb_array_elements_text(($2::text)::jsonb)) ORDER BY started_at DESC, id LIMIT $5) r, jsonb_array_elements(r.tasks) t WHERE t.value ->> 'task' IN (SELECT jsonb_array_elements_text(($3::text)::jsonb))) s WHERE n <= $4 ORDER BY at DESC, run`,
        [ns, JSON.stringify(scopes), JSON.stringify(tasks), limit, scanned],
      ),
    // SKIP LOCKED: nodes sweeping at once each take rows no other took.
    takeExpired: (trustedBefore, branchBefore, limit) =>
      q(
        `DELETE FROM artifacts WHERE (ns, key, scope) IN (SELECT ns, key, scope FROM artifacts WHERE created_at < CASE WHEN scope = $1 THEN $2::bigint ELSE $3::bigint END LIMIT $4 FOR UPDATE SKIP LOCKED) RETURNING blob`,
        [TRUSTED, trustedBefore, branchBefore, limit],
      ),
    dropRuns: async (before, limit) =>
      (
        await q(
          `DELETE FROM runs WHERE (ns, scope, started_at, id) IN (SELECT ns, scope, started_at, id FROM runs WHERE created_at < $1 LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING 1`,
          [before, limit],
        )
      ).length,
    close: () => sql.close(),
  }
}
