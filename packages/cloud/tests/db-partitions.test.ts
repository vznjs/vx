import { describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import {
  dropOldPartitions,
  ensurePartitions,
  maintainPartitions,
  PARTITIONED_TABLES,
} from '../src/db/partitions.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

async function freshDb(): Promise<DbClient> {
  const pg = await ephemeralPg()
  return openDb(await pg.createDatabase())
}

/** Count child partitions of a parent (excludes the parent itself). */
async function childPartitions(db: DbClient, parent: string): Promise<string[]> {
  const rows = await db.sql<{ name: string }[]>`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = ${parent}
    ORDER BY c.relname`
  return rows.map((r) => r.name)
}

describe('ensurePartitions', () => {
  it('creates current + ahead partitions for every partitioned table (migration ships a DEFAULT)', async () => {
    const db = await freshDb()
    try {
      // Each parent ships exactly one DEFAULT partition from the migration.
      for (const { parent } of PARTITIONED_TABLES) {
        expect(await childPartitions(db, parent)).toEqual([`${parent}_default`])
      }
      const now = Date.UTC(2026, 5, 15) // mid-June 2026
      const created = await ensurePartitions(db, { now, ahead: 2 })
      // 3 tables × (current + 2 ahead) = 9.
      expect(created).toBe(9)
      for (const { parent } of PARTITIONED_TABLES) {
        const parts = await childPartitions(db, parent)
        // default + 3 time partitions
        expect(parts).toHaveLength(4)
        expect(parts).toContain(`${parent}_default`)
      }
    } finally {
      await db.close()
    }
  })

  it('is idempotent — a second ensure at the same instant creates nothing', async () => {
    const db = await freshDb()
    try {
      const now = Date.UTC(2026, 2, 1)
      expect(await ensurePartitions(db, { now, ahead: 2 })).toBe(9)
      expect(await ensurePartitions(db, { now, ahead: 2 })).toBe(0)
    } finally {
      await db.close()
    }
  })

  it('a maintenance tick a period later creates the newly-reachable future partition', async () => {
    const db = await freshDb()
    try {
      const now = Date.UTC(2026, 0, 1)
      await ensurePartitions(db, { now, ahead: 2 })
      const before = await childPartitions(db, 'task_runs')
      // A week later, the current+2 window slides forward one week → one new
      // weekly task_runs partition, and the monthly tables likely add nothing.
      const created = await ensurePartitions(db, { now: now + WEEK_MS, ahead: 2 })
      expect(created).toBeGreaterThanOrEqual(1)
      const after = await childPartitions(db, 'task_runs')
      expect(after.length).toBe(before.length + 1)
    } finally {
      await db.close()
    }
  })
})

describe('dropOldPartitions', () => {
  it('drops partitions entirely past retention, keeps DEFAULT and recent ones', async () => {
    const db = await freshDb()
    try {
      const t0 = Date.UTC(2026, 0, 1)
      await ensurePartitions(db, { now: t0, ahead: 2 })
      const beforeWeekly = await childPartitions(db, 'task_runs')
      expect(beforeWeekly.length).toBe(4) // default + 3

      // Advance ~400 days; with a 180-day retention every partition created at
      // t0 is entirely past the horizon and drops; DEFAULT survives.
      const dropped = await dropOldPartitions(db, {
        now: t0 + 400 * DAY_MS,
        retentionDays: 180,
      })
      expect(dropped).toBeGreaterThanOrEqual(3)
      const afterWeekly = await childPartitions(db, 'task_runs')
      expect(afterWeekly).toContain('task_runs_default')
      expect(afterWeekly.every((n) => n === 'task_runs_default')).toBe(true)
    } finally {
      await db.close()
    }
  })

  it('never drops a partition whose range extends past the horizon', async () => {
    const db = await freshDb()
    try {
      const now = Date.UTC(2026, 5, 15)
      await ensurePartitions(db, { now, ahead: 2 })
      // Same-day drop with a long retention removes nothing.
      const dropped = await dropOldPartitions(db, { now, retentionDays: 180 })
      expect(dropped).toBe(0)
    } finally {
      await db.close()
    }
  })
})

describe('maintainPartitions', () => {
  it('creates ahead and drops old in one call', async () => {
    const db = await freshDb()
    try {
      const now = Date.UTC(2026, 5, 15)
      const first = await maintainPartitions(db, { now, ahead: 2, retentionDays: 180 })
      expect(first.created).toBe(9)
      expect(first.dropped).toBe(0)
      // Far in the future: creates the new window and drops the original one.
      const later = await maintainPartitions(db, {
        now: now + 400 * DAY_MS,
        ahead: 2,
        retentionDays: 180,
      })
      expect(later.created).toBeGreaterThan(0)
      expect(later.dropped).toBeGreaterThan(0)
    } finally {
      await db.close()
    }
  })
})

describe('default partition catches out-of-range inserts', () => {
  it('a row for an uncreated period lands in the DEFAULT partition and is queryable', async () => {
    const db = await freshDb()
    try {
      const now = Date.UTC(2026, 5, 15)
      await ensurePartitions(db, { now, ahead: 2 })
      // Insert a task_runs row 5 years in the past — no partition covers it.
      const past = Date.UTC(2021, 0, 1)
      const orgId = Bun.randomUUIDv7()
      const wsId = Bun.randomUUIDv7()
      await db.sql`
        INSERT INTO task_runs
          (org_id, workspace_id, run_id, hash, project, task, status, exit_code, duration_ms, started_at, ended_at)
        VALUES (${orgId}, ${wsId}, ${'r1'}, ${'h1'}, ${'p'}, ${'build'}, ${'success'}, ${0}, ${10}, ${past}, ${past + 10})`
      const loc = await db.sql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM task_runs WHERE run_id = ${'r1'}`
      expect(loc[0]!.part).toBe('task_runs_default')
      const seen = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM task_runs`
      expect(seen[0]!.n).toBe(1)
    } finally {
      await db.close()
    }
  })

  it('a row within a created period lands in that partition, not DEFAULT', async () => {
    const db = await freshDb()
    try {
      const now = Date.UTC(2026, 5, 15)
      await ensurePartitions(db, { now, ahead: 2 })
      const orgId = Bun.randomUUIDv7()
      const wsId = Bun.randomUUIDv7()
      await db.sql`
        INSERT INTO task_runs
          (org_id, workspace_id, run_id, hash, project, task, status, exit_code, duration_ms, started_at, ended_at)
        VALUES (${orgId}, ${wsId}, ${'r2'}, ${'h2'}, ${'p'}, ${'build'}, ${'success'}, ${0}, ${10}, ${now}, ${now + 10})`
      const loc = await db.sql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM task_runs WHERE run_id = ${'r2'}`
      expect(loc[0]!.part).not.toBe('task_runs_default')
      expect(loc[0]!.part.startsWith('task_runs_p')).toBe(true)
    } finally {
      await db.close()
    }
  })
})

describe('DEFAULT-collision recovery (security-review regression)', () => {
  it('creates a partition whose range already has rows in DEFAULT — moves them, never throws', async () => {
    const db = await freshDb()
    try {
      const orgId = Bun.randomUUIDv7()
      const wsId = Bun.randomUUIDv7()
      // A future-dated task_run beyond the created window lands in DEFAULT.
      const now = Date.UTC(2026, 5, 15)
      await ensurePartitions(db, { now, ahead: 0 }) // only the current week
      const future = now + 10 * WEEK_MS // far beyond ahead → DEFAULT
      await db.sql`
        INSERT INTO task_runs
          (org_id, workspace_id, run_id, hash, project, task, status, exit_code, duration_ms, started_at, ended_at)
        VALUES (${orgId}, ${wsId}, ${'rf'}, ${'h'}, ${'p'}, ${'build'}, ${'success'}, ${0}, ${10}, ${future}, ${future + 10})`
      const inDefault = await db.sql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM task_runs WHERE run_id = ${'rf'}`
      expect(inDefault[0]!.part).toBe('task_runs_default')

      // Now advance to that future week and run maintenance — a plain CREATE
      // would collide with the DEFAULT row; the recovery must move it out.
      const warnings: string[] = []
      const res = await maintainPartitions(db, {
        now: future,
        ahead: 0,
        retentionDays: 100_000,
        warn: (m) => warnings.push(m),
      })
      expect(warnings).toEqual([]) // recovered, not just skipped
      expect(res.created).toBeGreaterThan(0)
      // The row now lives in its own partition, not DEFAULT.
      const moved = await db.sql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM task_runs WHERE run_id = ${'rf'}`
      expect(moved[0]!.part).not.toBe('task_runs_default')
      expect(moved[0]!.part.startsWith('task_runs_p')).toBe(true)
    } finally {
      await db.close()
    }
  })

  it('maintainPartitions never throws even against a wedged table (boot-safe)', async () => {
    const db = await freshDb()
    try {
      // A DEFAULT row inside the CURRENT window: a plain create collides; the
      // recovery handles it, but even if recovery were impossible the call must
      // resolve (never throw) so boot can proceed.
      const now = Date.UTC(2026, 2, 10)
      const bounds = now // lands in the current month/week
      const orgId = Bun.randomUUIDv7()
      const wsId = Bun.randomUUIDv7()
      await db.sql`
        INSERT INTO invocations
          (org_id, workspace_id, run_id, command, requested_tasks, cache_policy, concurrency, flow,
           started_at, ended_at, total_duration_ms, task_count, failed_count, hit_count,
           hit_local_count, hit_remote_count, exit_ok, commit_sha, branch, dirty, ci, ci_provider,
           host, os, arch, vx_version, tags)
        VALUES (${orgId}, ${wsId}, ${'ri'}, ${'c'}, ${['b']}::jsonb, ${'p'}, ${1}, ${'broad'},
           ${bounds}, ${bounds + 1}, ${1}, ${1}, ${0}, ${0}, ${0}, ${0}, ${true}, ${'s'}, ${'main'},
           ${false}, ${true}, ${'gh'}, ${'h'}, ${'linux'}, ${'x64'}, ${'0'}, ${{}}::jsonb)`
      // Must resolve, never throw.
      await expect(
        maintainPartitions(db, { now, ahead: 2, retentionDays: 180 }),
      ).resolves.toBeDefined()
    } finally {
      await db.close()
    }
  })
})
