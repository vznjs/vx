import { describe, expect, it } from 'bun:test'
import { openDb, parseSocketDatabaseUrl } from '../src/db/client.js'
import { runMigrations, MIGRATION_LOCK_KEY } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations/index.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

describe('parseSocketDatabaseUrl', () => {
  it('parses the libpq socket form', () => {
    expect(parseSocketDatabaseUrl('postgres://vx@/mydb?host=/tmp/sock')).toEqual({
      path: '/tmp/sock',
      username: 'vx',
      database: 'mydb',
    })
  })

  it('parses user:password and defaults the database', () => {
    expect(parseSocketDatabaseUrl('postgresql://u:p@/?host=/var/run/pg')).toEqual({
      path: '/var/run/pg',
      username: 'u',
      password: 'p',
      database: 'postgres',
    })
  })

  it('returns null for a plain TCP URL (Bun.sql parses those natively)', () => {
    expect(parseSocketDatabaseUrl('postgres://vx:pw@db.example.com:5432/vx')).toBeNull()
    expect(parseSocketDatabaseUrl('postgres://localhost/vx?sslmode=disable')).toBeNull()
  })
})

describe('migration runner', () => {
  it('applies all migrations to a fresh database, re-apply is a no-op', async () => {
    const pg = await ephemeralPg()
    const db = openDb(await pg.createDatabase({ empty: true }))
    try {
      const first = await runMigrations(db)
      expect(first).toBe(MIGRATIONS.length)
      const again = await runMigrations(db)
      expect(again).toBe(0)
      const rows = await db.sql<{ version: number; name: string }[]>`
        SELECT version, name FROM schema_migrations ORDER BY version`
      expect(rows.map((r) => [Number(r.version), r.name])).toEqual(
        MIGRATIONS.map((m) => [m.version, m.name]),
      )
    } finally {
      await db.close()
    }
  })

  it('concurrent applies serialize on the advisory lock — each migration lands once', async () => {
    const pg = await ephemeralPg()
    const url = await pg.createDatabase({ empty: true })
    const a = openDb(url)
    const b = openDb(url)
    try {
      const [ra, rb] = await Promise.all([runMigrations(a), runMigrations(b)])
      // One boot wins the lock and applies everything; the other sees them done.
      expect([ra, rb].sort((x, y) => x - y)).toEqual([0, MIGRATIONS.length])
      const rows = await a.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM schema_migrations`
      expect(rows[0]!.c).toBe(MIGRATIONS.length)
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('a version recorded under a different name is a divergence error', async () => {
    const pg = await ephemeralPg()
    const db = openDb(await pg.createDatabase({ empty: true }))
    try {
      await runMigrations(db, [{ version: 1, name: 'other', sql: 'CREATE TABLE x (id int)' }])
      await expect(runMigrations(db, [MIGRATIONS[0]!])).rejects.toThrow(
        'divergent migration history',
      )
    } finally {
      await db.close()
    }
  })

  it('rejects an out-of-order migration set', async () => {
    const pg = await ephemeralPg()
    const db = openDb(await pg.createDatabase({ empty: true }))
    try {
      await expect(
        runMigrations(db, [
          { version: 2, name: 'b', sql: 'SELECT 1' },
          { version: 1, name: 'a', sql: 'SELECT 1' },
        ]),
      ).rejects.toThrow('out of order')
    } finally {
      await db.close()
    }
  })

  it('lock key is a stable 32-bit constant', () => {
    expect(MIGRATION_LOCK_KEY).toBe(0x76786301)
    expect(Number.isInteger(MIGRATION_LOCK_KEY)).toBe(true)
  })
})

describe('schema smoke', () => {
  it('user/org/membership/token round-trip on a template clone', async () => {
    const pg = await ephemeralPg()
    const db = openDb(await pg.createDatabase())
    try {
      const now = Date.now()
      const userId = Bun.randomUUIDv7()
      const orgId = Bun.randomUUIDv7()
      const tokenId = Bun.randomUUIDv7()
      await db.sql`INSERT INTO users (id, email, display_name, password_hash, instance_admin, created_at)
                   VALUES (${userId}, ${'a@b.c'}, ${'A'}, ${'x'}, ${true}, ${now})`
      await db.sql`INSERT INTO organizations (id, slug, name, created_at)
                   VALUES (${orgId}, ${'acme'}, ${'Acme'}, ${now})`
      await db.sql`INSERT INTO org_memberships (org_id, user_id, role, created_at)
                   VALUES (${orgId}, ${userId}, ${'owner'}, ${now})`
      const hash = new Uint8Array(32).fill(7)
      await db.sql`INSERT INTO api_tokens (id, org_id, name, token_hash, kind, trust_tier, created_by, created_at)
                   VALUES (${tokenId}, ${orgId}, ${'ci'}, ${hash}, ${'ci'}, ${'untrusted'}, ${userId}, ${now})`
      const got = await db.sql<
        { role: string; trust_tier: string; token_hash: Uint8Array; created_at: string }[]
      >`SELECT m.role, t.trust_tier, t.token_hash, u.created_at
         FROM org_memberships m
         JOIN api_tokens t ON t.org_id = m.org_id
         JOIN users u ON u.id = m.user_id
         WHERE m.user_id = ${userId}`
      expect(got).toHaveLength(1)
      expect(got[0]!.role).toBe('owner')
      expect(got[0]!.trust_tier).toBe('untrusted')
      expect(Array.from(got[0]!.token_hash)).toEqual(Array.from(hash))
      // bigint columns come back as strings from Bun.sql — readers Number() them.
      expect(Number(got[0]!.created_at)).toBe(now)
      // ON DELETE CASCADE: dropping the org removes membership + token.
      await db.sql`DELETE FROM organizations WHERE id = ${orgId}`
      const counts = await db.sql<{ m: number; t: number }[]>`
        SELECT (SELECT count(*)::int FROM org_memberships) AS m,
               (SELECT count(*)::int FROM api_tokens) AS t`
      expect(counts[0]).toEqual({ m: 0, t: 0 })
    } finally {
      await db.close()
    }
  })

  it('two template clones are isolated', async () => {
    const pg = await ephemeralPg()
    const db1 = openDb(await pg.createDatabase())
    const db2 = openDb(await pg.createDatabase())
    try {
      await db1.sql`INSERT INTO organizations (id, slug, name, created_at)
                    VALUES (${Bun.randomUUIDv7()}, ${'only-in-1'}, ${'One'}, ${Date.now()})`
      const rows = await db2.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM organizations`
      expect(rows[0]!.c).toBe(0)
    } finally {
      await db1.close()
      await db2.close()
    }
  })
})
