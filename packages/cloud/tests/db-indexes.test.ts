// Concurrent index convergence (docs/design/concurrent-index-migrations-2026-07.md):
// the state machine on REAL Postgres — real partitioned tables, real
// CREATE INDEX CONCURRENTLY (tables are tiny, so every build is instant; the
// tests pin the STATE MACHINE, never build duration). The ephemeral template
// stays migrations-only, so every suite calls ensureIndexes explicitly.

import { describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import {
  CONCURRENT_INDEXES,
  ensureIndexes,
  INDEX_LOCK_KEY,
  type ConcurrentIndex,
} from '../src/db/indexes.js'
import { MIGRATION_LOCK_KEY } from '../src/db/migrate.js'
import { BOOTSTRAP_LOCK_KEY } from '../src/auth/routes.js'
import { ensurePartitions } from '../src/db/partitions.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 5, 15) // mid-June 2026

const TASK_RUNS_ENTRY = CONCURRENT_INDEXES.find((e) => e.table === 'task_runs')!
const INVOCATIONS_ENTRY = CONCURRENT_INDEXES.find((e) => e.table === 'invocations')!

async function freshDb(): Promise<{ db: DbClient; url: string }> {
  const pg = await ephemeralPg()
  const url = await pg.createDatabase()
  return { db: openDb(url), url }
}

/** indisvalid of the index named `name`, or null when it doesn't exist. */
async function indexValid(db: DbClient, name: string): Promise<boolean | null> {
  const rows = await db.sql<{ valid: boolean }[]>`
    SELECT x.indisvalid AS valid
      FROM pg_class c
      JOIN pg_index x ON x.indexrelid = c.oid
     WHERE c.relname = ${name}`
  return rows.length === 0 ? null : rows[0]!.valid
}

/** Partition tables that have a child index attached under `indexName`. */
async function attachedPartitions(db: DbClient, indexName: string): Promise<string[]> {
  const rows = await db.sql<{ part: string }[]>`
    SELECT xt.relname AS part
      FROM pg_inherits i
      JOIN pg_class xc ON xc.oid = i.inhrelid
      JOIN pg_index x  ON x.indexrelid = xc.oid
      JOIN pg_class xt ON xt.oid = x.indrelid
     WHERE i.inhparent = ${indexName}::regclass
     ORDER BY xt.relname`
  return rows.map((r) => r.part)
}

/** Child partitions of a partitioned TABLE. */
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

async function insertTaskRun(db: DbClient, runId: string, wsId: string, at: number): Promise<void> {
  await db.sql`
    INSERT INTO task_runs
      (org_id, workspace_id, run_id, hash, project, task, status, exit_code, duration_ms, started_at, ended_at)
    VALUES (${Bun.randomUUIDv7()}, ${wsId}, ${runId}, ${'h'}, ${'p'}, ${'build'}, ${'success'}, ${0}, ${10}, ${at}, ${at + 10})`
}

describe('advisory-lock key namespace', () => {
  it('every advisory key is distinct — a collision cross-couples subsystems and deadlocks', () => {
    // INDEX_LOCK_KEY once equaled BOOTSTRAP_LOCK_KEY (both 0x76786302), which
    // deadlocked the first `/v1/auth/register` against the boot-time index
    // build: register held its xact while acquiring the shared key; the index
    // build's CREATE INDEX CONCURRENTLY held the key while waiting on register's
    // xact to finish. Any future collision must fail here, not intermittently in
    // CI.
    const keys = [MIGRATION_LOCK_KEY, BOOTSTRAP_LOCK_KEY, INDEX_LOCK_KEY]
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('ensureIndexes: fresh convergence', () => {
  it('creates parent shells + per-partition children, attaches all, parent flips valid; re-run is a pure probe', async () => {
    const { db } = await freshDb()
    try {
      await ensurePartitions(db, { now: NOW, ahead: 2 })
      const first = await ensureIndexes(db)
      // 4 task_runs partitions (default + 3 weekly) + 4 invocations (default +
      // 3 monthly), one child built + attached on each.
      expect(first).toEqual({ built: 8, attached: 8, recovered: 0, dropped: 0, skipped: false })
      for (const e of CONCURRENT_INDEXES) {
        expect(await indexValid(db, e.name)).toBe(true)
        expect(await attachedPartitions(db, e.name)).toEqual(await childPartitions(db, e.table))
      }
      // The DEFAULT partition is covered with the deterministic child name.
      expect(await indexValid(db, 'task_runs_default_fws')).toBe(true)
      // Idempotent second pass: catalog probe only, zero DDL.
      const again = await ensureIndexes(db)
      expect(again).toEqual({ built: 0, attached: 0, recovered: 0, dropped: 0, skipped: false })
    } finally {
      await db.close()
    }
  })
})

describe('ensureIndexes: new-partition inheritance', () => {
  it('a partition created AFTER the pass carries the index with no further call (the convergence claim)', async () => {
    const { db } = await freshDb()
    try {
      await ensurePartitions(db, { now: NOW, ahead: 0 })
      await ensureIndexes(db)
      const before = new Set(await childPartitions(db, 'task_runs'))
      // A later maintenance tick creates the next weekly partition — Postgres
      // builds + attaches its copy of every parent index inline (empty table,
      // instant), with NO ensureIndexes call in between.
      await ensurePartitions(db, { now: NOW + WEEK_MS, ahead: 0 })
      const created = (await childPartitions(db, 'task_runs')).filter((p) => !before.has(p))
      expect(created).toHaveLength(1)
      expect(await attachedPartitions(db, 'task_runs_failed_ws_started')).toContain(created[0]!)
      expect(await indexValid(db, 'task_runs_failed_ws_started')).toBe(true)
      // The auto-built (auto-named) child counts as attached: still zero DDL.
      const after = await ensureIndexes(db)
      expect(after).toEqual({ built: 0, attached: 0, recovered: 0, dropped: 0, skipped: false })
    } finally {
      await db.close()
    }
  })
})

describe('ensureIndexes: INVALID recovery (real failed CIC)', () => {
  // A throwaway entry so the injected failure never touches the production
  // definitions: a UNIQUE build over seeded duplicate rows makes CONCURRENTLY
  // genuinely fail, leaving a REAL indisvalid=false index with the
  // deterministic child name — the crash-mid-build state.
  const THROWAWAY: ConcurrentIndex = {
    name: 'task_runs_ws_run_throwaway',
    suffix: 'thr',
    table: 'task_runs',
    def: '(workspace_id, run_id)',
  }

  it('drops the leftover, rebuilds, attaches — the next boot recovers', async () => {
    const { db } = await freshDb()
    try {
      await ensurePartitions(db, { now: NOW, ahead: 0 })
      const wsId = Bun.randomUUIDv7()
      await insertTaskRun(db, 'dup', wsId, NOW)
      await insertTaskRun(db, 'dup', wsId, NOW + 1)
      const loc = await db.sql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM task_runs LIMIT 1`
      const part = loc[0]!.part
      expect(part.startsWith('task_runs_p')).toBe(true)
      const child = `${part}_thr`
      // Bun.sql's SQLQuery is a LAZY thenable — handing it to expect().rejects
      // never executes it (and wedges the suite); run it via its own then.
      const failure = await db.sql
        .unsafe(`CREATE UNIQUE INDEX CONCURRENTLY "${child}" ON "${part}" (workspace_id, run_id)`)
        .then(
          () => null,
          (err: unknown) => err,
        )
      expect(String(failure)).toContain('could not create unique index')
      expect(await indexValid(db, child)).toBe(false)

      const res = await ensureIndexes(db, { indexes: [THROWAWAY] })
      expect(res.recovered).toBe(1)
      expect(res.built).toBe(2) // the recovered partition + the DEFAULT
      expect(res.attached).toBe(2)
      // The rebuilt child is the registry's NON-unique definition, valid + attached.
      const rebuilt = await db.sql<{ valid: boolean; uniq: boolean }[]>`
        SELECT x.indisvalid AS valid, x.indisunique AS uniq
          FROM pg_class c
          JOIN pg_index x ON x.indexrelid = c.oid
         WHERE c.relname = ${child}`
      expect(rebuilt[0]).toEqual({ valid: true, uniq: false })
      expect(await indexValid(db, THROWAWAY.name)).toBe(true)
    } finally {
      await db.close()
    }
  })
})

describe('ensureIndexes: valid-but-unattached recovery', () => {
  it('attaches a hand-built matching child (the crash-between-build-and-attach window)', async () => {
    const { db } = await freshDb()
    try {
      await ensurePartitions(db, { now: NOW, ahead: 2 })
      const parts = await childPartitions(db, 'task_runs')
      expect(parts).toHaveLength(4)
      const part = parts.find((p) => p !== 'task_runs_default')!
      await db.sql.unsafe(`CREATE INDEX "${part}_fws" ON "${part}" ${TASK_RUNS_ENTRY.def}`)
      const res = await ensureIndexes(db, { indexes: [TASK_RUNS_ENTRY] })
      // The pre-built child is attached without a rebuild: built covers only
      // the OTHER three partitions, attach covers all four.
      expect(res.built).toBe(3)
      expect(res.attached).toBe(4)
      expect(res.recovered).toBe(0)
      expect(await indexValid(db, TASK_RUNS_ENTRY.name)).toBe(true)
      expect(await attachedPartitions(db, TASK_RUNS_ENTRY.name)).toEqual(parts)
    } finally {
      await db.close()
    }
  })
})

describe('ensureIndexes: replica race (session try-lock)', () => {
  it('skips without DDL while another connection holds the lock; converges once released', async () => {
    const { db, url } = await freshDb()
    const holder = openDb(url)
    try {
      await ensurePartitions(db, { now: NOW, ahead: 0 })
      // Hold the session lock on a pinned second connection (replica A mid-CIC).
      const held = await holder.sql.reserve()
      try {
        const got = await held<{ ok: boolean }[]>`
          SELECT pg_try_advisory_lock(${INDEX_LOCK_KEY}) AS ok`
        expect(got[0]!.ok).toBe(true)
        const res = await ensureIndexes(db)
        expect(res).toEqual({ built: 0, attached: 0, recovered: 0, dropped: 0, skipped: true })
        // Nothing was probed or created — not even the parent shell.
        expect(await indexValid(db, 'task_runs_failed_ws_started')).toBeNull()
        await held`SELECT pg_advisory_unlock(${INDEX_LOCK_KEY})`
      } finally {
        held.release()
      }
      const after = await ensureIndexes(db)
      expect(after.skipped).toBe(false)
      expect(after.built).toBeGreaterThan(0)
      expect(await indexValid(db, 'task_runs_failed_ws_started')).toBe(true)
    } finally {
      await holder.close()
      await db.close()
    }
  })
})

describe('ensureIndexes: RETIRED_INDEXES', () => {
  it('drops a retired leaf where present; absent is a no-op', async () => {
    const { db } = await freshDb()
    try {
      await db.sql.unsafe(`CREATE INDEX retired_leaf_idx ON users (created_at)`)
      const res = await ensureIndexes(db, { indexes: [], retired: ['retired_leaf_idx'] })
      expect(res.dropped).toBe(1)
      expect(await indexValid(db, 'retired_leaf_idx')).toBeNull()
      const again = await ensureIndexes(db, { indexes: [], retired: ['retired_leaf_idx'] })
      expect(again.dropped).toBe(0)
    } finally {
      await db.close()
    }
  })

  it('drops a retired partitioned parent (plain DROP — CONCURRENTLY refuses those) with its children', async () => {
    const { db } = await freshDb()
    try {
      await ensurePartitions(db, { now: NOW, ahead: 0 })
      const entry: ConcurrentIndex = {
        name: 'task_runs_superseded',
        suffix: 'sup',
        table: 'task_runs',
        def: '(workspace_id, hash)',
      }
      await ensureIndexes(db, { indexes: [entry] })
      expect(await indexValid(db, entry.name)).toBe(true)
      const res = await ensureIndexes(db, { indexes: [], retired: [entry.name] })
      expect(res.dropped).toBe(1)
      expect(await indexValid(db, entry.name)).toBeNull()
      expect(await indexValid(db, 'task_runs_default_sup')).toBeNull() // cascade
    } finally {
      await db.close()
    }
  })
})

describe('ensureIndexes: never-throws / per-entry isolation', () => {
  it('a nonexistent table warns and the OTHER entry still converges', async () => {
    const { db } = await freshDb()
    try {
      await ensurePartitions(db, { now: NOW, ahead: 0 })
      const warnings: string[] = []
      const res = await ensureIndexes(db, {
        indexes: [
          { name: 'ghost_idx', suffix: 'gho', table: 'no_such_table', def: '(x)' },
          INVOCATIONS_ENTRY,
        ],
        warn: (m) => warnings.push(m),
      })
      expect(warnings.some((m) => m.includes('ghost_idx') && m.includes('no_such_table'))).toBe(
        true,
      )
      expect(res.built).toBe(2) // invocations: default + current month
      expect(await indexValid(db, INVOCATIONS_ENTRY.name)).toBe(true)
    } finally {
      await db.close()
    }
  })

  it('lock key is a stable 32-bit constant, distinct from every sibling advisory key', () => {
    expect(INDEX_LOCK_KEY).toBe(0x76786303)
    expect(Number.isInteger(INDEX_LOCK_KEY)).toBe(true)
    // Distinctness from BOTH siblings — the earlier ...02 collided with
    // BOOTSTRAP; checking only the migration key is what let it through.
    expect(INDEX_LOCK_KEY).not.toBe(MIGRATION_LOCK_KEY)
    expect(INDEX_LOCK_KEY).not.toBe(BOOTSTRAP_LOCK_KEY)
  })
})
