// Partition maintenance (docs/design/cloud-platform-2026-07.md §5.4). The two
// hot tables are RANGE-partitioned on their timestamp column; this creates the
// upcoming partitions ahead of time (so inserts never fall into the DEFAULT
// catch-all in normal operation) and drops partitions entirely past retention.
// Called at boot and on a daily tick. Hand-rolled — no pg_partman dep.
//
// Boundaries are epoch-ms (matching every wire timestamp): weekly partitions
// align to the Unix epoch (floor(t / WEEK)); monthly partitions align to UTC
// calendar months. Partition names encode their lower bound (`<parent>_p<lo>`)
// so creation is deterministic + idempotent (CREATE TABLE IF NOT EXISTS). The
// DEFAULT partition (created in the migration) catches anything outside the
// created range, so ingest never drops a row.

import type { DbClient } from './client.js'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

type Cadence = 'week' | 'month'

interface PartitionedTable {
  parent: string
  cadence: Cadence
  /** The RANGE-partition key column (epoch-ms bigint). */
  column: string
}

/** The RANGE-partitioned analytics tables and their cadence. */
export const PARTITIONED_TABLES: readonly PartitionedTable[] = [
  { parent: 'invocations', cadence: 'month', column: 'started_at' },
  { parent: 'task_runs', cadence: 'week', column: 'started_at' },
  { parent: 'task_logs', cadence: 'month', column: 'created_at' },
]

/** [lo, hi) epoch-ms bounds of the period CONTAINING `t`. */
function periodBounds(cadence: Cadence, t: number): { lo: number; hi: number } {
  if (cadence === 'week') {
    const lo = Math.floor(t / WEEK_MS) * WEEK_MS
    return { lo, hi: lo + WEEK_MS }
  }
  const d = new Date(t)
  const lo = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const hi = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return { lo, hi }
}

/** The [lo, hi) bounds of the period IMMEDIATELY AFTER one starting at `lo`. */
function nextPeriod(cadence: Cadence, lo: number): { lo: number; hi: number } {
  if (cadence === 'week') return { lo: lo + WEEK_MS, hi: lo + 2 * WEEK_MS }
  return periodBounds('month', lo + 40 * DAY_MS) // land squarely in the next month
}

export interface EnsureOptions {
  now?: number
  /** Future periods to create beyond the current one (design: 2 ahead). */
  ahead?: number
  /** Sink for a per-partition failure that was isolated + skipped. */
  warn?: (message: string) => void
}

/**
 * Create the current + `ahead` future partitions for every partitioned table.
 * Idempotent (a partition that exists is skipped). Returns how many were newly
 * created. Per-table and per-partition failures are ISOLATED (logged, skipped)
 * so one poisoned table/period can never cascade and abort the whole tick — a
 * partition create can genuinely fail if DEFAULT already holds an in-range row
 * (a backfill, a future-dated push past the ahead buffer, or a lagging tick),
 * and `createPartition` recovers that case; anything still failing degrades to
 * "rows stay in DEFAULT" (queryable), never a thrown maintenance run.
 */
export async function ensurePartitions(db: DbClient, opts: EnsureOptions = {}): Promise<number> {
  const now = opts.now ?? Date.now()
  const ahead = opts.ahead ?? 2
  const warn = opts.warn ?? (() => {})
  let created = 0
  for (const table of PARTITIONED_TABLES) {
    let bounds = periodBounds(table.cadence, now)
    for (let i = 0; i <= ahead; i++) {
      try {
        if (await createPartition(db, table, bounds.lo, bounds.hi)) created++
      } catch (err) {
        warn(`partition ${table.parent}_p${bounds.lo}: ${errMsg(err)}`)
      }
      bounds = nextPeriod(table.cadence, bounds.lo)
    }
  }
  return created
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * `CREATE TABLE IF NOT EXISTS <parent>_p<lo> PARTITION OF <parent> …`. Returns
 * whether a new partition was created. Values are server-computed integers +
 * a fixed parent name, so inlining them in the DDL string is safe (no user
 * input reaches here). On the DEFAULT-collision case (Postgres refuses to
 * attach a range partition when the DEFAULT partition already holds a row in
 * that range), recover by detaching DEFAULT, creating the partition, moving
 * the matching rows out of DEFAULT into it, and reattaching — so the row lands
 * in its own partition instead of wedging maintenance forever.
 */
async function createPartition(
  db: DbClient,
  table: PartitionedTable,
  lo: number,
  hi: number,
): Promise<boolean> {
  const name = `${table.parent}_p${lo}`
  if (await partitionExists(db, name)) return false
  try {
    await db.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${table.parent}" FOR VALUES FROM (${lo}) TO (${hi})`,
    )
    return true
  } catch {
    return await createPartitionMovingDefault(db, table, name, lo, hi)
  }
}

/**
 * The DEFAULT-collision recovery: in ONE transaction, detach DEFAULT, create
 * the new partition, relocate the in-range rows out of the (now standalone)
 * default table into the parent (which routes them to the new partition), and
 * reattach DEFAULT. Brief ACCESS EXCLUSIVE on the parent — a rare maintenance
 * path, acceptable. If this ALSO fails, the rows stay in DEFAULT (still
 * queryable) and we return false rather than propagate.
 */
async function createPartitionMovingDefault(
  db: DbClient,
  table: PartitionedTable,
  name: string,
  lo: number,
  hi: number,
): Promise<boolean> {
  const { parent, column } = table
  const def = `${parent}_default`
  await db.sql.begin(async (tx) => {
    await tx.unsafe(`ALTER TABLE "${parent}" DETACH PARTITION "${def}"`)
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${parent}" FOR VALUES FROM (${lo}) TO (${hi})`,
    )
    await tx.unsafe(
      `INSERT INTO "${parent}" SELECT * FROM "${def}" WHERE "${column}" >= ${lo} AND "${column}" < ${hi}`,
    )
    await tx.unsafe(`DELETE FROM "${def}" WHERE "${column}" >= ${lo} AND "${column}" < ${hi}`)
    await tx.unsafe(`ALTER TABLE "${parent}" ATTACH PARTITION "${def}" DEFAULT`)
  })
  return true
}

async function partitionExists(db: DbClient, name: string): Promise<boolean> {
  const rows = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_class WHERE relname = ${name} AND relkind = 'r'`
  return rows[0]!.n > 0
}

export interface DropOptions {
  now?: number
  retentionDays: number
  warn?: (message: string) => void
}

/**
 * Drop partitions whose entire range is older than the retention horizon
 * (`now - retentionDays`). Never drops a DEFAULT partition. Returns how many
 * were dropped. The upper bound is read from the partition's own range bound
 * expression, so a hand-created partition with a nonstandard range is handled.
 */
export async function dropOldPartitions(db: DbClient, opts: DropOptions): Promise<number> {
  const now = opts.now ?? Date.now()
  const horizon = now - opts.retentionDays * DAY_MS
  const warn = opts.warn ?? (() => {})
  let dropped = 0
  for (const { parent } of PARTITIONED_TABLES) {
    try {
      const rows = await db.sql<{ name: string; bound: string }[]>`
        SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = ${parent}`
      for (const r of rows) {
        const hi = upperBoundOf(r.bound)
        if (hi === null || hi > horizon) continue
        await db.sql.unsafe(`DROP TABLE IF EXISTS "${r.name}"`)
        dropped++
      }
    } catch (err) {
      warn(`drop-old ${parent}: ${errMsg(err)}`)
    }
  }
  return dropped
}

/**
 * Extract the exclusive upper bound (epoch-ms) from a range partition's bound
 * expression, e.g. `FOR VALUES FROM ('100') TO ('200')` → 200. Returns null
 * for a DEFAULT partition (`bound === 'DEFAULT'`) — never a drop candidate.
 */
function upperBoundOf(bound: string): number | null {
  const m = /TO \('?(-?\d+)'?\)/.exec(bound)
  return m === null ? null : Number(m[1])
}

/**
 * Boot + daily tick: create ahead, drop past retention. NEVER throws —
 * maintenance is best-effort by construction (each table/partition failure is
 * isolated + logged), so the caller (incl. the boot path) can always proceed.
 * A poisoned partition means rows live in DEFAULT (queryable), never a downed
 * or unbootable server.
 */
export async function maintainPartitions(
  db: DbClient,
  opts: { now?: number; ahead?: number; retentionDays: number; warn?: (m: string) => void },
): Promise<{ created: number; dropped: number }> {
  const warn = opts.warn ?? (() => {})
  const ensureOpts: EnsureOptions = { warn }
  if (opts.now !== undefined) ensureOpts.now = opts.now
  if (opts.ahead !== undefined) ensureOpts.ahead = opts.ahead
  let created = 0
  try {
    created = await ensurePartitions(db, ensureOpts)
  } catch (err) {
    warn(`ensurePartitions: ${errMsg(err)}`)
  }
  const dropOpts: DropOptions = { retentionDays: opts.retentionDays, warn }
  if (opts.now !== undefined) dropOpts.now = opts.now
  let dropped = 0
  try {
    dropped = await dropOldPartitions(db, dropOpts)
  } catch (err) {
    warn(`dropOldPartitions: ${errMsg(err)}`)
  }
  return { created, dropped }
}
