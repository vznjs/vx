// Concurrent index convergence (docs/design/concurrent-index-migrations-2026-07.md).
// The transactional migration runner structurally cannot express
// CREATE INDEX CONCURRENTLY (Postgres refuses it inside a transaction block),
// so an index added to an ALREADY-POPULATED hot table lives here instead: a
// declarative registry of desired indexes plus a never-throws convergence pass
// — the `maintainPartitions` sibling. The catalog IS the ledger: every step is
// individually idempotent and catalog-probed, so a crash mid-build leaves a
// state the next boot/tick recovers.
//
// Decision rule: an index shipped in the same migration that CREATEs its table
// stays in the transactional migration (empty table, instant build). An index
// added to a grown table goes in CONCURRENT_INDEXES. A definition is never
// changed in place — a changed definition is a NEW name here plus the old name
// appended to RETIRED_INDEXES.

import type { ReservedSQL } from 'bun'
import type { DbClient } from './client.js'

export interface ConcurrentIndex {
  /** Index name on the (possibly partitioned) parent. */
  name: string
  /** Short suffix (≤ 10 chars) for deterministic per-partition child index
   *  names: `<partition>_<suffix>`. Deterministic names are what make crashed
   *  builds detectable + resumable. */
  suffix: string
  table: string
  /** Everything after `ON <table>`: '(cols…) [WHERE …]'. One canonical string,
   *  used verbatim for the parent shell and every child build. */
  def: string
}

export const CONCURRENT_INDEXES: readonly ConcurrentIndex[] = [
  {
    // getRecentFailures: WHERE workspace_id=$ AND status='failed'
    //   ORDER BY started_at DESC LIMIT n            → pure top-N index walk.
    // getProjectBranchFailures' `failed` CTE: same clamp + project + window
    //   → scans only the workspace's failed slice, filtered by project.
    // getRegressions' failed-row reads ride the same slice.
    name: 'task_runs_failed_ws_started',
    suffix: 'fws',
    table: 'task_runs',
    def: `(workspace_id, started_at DESC) WHERE status = 'failed'`,
  },
  {
    // getNotifications (the 30s-polled bell): WHERE workspace_id=$ AND
    //   failed_count > 0 ORDER BY started_at DESC LIMIT n.
    name: 'invocations_failed_ws_started',
    suffix: 'fws',
    table: 'invocations',
    def: `(workspace_id, started_at DESC) WHERE failed_count > 0`,
  },
]

/** Names to drop wherever found (superseded definitions, mistakes). */
export const RETIRED_INDEXES: readonly string[] = []

/**
 * Session-level advisory-lock key serializing convergence passes across
 * replicas ("vxc\x03"). MUST be distinct from every OTHER advisory key on the
 * database — MIGRATION_LOCK_KEY (…01) AND auth's BOOTSTRAP_LOCK_KEY (…02): a
 * shared key silently cross-couples two unrelated subsystems. It previously
 * collided with BOOTSTRAP (…02), which deadlocked the first `/v1/auth/register`
 * against the boot-time index build — register held its xact while acquiring
 * the key, CIC held the key while waiting on register's xact to complete.
 * Session-level, not transaction-level, because there IS no transaction — CIC
 * forbids one. If the holding connection dies mid-build, Postgres releases the
 * lock with the session; the half-done state is recovered by the next holder.
 */
export const INDEX_LOCK_KEY = 0x76786303

export interface EnsureIndexesResult {
  built: number // child (or plain-table) indexes created
  attached: number // ATTACH PARTITION operations performed
  recovered: number // INVALID leftovers dropped before rebuild
  dropped: number // retired indexes removed
  skipped: boolean // another replica held the lock; nothing probed
}

export interface EnsureIndexesOptions {
  warn?: (m: string) => void
  log?: (m: string) => void
  /** Registry override (tests — mirrors `runMigrations(db, migrations)`). */
  indexes?: readonly ConcurrentIndex[]
  /** Retired-names override (tests). */
  retired?: readonly string[]
}

/**
 * Converge the database onto the registry: create missing indexes with
 * CREATE INDEX CONCURRENTLY (per partition + ATTACH on partitioned parents),
 * drop INVALID leftovers from crashed builds, drop retired names. NEVER throws
 * (the `maintainPartitions` contract): each entry and each partition step is
 * isolated — a failure is warned, the pass moves on, the next tick retries.
 *
 * Connection discipline (load-bearing): the whole pass runs on ONE reserved
 * connection — the session advisory lock must live on a stable connection
 * (Bun.sql is a pool), and each DDL statement is its own single-statement
 * `unsafe` call so CIC never rides an implicit multi-statement transaction.
 */
export async function ensureIndexes(
  db: DbClient,
  opts: EnsureIndexesOptions = {},
): Promise<EnsureIndexesResult> {
  const warn = opts.warn ?? (() => {})
  const log = opts.log ?? (() => {})
  const indexes = opts.indexes ?? CONCURRENT_INDEXES
  const retired = opts.retired ?? RETIRED_INDEXES
  const res: EnsureIndexesResult = {
    built: 0,
    attached: 0,
    recovered: 0,
    dropped: 0,
    skipped: false,
  }

  let sql: ReservedSQL
  try {
    sql = await db.sql.reserve()
  } catch (err) {
    warn(`reserve connection: ${errMsg(err)}`)
    return res
  }
  try {
    let locked: boolean
    try {
      const rows = await sql<{ ok: boolean }[]>`
        SELECT pg_try_advisory_lock(${INDEX_LOCK_KEY}) AS ok`
      locked = rows[0]!.ok
    } catch (err) {
      warn(`advisory lock: ${errMsg(err)}`)
      return res
    }
    if (!locked) {
      // Another replica is mid-pass. Skipping is safe precisely because this
      // is convergence, not a ledgered one-shot — the next tick converges.
      log('index maintenance: another replica holds the lock — skipped')
      res.skipped = true
      return res
    }
    try {
      for (const entry of indexes) {
        try {
          await ensureIndex(sql, entry, res, log, warn)
        } catch (err) {
          warn(`index ${entry.name}: ${errMsg(err)}`)
        }
      }
      for (const name of retired) {
        try {
          res.dropped += await dropRetired(sql, name)
        } catch (err) {
          warn(`retired index ${name}: ${errMsg(err)}`)
        }
      }
    } finally {
      // Best-effort: a dead connection released the lock with its session.
      try {
        await sql`SELECT pg_advisory_unlock(${INDEX_LOCK_KEY})`
      } catch {
        // ignored
      }
    }
  } finally {
    try {
      sql.release()
    } catch {
      // pool already closed (server stopping mid-pass)
    }
  }
  return res
}

/**
 * Converge one registry entry. Partitioned parents (relkind `p`) take the
 * shell → per-partition CIC → ATTACH state machine; plain tables the
 * degenerate direct-CIC path. Per-partition failures are isolated (warned,
 * next partition proceeds).
 */
async function ensureIndex(
  sql: ReservedSQL,
  e: ConcurrentIndex,
  res: EnsureIndexesResult,
  log: (m: string) => void,
  warn: (m: string) => void,
): Promise<void> {
  const kind = await sql<{ relkind: string }[]>`
    SELECT relkind FROM pg_class WHERE relname = ${e.table} AND relkind IN ('p', 'r')`
  if (kind.length === 0) throw new Error(`table ${e.table} not found`)
  if (kind[0]!.relkind === 'r') {
    await ensurePlainIndex(sql, e, res, log)
    return
  }

  // Step P: the parent shell. Instant (touches no child data); IF NOT EXISTS
  // makes it the idempotent anchor. The shell is INVALID until every partition
  // has an attached child index — the planner ignores it, which is exactly the
  // safe intermediate state.
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS "${e.name}" ON ONLY "${e.table}" ${e.def}`)

  // Which partitions already have an attached child index? Probed by
  // ATTACHMENT, not name — a partition created after the shell exists gets an
  // auto-built auto-named child, which this probe correctly treats as done.
  const attachedRows = await sql<{ child_table: string }[]>`
    SELECT xt.relname AS child_table
      FROM pg_inherits i
      JOIN pg_class  xc ON xc.oid = i.inhrelid
      JOIN pg_index  x  ON x.indexrelid = xc.oid
      JOIN pg_class  xt ON xt.oid = x.indrelid
     WHERE i.inhparent = ${e.name}::regclass`
  const attachedSet = new Set(attachedRows.map((r) => r.child_table))
  const partitions = await sql<{ name: string }[]>`
    SELECT c.relname AS name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = ${e.table}
     ORDER BY c.relname`

  const before = res.built + res.attached
  for (const { name: part } of partitions) {
    if (attachedSet.has(part)) continue // S3: attached — nothing to do.
    const child = `${part}_${e.suffix}`
    try {
      const state = await sql<{ valid: boolean }[]>`
        SELECT x.indisvalid AS valid
          FROM pg_class c
          JOIN pg_index x ON x.indexrelid = c.oid
         WHERE c.relname = ${child}`
      if (state.length > 0 && !state[0]!.valid) {
        // S1: a crashed/failed CIC leftover. An INVALID index still incurs
        // write-maintenance overhead, so it must not be left lying. It was
        // never attached (ATTACH requires a valid index) → plain leaf drop.
        try {
          await sql.unsafe(`DROP INDEX CONCURRENTLY "${child}"`)
        } catch {
          await sql.unsafe(`DROP INDEX "${child}"`)
        }
        res.recovered++
      }
      if (state.length === 0 || !state[0]!.valid) {
        // S0: build without blocking writes. One child at a time serializes
        // the I/O impact; the log line makes a multi-minute build visible.
        log(`index ${e.name}: building ${child} on ${part}…`)
        const t0 = Date.now()
        await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${child}" ON "${part}" ${e.def}`)
        res.built++
        log(`index ${e.name}: built ${child} (${Date.now() - t0}ms)`)
      }
      // S2: valid but unattached (crash between build and attach, or just
      // built): attach. A lost race surfaces as an ATTACH error with the child
      // already attached → re-probe and treat as S3.
      try {
        await sql.unsafe(`ALTER INDEX "${e.name}" ATTACH PARTITION "${child}"`)
        res.attached++
      } catch (err) {
        const now = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_inherits
           WHERE inhparent = ${e.name}::regclass AND inhrelid = ${child}::regclass`
        if (now[0]!.n === 0) throw err
      }
    } catch (err) {
      warn(`index ${e.name}: partition ${part}: ${errMsg(err)}`)
    }
  }

  // Terminal: when every partition is attached, Postgres flips the parent
  // shell's indisvalid to true automatically — nothing to issue, just log it
  // when this pass did the work.
  if (res.built + res.attached > before) {
    const parent = await sql<{ valid: boolean }[]>`
      SELECT x.indisvalid AS valid
        FROM pg_class c
        JOIN pg_index x ON x.indexrelid = c.oid
       WHERE c.relname = ${e.name}`
    if (parent[0]?.valid === true) log(`index ${e.name}: valid on ${e.table}`)
  }
}

/** The degenerate non-partitioned path: S1 recovery, then a direct CIC. */
async function ensurePlainIndex(
  sql: ReservedSQL,
  e: ConcurrentIndex,
  res: EnsureIndexesResult,
  log: (m: string) => void,
): Promise<void> {
  const state = await sql<{ valid: boolean }[]>`
    SELECT x.indisvalid AS valid
      FROM pg_class c
      JOIN pg_index x ON x.indexrelid = c.oid
     WHERE c.relname = ${e.name}`
  if (state.length > 0 && state[0]!.valid) return
  if (state.length > 0) {
    try {
      await sql.unsafe(`DROP INDEX CONCURRENTLY "${e.name}"`)
    } catch {
      await sql.unsafe(`DROP INDEX "${e.name}"`)
    }
    res.recovered++
  }
  log(`index ${e.name}: building on ${e.table}…`)
  const t0 = Date.now()
  await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${e.name}" ON "${e.table}" ${e.def}`)
  res.built++
  log(`index ${e.name}: built (${Date.now() - t0}ms)`)
}

/**
 * Drop a retired index wherever found. A partitioned parent (relkind `I`)
 * needs plain DROP INDEX (CONCURRENTLY refuses partitioned indexes) — a brief
 * ACCESS EXCLUSIVE on parent + partitions for a catalog-only operation;
 * retirement is rare, acceptable. Returns 1 when something was dropped.
 */
async function dropRetired(sql: ReservedSQL, name: string): Promise<number> {
  const rows = await sql<{ relkind: string }[]>`
    SELECT relkind FROM pg_class WHERE relname = ${name} AND relkind IN ('i', 'I')`
  if (rows.length === 0) return 0
  if (rows[0]!.relkind === 'I') {
    await sql.unsafe(`DROP INDEX IF EXISTS "${name}"`)
  } else {
    await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`)
  }
  return 1
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
