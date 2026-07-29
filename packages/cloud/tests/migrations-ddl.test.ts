// What the eight migrations actually BUILD, interrogated from the Postgres
// catalog after a real migrate — plus the two small unowned modules that sit
// beside them (`dist/session.ts`, `auth/passwords.ts`).
//
// The neighbouring `db-migrate.test.ts` covers the migration RUNNER: the
// advisory lock, version ordering, the one-transaction property, the ledger.
// It says nothing about the SCHEMA those migrations produce. `db-partitions.ts`
// covers partition MAINTENANCE (create-ahead, drop-past-retention) and takes
// the migration-shipped DEFAULT partition as a given. This file owns the
// remaining half: the shape the analytics path depends on.
//
// Every assertion below reads `information_schema` / `pg_catalog`, never the
// DDL strings. Re-reading the migration source would only prove the source
// says what it says; what matters is what Postgres ended up with — those
// differ whenever a later migration alters an earlier one's work (0007 adds an
// index to 0004's table, 0008 adds a column to it), which is exactly where a
// schema regression hides.
//
// The four failure classes this exists to catch:
//
//   1. A LOST DEFAULT PARTITION. `invocations` / `task_runs` / `task_logs` are
//      RANGE-partitioned; an insert whose timestamp falls outside every
//      created partition is REJECTED unless a DEFAULT catch-all absorbs it.
//      Lose it and a backfill, a skewed clock, or a maintenance tick that has
//      not run yet turns ingest into a 500 and the run's history is gone.
//   2. AN INDEX THAT STOPS LEADING WITH workspace_id. Every analytics read is
//      clamped `WHERE workspace_id = <resolved>`. An index leading with any
//      other column cannot serve that clamp, so the read silently degrades
//      from a top-N walk to a scan of every tenant's rows — correct answers,
//      collapsing latency, and worse the more tenants there are.
//   3. A UNIQUENESS CONSTRAINT THAT CHANGES MEANING. Two of them carry
//      product behaviour rather than hygiene: `invocations (started_at,
//      run_id)` is *why* a re-pushed summary yields TWO header rows for one
//      run — the duplicate-header class behind four separate analytics bugs —
//      and `task_runs (started_at, run_id, project, task)` is the idempotency
//      key that lets incremental per-task ingest and the end-of-run batch
//      converge without doubling every row.
//   4. A FOREIGN KEY THAT SHOULD NOT EXIST. The four analytics tables carry
//      `workspace_id` with NO foreign key, deliberately (see the FK block).
//      Someone "fixing" that omission would add a constraint Postgres must
//      validate across every partition of a 50-100M-row table.
//
// ONE migrated database serves the whole file. The tests that insert rows
// scope every count to their own generated ids, so they cannot see each
// other's writes.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { agentRemoteCache, deriveSession, markAgentProcess } from '../src/dist/session.js'
import { dummyPasswordHash, hashPassword, verifyPassword } from '../src/auth/passwords.js'
import { ensurePartitions } from '../src/db/partitions.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

let db: DbClient

beforeAll(async () => {
  const pg = await ephemeralPg()
  db = openDb(await pg.createDatabase())
})

afterAll(async () => {
  await db.close()
})

// ---------------------------------------------------------------------------
// catalog helpers
// ---------------------------------------------------------------------------

async function columnsOf(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
  const rows = await db.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}`
  return new Map(
    rows.map((r) => [r.column_name, { type: r.data_type, nullable: r.is_nullable === 'YES' }]),
  )
}

interface IndexInfo {
  name: string
  leading: string
  unique: boolean
}

/**
 * Indexes defined ON `table` itself. Partitioned parents also own auto-created
 * per-partition children with generated names; those are excluded by joining
 * on the parent relation, so a growing partition set never changes this shape.
 */
async function indexesOf(table: string): Promise<IndexInfo[]> {
  const rows = await db.sql<{ name: string; leading: string; unique: boolean }[]>`
    SELECT ic.relname AS name, a.attname AS leading, x.indisunique AS unique
      FROM pg_index x
      JOIN pg_class ic ON ic.oid = x.indexrelid
      JOIN pg_class tc ON tc.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace
      JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = x.indkey[0]
     WHERE n.nspname = 'public' AND tc.relname = ${table}
     ORDER BY ic.relname`
  return rows.map((r) => ({ name: r.name, leading: r.leading, unique: r.unique }))
}

/** Child partitions of a partitioned parent, with their bound expression. */
async function partitionsOf(parent: string): Promise<{ name: string; bound: string }[]> {
  const rows = await db.sql<{ name: string; bound: string }[]>`
    SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE n.nspname = 'public' AND p.relname = ${parent}
     ORDER BY c.relname`
  return rows
}

/** Which physical partition an invocation row landed in (`tableoid` names it). */
async function landedIn(runId: string): Promise<string> {
  const rows = await db.sql<{ t: string }[]>`
    SELECT tableoid::regclass::text AS t FROM invocations WHERE run_id = ${runId} LIMIT 1`
  return rows[0]?.t ?? '(no row)'
}

/**
 * Run `fn` and hand back the error it produced.
 *
 * NOT `expect(db.sql\`…\`).rejects` — a Bun.sql template literal is a LAZY
 * SQLQuery, so passing the object itself to `.rejects` never executes it AND
 * wedges the whole test process rather than failing (the trap already
 * documented in db-indexes.test.ts). Awaiting inside a callback executes it
 * normally, and this also copes with a callee that throws synchronously.
 */
async function errorFrom(fn: () => unknown): Promise<Error> {
  try {
    await fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a rejection, but the call succeeded')
}

const ORG = Bun.randomUUIDv7()
const WS = Bun.randomUUIDv7()

/** Insert one invocation header. Mirrors `Analytics.ingest`'s column list. */
async function insertInvocation(runId: string, startedAt: number): Promise<void> {
  await db.sql`
    INSERT INTO invocations (
      run_id, org_id, workspace_id, command, requested_tasks, cache_policy, concurrency,
      started_at, ended_at, total_duration_ms, task_count, failed_count, hit_count,
      hit_local_count, hit_remote_count, exit_ok, ci, vx_version)
    VALUES (
      ${runId}, ${ORG}, ${WS}, 'vx run build', ${{ t: ['build'] }}::jsonb, 'lR,lW', 2,
      ${startedAt}, ${startedAt + 10}, 10, 1, 0, 0, 0, 0, true, false, '0.0.0')`
}

// ---------------------------------------------------------------------------
// tables + columns the write path binds
// ---------------------------------------------------------------------------

// The exact column lists `db/analytics.ts` binds in its four INSERTs. Kept
// here verbatim so a migration that drops or renames a column fails HERE,
// naming the column, instead of at runtime as a Postgres error inside a
// transaction that then discards a whole run's history.
const BOUND_COLUMNS: Record<string, readonly string[]> = {
  invocations: [
    'run_id',
    'org_id',
    'workspace_id',
    'command',
    'requested_tasks',
    'cache_policy',
    'concurrency',
    'flow',
    'started_at',
    'ended_at',
    'total_duration_ms',
    'task_count',
    'failed_count',
    'hit_count',
    'hit_local_count',
    'hit_remote_count',
    'exit_ok',
    'commit_sha',
    'branch',
    'default_branch',
    'dirty',
    'ci',
    'ci_provider',
    'host',
    'os',
    'arch',
    'vx_version',
    'tags',
    'ingested_by_token',
  ],
  task_runs: [
    'org_id',
    'workspace_id',
    'run_id',
    'hash',
    'project',
    'task',
    'status',
    'exit_code',
    'duration_ms',
    'started_at',
    'ended_at',
    'cpu_ms',
    'peak_rss_bytes',
    'wallclock_start_ns',
    'wallclock_end_ns',
    'cache_hit',
    'attempts',
  ],
  task_logs: [
    'org_id',
    'workspace_id',
    'run_id',
    'task_id',
    'hash',
    'status',
    'codec',
    'content',
    'chars_full',
    'truncated_head',
    'created_at',
  ],
  output_fingerprints: [
    'org_id',
    'workspace_id',
    'hash',
    'os',
    'arch',
    'tree',
    'file_count',
    'files',
    'truncated',
    'task_id',
    'run_id',
    'host',
    'created_at',
  ],
}

describe('schema: what the analytics write path binds', () => {
  it('every column the ingest INSERTs bind exists on its table', async () => {
    for (const [table, bound] of Object.entries(BOUND_COLUMNS)) {
      const cols = await columnsOf(table)
      // Compared as a set difference so the failure names the missing columns
      // rather than reporting a length mismatch. Extra columns are fine —
      // migrations are additive by design.
      expect({ table, missing: bound.filter((c) => !cols.has(c)) }).toEqual({ table, missing: [] })
    }
  })

  it('migration 0008 added default_branch as NULLABLE, and it cascaded to the partition', async () => {
    // Nullability is the whole additive contract: a client that cannot detect
    // its default branch (detached checkout, non-repo local run) sends null,
    // and the trunk-scoped duration-hint query falls back to counting all
    // runs. NOT NULL here would 500 every ingest from such a client.
    const parent = await columnsOf('invocations')
    expect(parent.get('default_branch')).toEqual({ type: 'text', nullable: true })
    // ADD COLUMN on a partitioned parent is only useful if it reaches the
    // children — the DEFAULT partition is where an out-of-range row lands, so
    // a column missing there would break exactly the rows hardest to re-create.
    const child = await columnsOf('invocations_default')
    expect(child.get('default_branch')).toEqual({ type: 'text', nullable: true })
  })

  it('the enum types carry exactly the labels the auth + token code writes', async () => {
    // These are CREATE TYPE, not check constraints: writing an unlisted label
    // is a hard Postgres error, so the label set is a wire contract with every
    // route that inserts a role, a token kind, or a trust tier.
    const rows = await db.sql<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       GROUP BY t.typname ORDER BY t.typname`
    expect(Object.fromEntries(rows.map((r) => [r.typname, r.labels]))).toEqual({
      org_role: ['owner', 'admin', 'member', 'viewer'],
      token_kind: ['ci', 'admin'],
      trust_tier: ['trusted', 'untrusted'],
    })
  })
})

// ---------------------------------------------------------------------------
// partitioning
// ---------------------------------------------------------------------------

/** parent → the column its RANGE key is declared on. */
const PARTITIONED: Record<string, string> = {
  invocations: 'started_at',
  task_runs: 'started_at',
  task_logs: 'created_at',
}

describe('partitioning', () => {
  it('the three hot tables are RANGE-partitioned on their timestamp column', async () => {
    // The strategy is load-bearing for retention: `dropOldPartitions` removes
    // whole partitions instead of issuing a DELETE across a table with tens of
    // millions of rows per day. LIST or HASH would make retention a scan.
    const rows = await db.sql<{ parent: string; strat: string; keydef: string }[]>`
      SELECT p.relname AS parent, pt.partstrat AS strat, pg_get_partkeydef(p.oid) AS keydef
        FROM pg_partitioned_table pt JOIN pg_class p ON p.oid = pt.partrelid
        JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = 'public' ORDER BY p.relname`
    expect(Object.fromEntries(rows.map((r) => [r.parent, [r.strat, r.keydef]]))).toEqual(
      Object.fromEntries(Object.entries(PARTITIONED).map(([t, c]) => [t, ['r', `RANGE (${c})`]])),
    )
  })

  it('each partitioned parent ships a DEFAULT catch-all partition', async () => {
    for (const parent of Object.keys(PARTITIONED)) {
      const parts = await partitionsOf(parent)
      const dflt = parts.filter((p) => p.bound === 'DEFAULT')
      expect({ parent, defaults: dflt.map((p) => p.name) }).toEqual({
        parent,
        defaults: [`${parent}_default`],
      })
    }
  })

  it('a row outside every created partition lands in DEFAULT instead of being rejected', async () => {
    // The behavioural half, and the reason the DEFAULT exists at all. Without
    // it this insert raises `no partition of relation ... found for row` — and
    // ingest wraps a whole run in one transaction, so ONE out-of-range task
    // discards the entire run's history. Reachable without anything exotic: a
    // backfill, a machine with a skewed clock, or a maintenance tick that has
    // not created the current period yet.
    const now = Date.now()
    await ensurePartitions(db, { now, ahead: 2 })

    const inRange = `ddl-in-range-${now}`
    await insertInvocation(inRange, now)
    // Control: with real partitions created, a current row must NOT be sitting
    // in DEFAULT — otherwise "landed in default" would prove nothing.
    expect(await landedIn(inRange)).not.toBe('invocations_default')

    const farFuture = Date.UTC(2099, 0, 1)
    const outOfRange = `ddl-out-of-range-${now}`
    await insertInvocation(outOfRange, farFuture)
    expect(await landedIn(outOfRange)).toBe('invocations_default')
  })

  it('output_fingerprints is deliberately NOT partitioned', async () => {
    // One row per (workspace, cache key, os, arch, tree) — a deterministic task
    // costs one row per platform forever, so the table stays small and a
    // partition key would buy nothing while complicating its natural PK.
    const rows = await db.sql<{ relkind: string }[]>`
      SELECT relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'output_fingerprints'`
    expect(rows.map((r) => r.relkind)).toEqual(['r'])
  })
})

// ---------------------------------------------------------------------------
// the tenant axis
// ---------------------------------------------------------------------------

/**
 * Indexes on the analytics tables that legitimately do NOT lead with
 * workspace_id, each with the reason. Everything else must lead with it, so a
 * new index added without one forces a deliberate decision here rather than
 * silently shipping a cross-tenant scan.
 */
const NON_TENANT_INDEXES: Record<string, string> = {
  // Identity of a row, not a tenant read. The partition key must come first in
  // a partitioned PK, and run_id is a globally-unique UUIDv7 — a lookup by it
  // needs no tenant column to be selective.
  invocations_pkey: 'partitioned primary key (started_at, run_id)',
  invocations_run_id: 'run_id-first point lookup for a globally-unique id',
  task_runs_run_project_task: 'incremental-ingest idempotency key (0007)',
}

describe('tenant-axis indexes', () => {
  it('every analytics index leads with workspace_id except the documented identity keys', async () => {
    const offenders: string[] = []
    for (const table of [...Object.keys(PARTITIONED), 'output_fingerprints']) {
      for (const idx of await indexesOf(table)) {
        if (idx.name in NON_TENANT_INDEXES) continue
        if (idx.leading !== 'workspace_id') offenders.push(`${table}.${idx.name} → ${idx.leading}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the exempted identity indexes still exist and still lead with what they claim', async () => {
    // Without this the exemption list above could hide a regression: renaming
    // or dropping an exempted index would simply stop it being checked.
    const inv = new Map((await indexesOf('invocations')).map((i) => [i.name, i]))
    expect(inv.get('invocations_pkey')?.leading).toBe('started_at')
    expect(inv.get('invocations_run_id')?.leading).toBe('run_id')
    const tr = new Map((await indexesOf('task_runs')).map((i) => [i.name, i]))
    expect(tr.get('task_runs_run_project_task')?.leading).toBe('started_at')
  })

  it('the named hot-read indexes exist on the parent', async () => {
    // Named individually because each backs a specific dashboard query; losing
    // one degrades that surface alone, which is easy to miss in aggregate.
    const expected: Record<string, string[]> = {
      invocations: ['invocations_ws_branch_started', 'invocations_ws_started'],
      task_runs: [
        'task_runs_ws_hash',
        'task_runs_ws_proj_task_started',
        'task_runs_ws_run',
        'task_runs_ws_started',
      ],
      task_logs: ['task_logs_ws_hash', 'task_logs_ws_run_task'],
      output_fingerprints: ['output_fingerprints_ws_created'],
    }
    for (const [table, names] of Object.entries(expected)) {
      const have = new Set((await indexesOf(table)).map((i) => i.name))
      expect({ table, missing: names.filter((n) => !have.has(n)) }).toEqual({ table, missing: [] })
    }
  })

  it('the two partial indexes are NOT in the migrations — they are built CONCURRENTLY', async () => {
    // `task_runs_failed_ws_started` / `invocations_failed_ws_started` target
    // already-populated hot tables, and CREATE INDEX CONCURRENTLY cannot run
    // inside the migration runner's single transaction. They live in
    // `db/indexes.ts` and converge after boot. If one ever appears here, the
    // migration would hold an ACCESS EXCLUSIVE lock on a 50-100M-row table for
    // the length of the build on every deploy.
    const names = new Set([
      ...(await indexesOf('task_runs')).map((i) => i.name),
      ...(await indexesOf('invocations')).map((i) => i.name),
    ])
    expect(names.has('task_runs_failed_ws_started')).toBe(false)
    expect(names.has('invocations_failed_ws_started')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// uniqueness that carries product behaviour
// ---------------------------------------------------------------------------

describe('uniqueness constraints, stated as the behaviour they buy', () => {
  it('re-pushing an identical summary is a no-op; a CHANGED startedAt yields TWO headers', async () => {
    // This is the duplicate-header class, and it is a property of the schema
    // rather than a bug in any one query. The key is (started_at, run_id), so
    // ON CONFLICT absorbs a byte-identical re-push — but a client that
    // re-pushes with a different startedAt writes a SECOND header for the same
    // run. Every read that joins invocations by run_id must therefore pick ONE
    // (the earliest-header LATERAL convention); a plain join multiplies rows
    // and skews the aggregate. Four separate analytics bugs came from this.
    const started = Date.now() - 500
    const runId = `ddl-dup-${started}`
    await insertInvocation(runId, started)

    expect((await errorFrom(() => insertInvocation(runId, started))).message).toMatch(
      /duplicate key value/,
    )

    await insertInvocation(runId, started + 1)
    const rows = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM invocations WHERE run_id = ${runId}`
    expect(rows[0]!.c).toBe(2)
  })

  it('task_runs dedups the live incremental row against the end-of-run batch', async () => {
    // Per-task ingest writes a row as each task finishes; the end-of-run batch
    // re-inserts every task as a completeness backstop. Both derive started_at
    // identically, so the same key arrives twice and the second must be
    // absorbed — without the UNIQUE index behind ON CONFLICT, every task of
    // every connected run would be counted twice in every aggregate.
    const started = Date.now() - 400
    const runId = `ddl-idem-${started}`
    const insert = async (): Promise<void> => {
      await db.sql`
        INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status,
                               exit_code, duration_ms, started_at, ended_at)
        VALUES (${ORG}, ${WS}, ${runId}, 'h', 'p', 't', 'success', 0, 5,
                ${started}, ${started + 5})
        ON CONFLICT (started_at, run_id, project, task) DO NOTHING`
    }
    await insert()
    await insert()
    const rows = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM task_runs WHERE run_id = ${runId}`
    expect(rows[0]!.c).toBe(1)

    // The key is (started_at, …), so a row of the SAME task at a different
    // timestamp is a distinct row — which is what makes a retried task
    // representable at all.
    await db.sql`
      INSERT INTO task_runs (org_id, workspace_id, run_id, hash, project, task, status,
                             exit_code, duration_ms, started_at, ended_at)
      VALUES (${ORG}, ${WS}, ${runId}, 'h', 'p', 't', 'success', 0, 5,
              ${started + 1}, ${started + 6})
      ON CONFLICT (started_at, run_id, project, task) DO NOTHING`
    const after = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM task_runs WHERE run_id = ${runId}`
    expect(after[0]!.c).toBe(2)
  })

  it('a workspace slug is unique per org, not globally', async () => {
    // Two organizations must be able to call a workspace "web" — the slug is a
    // user-facing name, and global uniqueness would leak one tenant's naming
    // into another's namespace and make onboarding fail on collision.
    const orgA = Bun.randomUUIDv7()
    const orgB = Bun.randomUUIDv7()
    for (const [id, slug] of [
      [orgA, 'acme-a'],
      [orgB, 'acme-b'],
    ] as const) {
      await db.sql`INSERT INTO organizations (id, slug, name, created_at)
                   VALUES (${id}, ${slug}, ${slug}, ${Date.now()})`
    }
    const mk = (org: string): Promise<unknown> =>
      db.sql`INSERT INTO workspaces (id, org_id, slug, name, created_at)
             VALUES (${Bun.randomUUIDv7()}, ${org}, 'web', 'Web', ${Date.now()})`
    await mk(orgA)
    await mk(orgB)
    expect((await errorFrom(() => mk(orgA))).message).toMatch(/duplicate key value/)
  })

  it('a client workspace id maps to exactly one server workspace per org', async () => {
    // `routeWorkspace` resolves the client's 16-hex workspace id to a server
    // workspace on first push. Two rows for one client id in one org would make
    // that resolution ambiguous — a repo's history would split across two
    // workspaces depending on which row a query happened to read.
    const org = Bun.randomUUIDv7()
    await db.sql`INSERT INTO organizations (id, slug, name, created_at)
                 VALUES (${org}, ${`org-${org.slice(0, 8)}`}, 'O', ${Date.now()})`
    const wsId = Bun.randomUUIDv7()
    await db.sql`INSERT INTO workspaces (id, org_id, slug, name, created_at)
                 VALUES (${wsId}, ${org}, 'w', 'W', ${Date.now()})`
    const mkRepo = (): Promise<unknown> =>
      db.sql`INSERT INTO repos (id, org_id, workspace_id, client_workspace_id,
                                first_seen_at, last_seen_at)
             VALUES (${Bun.randomUUIDv7()}, ${org}, ${wsId}, 'deadbeefdeadbeef',
                     ${Date.now()}, ${Date.now()})`
    await mkRepo()
    expect((await errorFrom(mkRepo)).message).toMatch(/duplicate key value/)
  })
})

// ---------------------------------------------------------------------------
// foreign keys — including the one that is deliberately absent
// ---------------------------------------------------------------------------

describe('foreign keys', () => {
  it('the tenancy + identity graph cascades from an organization', async () => {
    // `confdeltype`: c = CASCADE, n = SET NULL, a = NO ACTION.
    const rows = await db.sql<{ conname: string; tbl: string; ftbl: string; act: string }[]>`
      SELECT con.conname, rel.relname AS tbl, frel.relname AS ftbl, con.confdeltype AS act
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_class frel ON frel.oid = con.confrelid
       WHERE con.contype = 'f' ORDER BY rel.relname, con.conname`
    const map = Object.fromEntries(rows.map((r) => [r.conname, `${r.tbl}->${r.ftbl}:${r.act}`]))

    // Deleting an org must take its whole tenancy subtree with it — anything
    // left behind is invisible in the UI yet still consuming storage.
    expect(map['workspaces_org_id_fkey']).toBe('workspaces->organizations:c')
    expect(map['repos_workspace_id_fkey']).toBe('repos->workspaces:c')
    expect(map['projects_workspace_id_fkey']).toBe('projects->workspaces:c')
    expect(map['project_tasks_project_id_fkey']).toBe('project_tasks->projects:c')
    expect(map['org_memberships_org_id_fkey']).toBe('org_memberships->organizations:c')
    expect(map['teams_org_id_fkey']).toBe('teams->organizations:c')

    // A workspace-scoped token dies with its workspace — a surviving token
    // would keep authenticating against a workspace that no longer exists.
    expect(map['api_tokens_workspace_id_fkey']).toBe('api_tokens->workspaces:c')
    // But the token itself must OUTLIVE the user who minted it: SET NULL, not
    // CASCADE. Cascading would silently revoke a CI token when its author's
    // account is removed, breaking builds for a reason nobody would connect.
    expect(map['api_tokens_created_by_fkey']).toBe('api_tokens->users:n')
    expect(map['invites_created_by_fkey']).toBe('invites->users:n')

    // A session dies with its user — that IS the revocation path.
    expect(map['sessions_user_id_fkey']).toBe('sessions->users:c')
  })

  it('the four analytics tables carry workspace_id with NO foreign key — deliberately', async () => {
    // DO NOT "fix" this. `invocations` / `task_runs` / `task_logs` are
    // RANGE-partitioned and sized for 50-100M rows/day; a foreign key from
    // them to `workspaces` would have to be validated across every partition,
    // and would add a per-row constraint check to the hottest write path in
    // the product. That is why the workspace DELETE route removes these rows
    // EXPLICITLY (auth/routes.ts) instead of relying on a cascade — without
    // those four statements the history would be orphaned under a dead
    // workspace id rather than deleted.
    const rows = await db.sql<{ tbl: string; conname: string }[]>`
      SELECT rel.relname AS tbl, con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE con.contype = 'f'
         AND rel.relname IN ('invocations', 'task_runs', 'task_logs', 'output_fingerprints')`
    expect(rows).toEqual([])
  })

  it('FINDING: invites.used_by has no ON DELETE, so it blocks deleting that user', async () => {
    // FINDING (latent, low) — packages/cloud/src/db/migrations/0003_credentials.ts:42
    //   `used_by uuid REFERENCES users(id)` omits an ON DELETE action, so it
    //   defaults to NO ACTION: deleting a user who ever accepted an invite
    //   raises a foreign-key violation. The SIBLING column on the very same
    //   table — `created_by` — is `ON DELETE SET NULL`, so the asymmetry looks
    //   accidental rather than considered.
    //
    //   NOT reachable today: no route deletes a user (grep for `DELETE FROM
    //   users` returns nothing; removing a member deletes the membership, not
    //   the account). It becomes a real defect the moment an account-deletion
    //   route is added — that route would fail for exactly the users who
    //   onboarded via an invite, i.e. everyone after the first.
    //
    //   This test PINS CURRENT BEHAVIOUR. If the FK is later given ON DELETE
    //   SET NULL, this assertion is what tells you to delete it.
    const u = Bun.randomUUIDv7()
    await db.sql`INSERT INTO users (id, email, display_name, password_hash, created_at)
                 VALUES (${u}, ${`inv-${u.slice(0, 8)}@x.test`}, 'U', 'h', ${Date.now()})`
    await db.sql`INSERT INTO invites (id, token_hash, created_at, expires_at, used_by)
                 VALUES (${Bun.randomUUIDv7()}, ${new Uint8Array(16).fill(3)},
                         ${Date.now()}, ${Date.now() + 1000}, ${u})`
    const err = await errorFrom(() => db.sql`DELETE FROM users WHERE id = ${u}`)
    expect(err.message).toMatch(/violates foreign key constraint "invites_used_by_fkey"/)
  })
})

// ---------------------------------------------------------------------------
// DDL idempotency
// ---------------------------------------------------------------------------

describe('DDL idempotency', () => {
  it('re-running the migration set leaves the catalog byte-identical', async () => {
    // `db-migrate.test.ts` already proves the RUNNER reports 0 applied and the
    // ledger is unchanged. The question here is different and only visible in
    // the catalog: were a migration ever made to run twice (a version renumber,
    // a hand-edited ledger), would it duplicate an index or fail outright? The
    // snapshot covers tables, columns, indexes and constraints at once, so any
    // drift shows up as a diff rather than needing an assertion per object.
    const snapshot = async (): Promise<string> => {
      const rows = await db.sql<{ sig: string }[]>`
        SELECT string_agg(sig, E'\n' ORDER BY sig) AS sig FROM (
          -- relkind/contype are the "char" type: concatenating them without an
          -- explicit ::text cast is an ambiguous-operator error, not a silent
          -- coercion.
          SELECT 'T ' || c.relname || ' ' || c.relkind::text AS sig
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          UNION ALL
          SELECT 'C ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable
            FROM information_schema.columns WHERE table_schema = 'public'
          UNION ALL
          SELECT 'I ' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
          UNION ALL
          SELECT 'K ' || con.conname || ' ' || con.contype::text
            FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = rel.relnamespace WHERE n.nspname = 'public'
        ) s`
      return rows[0]!.sig
    }
    const before = await snapshot()
    expect(await runMigrations(db)).toBe(0)
    expect(await snapshot()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// dist/session.ts
// ---------------------------------------------------------------------------

describe('deriveSession', () => {
  // The session key is half of the agent-registry key {workspaceId, session}.
  // Agents and the submitter must derive the SAME string from the same CI job
  // or they never pair: the submitter waits on a pool it cannot see, and the
  // agents idle until their job times out. Two jobs deriving the same string
  // when they should not is the mirror failure — one build's agents execute
  // another's tasks.

  it('an explicit VX_AGENT_SESSION beats every CI provider', () => {
    expect(
      deriveSession({
        VX_AGENT_SESSION: 'mine',
        GITHUB_RUN_ID: '7',
        CI_PIPELINE_ID: '9',
        BUILDKITE_BUILD_ID: 'b',
      }),
    ).toBe('mine')
  })

  it('providers are consulted GitHub → GitLab → Buildkite', () => {
    // Order is asserted by setting two at once: a CI image that exports more
    // than one provider's variables (a GitLab runner inside a GitHub-managed
    // image, a Buildkite agent with leftover exports) must pick deterministically
    // — and both sides of the pairing must pick the SAME one.
    expect(deriveSession({ GITHUB_RUN_ID: '7', CI_PIPELINE_ID: '9' })).toBe('gh-7-1')
    expect(deriveSession({ CI_PIPELINE_ID: '9', BUILDKITE_BUILD_ID: 'b' })).toBe('gl-9')
    expect(deriveSession({ BUILDKITE_BUILD_ID: 'b' })).toBe('bk-b')
  })

  it('a GitHub re-run gets a session distinct from the attempt it replaces', () => {
    // The attempt is folded in so a re-run cannot collide with the ghost of its
    // own previous attempt — a stale agent registration from attempt 1 would
    // otherwise be handed tasks belonging to attempt 2.
    expect(deriveSession({ GITHUB_RUN_ID: '7' })).toBe('gh-7-1')
    expect(deriveSession({ GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '3' })).toBe('gh-7-3')
  })

  it('falls back to the per-workspace local key when no CI variable is set', () => {
    expect(deriveSession({})).toBe('local')
  })

  it('an EMPTY variable does not count as set', () => {
    // The shell-expansion footgun: `VX_AGENT_SESSION=$UNSET vx-cloud agent`
    // exports the empty string, not nothing. Treating that as a real session id
    // would key the registry on '' and silently break pairing for everyone
    // using the default at the same time.
    expect(deriveSession({ VX_AGENT_SESSION: '' })).toBe('local')
    expect(deriveSession({ VX_AGENT_SESSION: '', GITHUB_RUN_ID: '7' })).toBe('gh-7-1')
    expect(
      deriveSession({
        VX_AGENT_SESSION: '',
        GITHUB_RUN_ID: '',
        CI_PIPELINE_ID: '',
        BUILDKITE_BUILD_ID: '',
      }),
    ).toBe('local')
  })

  it('FINDING: an empty GITHUB_RUN_ATTEMPT is NOT guarded, unlike every sibling', () => {
    // FINDING (latent, low) — packages/cloud/src/dist/session.ts:14
    //   Every other variable in this function is checked `!== undefined &&
    //   !== ''`. GITHUB_RUN_ATTEMPT alone is read with `?? '1'`, and nullish
    //   coalescing does not treat '' as absent — so an empty value yields the
    //   trailing-dash key `gh-7-` instead of `gh-7-1`.
    //
    //   Harmless only while both sides of the pairing see the SAME empty value.
    //   It becomes a pairing failure the moment they differ — e.g. a submitter
    //   running in the GitHub job (attempt exported) and a helper agent started
    //   from a script that clears the environment: one derives `gh-7-1`, the
    //   other `gh-7-`, and they never find each other.
    //
    //   PINS CURRENT BEHAVIOUR. If the guard is added, this becomes 'gh-7-1'.
    expect(deriveSession({ GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '' })).toBe('gh-7-')
  })
})

describe('agentRemoteCache', () => {
  // The remote-cache layer an agent injects into its scoped runs. Asserted
  // through a real request rather than by reading the config object back: what
  // matters to the product is which headers reach the serve, since the serve
  // derives the trust tier from the bearer and the cache partition from the
  // scope header.

  /** Env keys `resolveCacheScope` reads; cleared so a real CI run cannot skew this. */
  const SCOPE_KEYS = ['VX_CACHE_SCOPE', 'GITHUB_REF', 'GITHUB_HEAD_REF', 'CI_MERGE_REQUEST_IID']

  async function capture(
    token: string | undefined,
    env: Record<string, string> = {},
  ): Promise<{ auth: string | null; scope: string | null; path: string; method: string }> {
    const saved = SCOPE_KEYS.map((k) => [k, process.env[k]] as const)
    for (const k of SCOPE_KEYS) delete process.env[k]
    for (const [k, v] of Object.entries(env)) process.env[k] = v
    let seen: { auth: string | null; scope: string | null; path: string; method: string } | null =
      null
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url)
        seen = {
          auth: req.headers.get('authorization'),
          scope: req.headers.get('x-vx-cache-scope'),
          path: u.pathname,
          method: req.method,
        }
        return new Response(null, { status: 404 })
      },
    })
    try {
      // `has` issues a HEAD and maps 404 to "absent" — the cheapest round-trip
      // that still carries the full header set.
      expect(await agentRemoteCache(`http://127.0.0.1:${server.port}`, token).has('abc123')).toBe(
        false,
      )
    } finally {
      // Awaited: the next case binds a fresh listener, and a half-closed
      // server keeps the loop alive past the end of the suite.
      await server.stop(true)
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    return seen!
  }

  it('addresses the serve-hosted artifact wire and sends the bearer', async () => {
    const got = await capture('tok-1')
    expect(got.method).toBe('HEAD')
    expect(got.path).toBe('/v1/cache/abc123')
    expect(got.auth).toBe('Bearer tok-1')
  })

  it('omits the authorization header entirely when there is no token', async () => {
    // An empty `Bearer ` would be a credential the serve must parse and reject;
    // absence is what makes an unauthenticated serve usable at all.
    expect((await capture(undefined)).auth).toBeNull()
  })

  it('carries the per-PR cache scope so an untrusted run cannot write the trusted partition', async () => {
    // The scope comes from the ambient CI context, not the caller — a fork PR
    // that shared the trusted partition is the CVE this partitioning exists to
    // prevent.
    const got = await capture('tok-1', { GITHUB_REF: 'refs/pull/42/merge' })
    expect(got.scope).toBe('pr-42')
  })

  it('sends no scope header outside a PR context', async () => {
    expect((await capture('tok-1')).scope).toBeNull()
  })
})

describe('markAgentProcess', () => {
  it('sets the exact sentinel the telemetry rung compares against', () => {
    // plugin.ts gates on `process.env['VX_CLOUD_AGENT'] === '1'` — an exact
    // string compare, so any other truthy value silently fails to suppress
    // telemetry and every per-assignment 1-task agent run floods the ingest
    // store with junk invocations.
    const saved = process.env['VX_CLOUD_AGENT']
    delete process.env['VX_CLOUD_AGENT']
    try {
      markAgentProcess()
      expect(process.env['VX_CLOUD_AGENT']).toBe('1')
    } finally {
      if (saved === undefined) delete process.env['VX_CLOUD_AGENT']
      else process.env['VX_CLOUD_AGENT'] = saved
    }
  })
})

// ---------------------------------------------------------------------------
// auth/passwords.ts
// ---------------------------------------------------------------------------

describe('password hashing', () => {
  // 28 lines standing between every account and the database. argon2id is
  // memory-hard, so each call here costs real time — the hashes below are
  // reused across assertions rather than recomputed.

  it('is argon2id, and says so in the stored string', async () => {
    // The sharpest assertion in this block: a silent downgrade to bcrypt or
    // SHA-256 still round-trips perfectly and would pass every other test in
    // this file, while making an offline crack of a leaked table orders of
    // magnitude cheaper. The algorithm marker is the only observable.
    const hash = await hashPassword('correct horse battery staple')
    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false)
  })

  it('two hashes of the same password differ — the salt is real', async () => {
    // Identical hashes would mean an unsalted digest: the table becomes
    // rainbow-table-able, and two users sharing a password become visible to
    // anyone who reads it.
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')])
    expect(a).not.toBe(b)
    // Both must still verify — a salt that broke verification would be caught
    // here rather than at the first login after deploy.
    expect(await verifyPassword('same-password', a)).toBe(true)
    expect(await verifyPassword('same-password', b)).toBe(true)
  })

  it('a malformed stored hash reads as "wrong password", never a crash', async () => {
    // Bun.password.verify THROWS on an unparseable hash. Uncaught, that is a
    // 500 on POST /v1/auth/login — an unauthenticated endpoint — for anyone
    // whose row was truncated, hand-edited, or written by an older format.
    const valid = await hashPassword('pw-for-truncation')
    for (const bad of [
      '',
      'not-a-hash',
      valid.slice(0, 20),
      '$argon2id$v=19$m=65536,t=2,p=1$onlysalt',
      '$2b$10$abcdefghijklmnopqrstuv',
    ]) {
      expect(await verifyPassword('pw-for-truncation', bad)).toBe(false)
    }
  })

  it('round-trips unicode and a very long password', async () => {
    // Both are user input at a system boundary. A byte-vs-codepoint bug in
    // either direction locks a real account out permanently, and the failure
    // mode ("wrong password" for the right password) is unreportable.
    const unicode = 'ǮȍʁʁΣ🔑🇵🇱 пароль 密码'
    const uh = await hashPassword(unicode)
    expect(await verifyPassword(unicode, uh)).toBe(true)
    expect(await verifyPassword(unicode.normalize('NFD'), uh)).toBe(false)

    const long = 'x'.repeat(4096)
    const lh = await hashPassword(long)
    expect(await verifyPassword(long, lh)).toBe(true)
    // Truncation would make a prefix verify — the classic bcrypt-72-byte trap.
    expect(await verifyPassword(long.slice(0, 4095), lh)).toBe(false)
  })

  it('dummyPasswordHash is memoized and is a real argon2id hash', async () => {
    // It exists so an unknown email still costs one full argon2 verify, hiding
    // whether an address is registered. Both halves matter: a non-argon2 string
    // would make verify fail INSTANTLY (parse error → caught → false), which
    // re-opens the enumeration oracle it was added to close; and recomputing it
    // per login would pay a hash on top of the verify, making an unknown email
    // measurably SLOWER than a known one — the same leak with the sign flipped.
    const a = await dummyPasswordHash()
    const b = await dummyPasswordHash()
    expect(a).toBe(b)
    expect(a.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword('whatever the attacker typed', a)).toBe(false)
  })

  it('FINDING: hashPassword THROWS on an empty password instead of degrading', async () => {
    // FINDING (latent, low) — packages/cloud/src/auth/passwords.ts:5
    //   `verifyPassword` is defensively wrapped ("a malformed stored hash must
    //   read as wrong password, not a 500") but `hashPassword` is not: Bun
    //   rejects an empty password with `TypeError: password must not be empty`,
    //   which propagates out of the route.
    //
    //   NOT reachable today — both call sites validate `password.length < 8`
    //   BEFORE hashing (auth/routes.ts register + change-password). The guard
    //   therefore lives in the callers, not at the boundary, so a third caller
    //   added later inherits a 500 rather than a 400.
    //
    //   PINS CURRENT BEHAVIOUR. If hashPassword grows its own guard, this
    //   assertion is what tells you to update it.
    expect((await errorFrom(() => hashPassword(''))).message).toMatch(/must not be empty/)
  })
})
