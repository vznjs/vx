// Forward-only migration runner (docs/design/cloud-platform-2026-07.md §7.2).
// Applies pending migrations in version order inside ONE transaction holding
// a transaction-scoped advisory lock, so concurrent boots (compose restarts,
// scaled replicas) serialize and the loser sees everything already applied.
// This replaces — and finally fixes — the SQLite "schema gate wipes history"
// model, which was acceptable for a cache and a landmine for a server.

import type { DbClient } from './client.js'
import { MIGRATIONS, type Migration } from './migrations/index.js'

/**
 * Advisory-lock key serializing migration runs. Arbitrary stable constant
 * ("vxc\x01" as a 32-bit int); only collides with another app choosing the
 * same key on the same database, which is ours alone (§5.1: the app is the
 * only DB client).
 */
export const MIGRATION_LOCK_KEY = 0x76786301

/**
 * Apply pending migrations; returns how many were applied. A version already
 * recorded under a DIFFERENT name means the migration history diverged from
 * the binary's embedded set — forward-only means that's a hard error, never
 * a silent re-interpretation.
 */
export async function runMigrations(
  db: DbClient,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number> {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version <= migrations[i - 1]!.version) {
      throw new Error(
        `migrations out of order: version ${migrations[i]!.version} follows ${migrations[i - 1]!.version}`,
      )
    }
  }
  let applied = 0
  await db.sql.begin(async (tx) => {
    // pg_advisory_xact_lock (not the session form): releases automatically at
    // commit/rollback, and stays on this transaction's connection — a pooled
    // client could route a separate unlock call to a different connection.
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version    int PRIMARY KEY,
        name       text NOT NULL,
        applied_at bigint NOT NULL
      )`,
    )
    const rows = await tx<{ version: number; name: string }[]>`
      SELECT version, name FROM schema_migrations`
    const seen = new Map(rows.map((r) => [Number(r.version), r.name]))
    for (const m of migrations) {
      const existing = seen.get(m.version)
      if (existing !== undefined) {
        if (existing !== m.name) {
          throw new Error(
            `migration ${m.version} applied as "${existing}" but the binary carries "${m.name}" — divergent migration history`,
          )
        }
        continue
      }
      await tx.unsafe(m.sql)
      await tx`INSERT INTO schema_migrations (version, name, applied_at)
               VALUES (${m.version}, ${m.name}, ${Date.now()})`
      applied++
    }
  })
  return applied
}
