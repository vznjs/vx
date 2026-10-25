// A `Store` over Postgres through Bun's own client (`Bun.SQL`): one
// database many Bun nodes share. Every write is one statement, the sweep
// takes its rows with SKIP LOCKED, and the server keeps no node's state,
// so nodes come and go freely.

import { type ArtifactRow, timingOf, type Store, TRUSTED } from './store.js'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS artifacts (repo TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, size BIGINT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (repo, key, scope))`,
  `CREATE TABLE IF NOT EXISTS timings (repo TEXT NOT NULL, hash TEXT NOT NULL, scope TEXT NOT NULL, created_at BIGINT NOT NULL, duration_ms BIGINT NOT NULL, cores DOUBLE PRECISION, rss_bytes BIGINT, PRIMARY KEY (repo, hash, scope, created_at))`,
]

/** Any constant: nodes making the tables at once take turns on it. */
const SCHEMA_LOCK = 0x76_78_63_61

// BIGINT reads back as a string; these columns are milliseconds and bytes, exact as doubles.
const ARTIFACT = `key, scope, size::float8 AS size`

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
    artifacts: (repo, keys, scopes) =>
      q<ArtifactRow>(
        `SELECT ${ARTIFACT} FROM artifacts WHERE repo = $1 AND key IN (SELECT jsonb_array_elements_text(($2::text)::jsonb)) AND scope IN (SELECT jsonb_array_elements_text(($3::text)::jsonb))`,
        [repo, JSON.stringify(keys), JSON.stringify(scopes)],
      ),
    addArtifact: async (r) =>
      (
        await q(
          `INSERT INTO artifacts (repo, key, scope, size, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING 1`,
          [r.repo, r.key, r.scope, r.size, r.created_at],
        )
      ).length > 0,
    addTimings: async (repo, scope, createdAt, timings) => {
      await q(
        `INSERT INTO timings (repo, hash, scope, created_at, duration_ms, cores, rss_bytes) SELECT $1, e ->> 'hash', $2, $3, (e ->> 'durationMs')::bigint, (e ->> 'cores')::float8, (e ->> 'rssBytes')::bigint FROM jsonb_array_elements(($4::text)::jsonb) e ON CONFLICT DO NOTHING`,
        [repo, scope, createdAt, JSON.stringify(timings)],
      )
    },
    timings: async (repo, hashes, scopes, limit) =>
      (
        await q<Parameters<typeof timingOf>[0]>(
          `SELECT d.hash, c.scope, s.duration_ms::float8 AS duration_ms, s.cores, s.rss_bytes::float8 AS rss_bytes FROM jsonb_array_elements_text(($2::text)::jsonb) d(hash) CROSS JOIN jsonb_array_elements_text(($3::text)::jsonb) c(scope) CROSS JOIN LATERAL (SELECT created_at, duration_ms, cores, rss_bytes FROM timings WHERE repo = $1 AND hash = d.hash AND scope = c.scope ORDER BY created_at DESC LIMIT $4) s ORDER BY s.created_at DESC`,
          [repo, JSON.stringify(hashes), JSON.stringify(scopes), limit],
        )
      ).map(timingOf),
    // SKIP LOCKED: nodes sweeping at once each take rows no other took.
    takeExpired: (trustedBefore, branchBefore, limit) =>
      q(
        `DELETE FROM artifacts WHERE (repo, key, scope) IN (SELECT repo, key, scope FROM artifacts WHERE created_at < CASE WHEN scope = $1 THEN $2::bigint ELSE $3::bigint END LIMIT $4 FOR UPDATE SKIP LOCKED) RETURNING repo, ${ARTIFACT}`,
        [TRUSTED, trustedBefore, branchBefore, limit],
      ),
    dropTimings: async (before) =>
      (await q(`DELETE FROM timings WHERE created_at < $1 RETURNING 1`, [before])).length,
    close: () => sql.close(),
  }
}
