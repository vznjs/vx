# Concurrent index migrations — design

> **Status:** proposal
> **Context:** decision log 2026-07-14 (improvement cycle 5): `getNotifications`
> / `getRecentFailures` "would benefit from partial indexes, BUT the migration
> framework applies all migrations in ONE transaction under an advisory lock …
> it needs `CREATE INDEX CONCURRENTLY` (non-transactional), which the framework
> can't express; wants a CONCURRENTLY-capable migration path first."

## What we're solving

`runMigrations` (`packages/cloud/src/db/migrate.ts`) applies every pending
migration in ONE transaction under `pg_advisory_xact_lock` — deliberately:
concurrent compose/k8s boots serialize, and a partial application never
persists. That design is correct for schema DDL and must not change.

It structurally cannot express `CREATE INDEX CONCURRENTLY` (CIC), which
Postgres refuses inside a transaction block. A plain `CREATE INDEX` on the
50-100M-rows/day `task_runs` table inside the migration transaction would hold
a SHARE lock blocking all ingest writes for the minutes the build takes — on
EVERY deploy that ships an index, platform-wide. So today no index can ever be
added to a grown deployment's hot tables.

Blocked consumers (all real, all deferred in the decision log): partial
indexes over the failed minority — `task_runs WHERE status = 'failed'` for
`getRecentFailures` / `getProjectBranchFailures` / `getRegressions`'
failed-row reads, and `invocations WHERE failed_count > 0` for
`getNotifications` (the bell feed, polled every 30s per open dashboard tab).
All of these currently walk indexes that include the ~95-99% majority-passing
rows; the project+window clamps bound them meanwhile.

Extra constraint from the schema: the three hot tables are RANGE-partitioned
with runtime-created children (`db/partitions.ts`), and **CIC does not work on
partitioned parents** — it must go per-partition with `ATTACH`, or not at all.

## Access pattern

- **Who runs it:** every `vx-cloud server` boot (compose restart, k8s rollout,
  scaled replicas booting simultaneously) + the daily maintenance tick. Same
  cadence and same never-throws posture as `maintainPartitions`.
- **How often it does work:** almost never. Steady state is a catalog probe
  (a handful of `pg_class`/`pg_inherits` reads) and zero DDL. Real builds
  happen once per new index per deployment — but that once can take minutes
  per populated partition, so it must not sit on the boot path or under the
  migration transaction.
- **What it touches:** `task_runs` (weekly partitions, 350-700M rows each at
  the 100M/day target, ~26 live partitions at 180d retention), `invocations`
  (monthly, far smaller), `task_logs` (monthly). Plus the DEFAULT partitions
  (normally ~empty).

## Options considered (briefly)

**A. Numbered "concurrent migrations" recorded in `schema_migrations` (or a
sibling ledger).** Same mental model as today: versioned steps, run once,
divergence-checked. Rejected. The whole point of the ledger is atomic
"DDL happened ⇔ row exists", and outside a transaction that atomicity is
**unclosable**: a crash between the CIC completing and the ledger INSERT (or
vice versa — CIC failing AFTER a ledger row landed) leaves the ledger lying.
Every step therefore has to be independently idempotent and re-verified
against the catalog anyway — at which point the ledger carries zero
information and adds one failure mode (ledger/catalog divergence). Worse, a
one-shot numbered step can't cover partitioned parents: the partition set
changes at runtime (`ensurePartitions` creates, `dropOldPartitions` drops), so
"done" is not a fixed point a version row can capture.

**B. Session-level advisory lock around the EXISTING runner, migrations
allowed to opt out of the transaction.** Rejected: it breaks the runner's one
hard guarantee (a partial application never persists) for every migration in
the batch, to serve the one statement type that needs it. Mixing "maybe
transactional" into the forward-only runner is exactly the kind of
subtle-mode machinery the repo avoids.

**C. Transactional-only forever; partitioned indexes ship only while a
deployment is young/small.** Rejected: "young" is undetectable and dishonest —
the framework can't know row counts at migration-authoring time, a deployment
that grew past the threshold can then NEVER receive the index without an
outage, and the first real consumer is `task_runs`, the largest table we have.
This option is a policy of never shipping the indexes the decision log already
wants.

**D. A declarative convergence pass — `ensureIndexes()`, the
`maintainPartitions` pattern.** **Chosen.** Desired state lives in code (a
registry of index definitions); a never-throws pass probes the catalog and
converges: create what's missing (CIC per partition + ATTACH), drop INVALID
leftovers from crashed builds, drop retired names. The catalog IS the ledger.
Runs in the background after the server binds, and again on the daily tick.

## Recommendation

Add a **second, post-transactional phase** to boot: after `runMigrations`
commits and the server binds, a background `ensureIndexes(db)` convergence
pass (new `packages/cloud/src/db/indexes.ts`) builds every index in a
declarative `CONCURRENT_INDEXES` registry using `CREATE INDEX CONCURRENTLY`,
per-partition with `ATTACH PARTITION` on partitioned parents. No rows in
`schema_migrations`; no separate ledger — every step is individually
idempotent, catalog-probed, and resumable, so the desired-state registry plus
`pg_class`/`pg_index`/`pg_inherits` is the complete bookkeeping. Serialization
across replicas via a session-level `pg_try_advisory_lock` on a pinned
connection (skip the pass when another replica holds it — convergence makes
skipping safe). The transactional runner is untouched.

**Decision rule going forward** (the split between the two phases):

- An index shipped in the same migration that CREATEs its table → stays in the
  transactional migration (the table is empty; the index is instant). This is
  every index we have today (0004, 0007).
- An index added to an ALREADY-POPULATED hot table → the concurrent registry,
  never a transactional migration.
- An index definition is **never changed in place**: a changed definition is a
  NEW name in the registry + the old name appended to `RETIRED_INDEXES`. This
  mirrors forward-only migrations; the pass deliberately does NOT diff
  `pg_get_indexdef` output (fragile string comparison) — the invariant is
  enforced by review, the same trust level as migration SQL itself.

## Concrete spec

### Registry + entry shape (`db/indexes.ts`)

```ts
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
  /* §first consumer */
]

/** Names to drop wherever found (superseded definitions, mistakes). */
export const RETIRED_INDEXES: readonly string[] = []

export interface EnsureIndexesResult {
  built: number // child (or plain-table) indexes created
  attached: number // ATTACH PARTITION operations performed
  recovered: number // INVALID leftovers dropped before rebuild
  dropped: number // retired indexes removed
  skipped: boolean // another replica held the lock; nothing probed
}

export async function ensureIndexes(
  db: DbClient,
  opts: { warn?: (m: string) => void; log?: (m: string) => void } = {},
): Promise<EnsureIndexesResult>
```

Never throws (the `maintainPartitions` contract): each entry and each
partition step is isolated — a failure is `warn`ed, the pass moves on, and the
next tick retries. `log` receives progress lines (`index
task_runs_failed_ws_started: building on task_runs_p1750000000000…` + a
per-child duration) so a multi-minute build is visible in the boot log; deeper
ops observability is Postgres' own `pg_stat_progress_create_index`, no code.

**Connection discipline (load-bearing):** the pass runs on ONE pinned
connection — `await db.sql.reserve()` (Bun.sql's reserved-connection API);
released in `finally`. Two reasons: (1) the session advisory lock below must
live on a stable connection, and Bun.sql is a pool — serial awaited queries
give no same-connection guarantee; (2) each DDL statement is issued as its own
single-statement `unsafe` call — never multiple statements per call, which can
ride an implicit transaction and make CIC throw `CREATE INDEX CONCURRENTLY
cannot run inside a transaction block`.

### The state machine (partitioned parent)

For each registry entry on a partitioned table (relkind `p`):

```sql
-- Step P: parent shell. Instant (touches no child data); IF NOT EXISTS makes
-- it the idempotent anchor. The shell is INVALID (indisvalid = false) until
-- every partition has an attached child index — the planner ignores it, which
-- is exactly the safe intermediate state.
CREATE INDEX IF NOT EXISTS <name> ON ONLY <table> <def>;

-- Probe: which partitions already have an attached child index?
SELECT xt.relname AS child_table
  FROM pg_inherits i                             -- children OF THE INDEX
  JOIN pg_class  xc ON xc.oid = i.inhrelid       -- the child index
  JOIN pg_index  x  ON x.indexrelid = xc.oid
  JOIN pg_class  xt ON xt.oid = x.indrelid       -- the partition it indexes
 WHERE i.inhparent = '<name>'::regclass;

-- For each partition p of <table> (from pg_inherits on the TABLE) not in that
-- set, with childName = '<p>_<suffix>':

--   State S1 — childName exists with indisvalid = false (a crashed/failed
--   CIC; note an INVALID index still incurs write-maintenance overhead, so it
--   must not be left lying): drop it, then fall through to S0.
DROP INDEX CONCURRENTLY <childName>;   -- plain leaf index (an INVALID index
                                       -- was never attached — ATTACH requires
                                       -- a valid index); plain DROP fallback
                                       -- on error.

--   State S0 — childName absent: build it without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS <childName> ON <p> <def>;

--   State S2 — childName exists, valid, not attached (crash between build and
--   attach, or just built): attach. Idempotent by the probe above; a lost
--   race surfaces as "is already a child of" → caught, treated as S3.
ALTER INDEX <name> ATTACH PARTITION <childName>;

--   State S3 — attached: nothing to do.

-- Terminal: when every partition is attached, Postgres flips the parent
-- shell's indisvalid to true AUTOMATICALLY. No statement needed; the pass
-- just logs it.
```

**Why convergence is sufficient for a moving partition set:** a partition
created LATER by `ensurePartitions` (`CREATE TABLE … PARTITION OF`)
automatically receives all of the parent's indexes, built at creation — and
the table is empty at creation, so the build is instant and non-blocking in
practice. Only partitions that were **already populated when the index was
first declared** ever need the CIC path. `dropOldPartitions` drops a
partition's child indexes with it — zero bookkeeping. The
`createPartitionMovingDefault` recovery (detach DEFAULT → reattach) also
composes: the DEFAULT keeps its child index across detach, and `ATTACH
PARTITION` re-matches an existing equivalent index automatically (and would
build one inline if missing — DEFAULT is ~empty, instant).

**Ordering caveat, named:** if the parent shell exists while
`ensurePartitions` creates a new partition, that partition's copy is built
inline (fine — empty). If the pass crashes mid-way, the shell stays INVALID
until the next boot/tick converges; harmless (planner ignores it), bounded by
the daily tick.

Plain (non-partitioned) tables take the degenerate path: S1 → S0 with `CREATE
INDEX CONCURRENTLY IF NOT EXISTS <name> ON <table> <def>` directly; no shell,
no attach. No current consumer, but the branch is ~10 lines and shares the
INVALID-recovery probe.

`RETIRED_INDEXES`: leaf indexes drop with `DROP INDEX CONCURRENTLY IF EXISTS`;
a partitioned parent needs plain `DROP INDEX IF EXISTS` (CONCURRENTLY refuses
partitioned indexes) — a brief ACCESS EXCLUSIVE on parent + partitions for a
catalog-only operation; retirement is rare, acceptable, named.

### Locking / concurrent replicas

- A **new session-level lock key** `INDEX_LOCK_KEY = 0x76786302` (sibling of
  `MIGRATION_LOCK_KEY = 0x76786301`). Taken with `pg_try_advisory_lock` on the
  reserved connection; released with `pg_advisory_unlock` in `finally`. If the
  connection dies mid-build, Postgres releases the lock with the session —
  no wedge; the half-done state is S1/S2, which the next holder recovers.
- **Try-lock, not blocking:** when replica B boots while replica A is mid-CIC,
  B must not stall its (background) pass for minutes — it skips
  (`skipped: true`, one log line) and converges on its own daily tick or next
  boot. Skipping is safe precisely because the pass is convergence, not a
  ledgered one-shot.
- **If the lock is somehow not held** (bugs, operator psql): every step
  degrades idempotently. Two same-name CICs race → the loser errors on the
  duplicate catalog entry (or `IF NOT EXISTS` sees the winner's in-progress
  row and skips) → warn + next tick. The lock exists to avoid wasted duplicate
  builds and CIC-vs-CIC snapshot waits, not for correctness.
- Why not `pg_advisory_xact_lock`: there is no transaction — CIC forbids one.
  That is the entire reason this design exists.

### Boot sequence (`cli/server.ts`)

```
reach pg → runMigrations (transactional, UNCHANGED) → S3 probe
  → maintainPartitions (best-effort, unchanged) → bind + serve
  → void ensureIndexes(db, { log, warn })          ← NEW: background, unawaited
daily tick: maintainPartitions → ensureIndexes     ← NEW: appended to the tick
stop(): clearInterval (unchanged); an in-flight pass holds only its reserved
        connection — db.close() ends it; leftover state is S1/S2, recovered.
```

Serving before the index exists costs nothing: the planner simply keeps
today's plan (the exact state every deployment is in right now); the
project+window clamps keep those queries bounded meanwhile, per the decision
log. The honest costs of the background build, named: CIC performs two table
scans per child and holds a snapshot across each (delays vacuum cleanup for
its duration; the app's transactions are short so CIC itself is never blocked
long), and it takes brief ShareUpdateExclusive locks (never blocks
reads/writes — only conflicting DDL and autovacuum on that partition).
Building strictly ONE child at a time serializes the I/O impact.

### First consumer — the failed-minority partial indexes

```ts
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
```

Both are non-unique, so the partition key need not be in the key columns
(only UNIQUE partitioned indexes require it — 0007's lesson); `started_at` is
there for the ORDER BY, not partitioning.

**Selectivity, quantified (the load-bearing assumption):** cache hits are by
definition successes and dominate warm CI, so failed rows are a small minority
of `task_runs` — healthy deployments run ~1-5% failed, pathological ones
~10%. At the 100M-rows/day target: a weekly partition holds ~700M rows, of
which ~14M (2%) enter the partial index — the index is **20-50× smaller** than
a full `(workspace_id, started_at)` equivalent, and a failed-rows query reads
none of the passing majority. Write cost on the hot ingest path: the 95-99%
passing inserts pay one predicate evaluation and **zero index maintenance**
(partial predicate excludes them); only failed-row inserts write an entry.
`invocations` is smaller by 3-4 orders of magnitude (one row per run); its
index exists for the poll frequency, not size. If a deployment's failure rate
were somehow majority (predicate non-selective), the index degrades to
"a full index" — never wrong results, just wasted bytes.

Deliberately ONE `task_runs` index, not a per-query family:
`getProjectBranchFailures` would ideally want `(workspace_id, project,
started_at)` — but on the failed slice the extra column buys little (the slice
is already 20-50× reduced; project filters within it), and `(workspace_id,
project, …)` cannot serve `getRecentFailures`' cross-project `ORDER BY
started_at DESC` without a sort. One index, two consumers, honest about the
second being "slice + filter" rather than perfect.

No `analytics.ts` changes: the planner adopts partial indexes automatically
when the WHERE clause implies the predicate (`status = 'failed'`,
`failed_count > 0` — both literal in the queries today).

## Testing (ephemeral-pg; state machine, not timing)

Real Postgres, real partitioned tables, real CIC — tables are tiny, so every
build is instant: the tests pin the **state machine**, never build duration.
The ephemeral template stays migrations-only (analytics results don't depend
on these indexes — plans only); index suites call `ensureIndexes` explicitly.

1. **Fresh convergence:** template clone (+ `ensurePartitions` for real
   children) → `ensureIndexes` → parent shells exist with `indisvalid = true`,
   every partition (incl. `_default`) has an attached `_fws` child. Re-run →
   all-zero result (pure probe, no DDL).
2. **New-partition inheritance:** `ensureIndexes` → then `ensurePartitions`
   with a later `now` → the new partition carries the child index with NO
   further `ensureIndexes` call (pins the automatic-cascade assumption the
   whole convergence claim rests on).
3. **INVALID recovery (real failed CIC, injected deterministically):** seed a
   partition with duplicate `(workspace_id, started_at)` rows, run `CREATE
UNIQUE INDEX CONCURRENTLY <partition>_fws …` raw → fails, leaving a REAL
   `indisvalid = false` index with the deterministic name. `ensureIndexes` →
   `recovered ≥ 1`, the leftover is dropped, the correct non-unique index is
   built + attached, parent flips valid. (This is the crash-mid-build boot:
   the "next boot recovers" pin.)
4. **Valid-but-unattached recovery:** hand-create a matching child index
   without attaching (the crash-between-build-and-attach window) →
   `ensureIndexes` attaches it (`attached ≥ 1`, `built` for that child = 0).
5. **Replica race:** hold `pg_try_advisory_lock(INDEX_LOCK_KEY)` on a second
   connection → `ensureIndexes` returns `skipped: true` having issued no DDL;
   release → next call converges.
6. **Retirement:** a name in `RETIRED_INDEXES` present on a leaf is dropped;
   absent is a no-op.
7. **Never-throws:** point an entry at a nonexistent table → `warn` fires,
   the result returns, the OTHER entry still converges (per-entry isolation).
8. **Server wiring (one e2e):** `startServer` boots + binds with a cold DB;
   poll the catalog until both parent indexes report valid — proving the pass
   runs post-bind and boot never waited on it.

## What's out of scope

- **A generic online-DDL framework.** No concurrent column changes, no
  `NOT VALID` constraint + `VALIDATE` staging, no `REINDEX CONCURRENTLY`
  scheduling, no backfill runner. Indexes are the only DDL class we need
  online; everything else stays in the transactional runner until a concrete
  consumer exists.
- **pg_repack / bloat management, autovacuum tuning.** Operator territory.
- **Changing `runMigrations`.** Zero edits; the transactional guarantees are
  the foundation this leans on, not a casualty.
- **A progress/ledger table.** `pg_stat_progress_create_index` +the boot log
  cover observability; the catalog covers state.
- **Definition drift detection** (diffing `pg_get_indexdef`). Prevented by
  the new-name-plus-retire rule, not machinery.
- **Rewriting analytics queries to hint the indexes.** The planner picks
  partial indexes up on its own.

## Open questions

- Should `task_logs` get a failed-adjacent index? No known query needs one —
  add to the registry when one does (the mechanism makes that a two-line
  change).
- `Bun.sql.reserve()` availability is assumed (Bun ≥ 1.3 per the repo floor);
  if a floor change ever breaks it, the fallback is a dedicated
  single-connection `openDb` for the pass — same semantics, one more socket.

## Phased build list (one commit each)

1. **Phase 1 — the pass:** `db/indexes.ts` (registry types,
   `CONCURRENT_INDEXES` with both partial indexes, `RETIRED_INDEXES`,
   `ensureIndexes` with the full partitioned state machine, INVALID recovery,
   try-lock on a reserved connection, per-step isolation) + the state-machine
   test suite (tests 1-7 above) on ephemeral-pg. Nothing calls it yet — pure
   addition, independently reviewable.
2. **Phase 2 — the wiring:** `cli/server.ts` background call post-bind +
   appended to the daily tick, progress/skip log lines, the server e2e
   (test 8). One file + one test.
3. **Phase 3 (only if measurement demands):** additional registry entries
   (e.g. a project-leading `task_runs` failed index if
   `getProjectBranchFailures` p95 at real scale says so) — each is a
   two-line registry diff riding the proven mechanism, plus an EXPLAIN-shaped
   pin if the query it serves is contested.

## Why this is the right move (4 bullets)

- **It preserves the transactional runner's one guarantee** (partial
  application never persists) by never asking it to hold statements that
  can't be transactional — the two phases have opposite invariants, so they
  belong in two mechanisms.
- **Idempotent convergence is forced, not chosen:** CIC's failure mode
  (INVALID leftovers) and the no-transaction constraint make every step
  re-verifiable-against-the-catalog anyway; a ledger would just be a second
  copy of the truth that can lie.
- **It's the proven house pattern:** `maintainPartitions` already runs
  best-effort, never-throws, deterministic-names, boot+tick DDL against these
  exact tables — this is its sibling, not a new concept.
- **The first consumer pays for it immediately:** two 20-50×-smaller partial
  indexes serve four decision-log-named queries at the 50-100M-rows/day
  target with zero write cost on the passing majority and zero query changes.
