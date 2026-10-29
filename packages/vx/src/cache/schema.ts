// The index's tables, one concern: what a cache.db holds. `Cache` opens the
// file, checks `SCHEMA_VERSION` and creates these; every statement against
// them lives in the store that owns the table (file-hashes, output-index,
// history) or in cache.ts for `entries`, `entry_inputs` and
// `artifacts`.

import type { Database, SQLQueryBindings } from 'bun:sqlite'

/**
 * A statement prepared on its first `run` or `get`. A warm run executes few
 * of the index's statements, and preparing every one at the open cost each
 * run ~0.4 ms (2026-10-03).
 */
export function lazyStatement(db: Database, sql: string): ReturnType<Database['prepare']> {
  let statement: ReturnType<Database['prepare']> | undefined
  const prepared = (): ReturnType<Database['prepare']> => (statement ??= db.prepare(sql))
  return {
    run: (...params: SQLQueryBindings[]) => prepared().run(...params),
    get: (...params: SQLQueryBindings[]) => prepared().get(...params),
  } as unknown as ReturnType<Database['prepare']>
}

/**
 * Create every table. `store` names the schema holding the ENTRY tables
 * (`entries`, `entry_stdout`, `output_files`, `entry_inputs`, `store_meta`)
 * the task timings (`task_durations`), the flaky record (`task_outcomes`),
 * the blob sizes (`blob_sizes`), the plugins' blobs (`plugin_blobs`) and
 * the remotes' hits (`remote_hits`):
 * `main` when one `cache.db` holds everything (a `cacheDir`), `store` when
 * they live in the shared store attached beside it (v32). The rest is the
 * workspace's own: its history, its memos, and what its disk looked like
 * after a save or restore. A store table is never named with its schema in
 * a statement; SQLite finds it in `main` or in `store`, whichever has it.
 */
export function createTables(db: Database, store: 'main' | 'store' = 'main'): void {
  db.exec(`
    -- The queryable index: command, exit_code, duration, size and
    -- timestamps; stdout in entry_stdout below.
    CREATE TABLE IF NOT EXISTS ${store}.entries (
      hash         TEXT PRIMARY KEY,
      project      TEXT NOT NULL,
      task         TEXT NOT NULL,
      command      TEXT NOT NULL,
      exit_code    INTEGER NOT NULL,
      duration_ms  INTEGER NOT NULL,
      size_bytes   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      accessed_at  INTEGER NOT NULL,
      -- v26: the producing execution's usage, from the artifact's sidecar.
      cpu_ms         INTEGER,
      peak_rss_bytes INTEGER
    );
    -- v29: an entry's stdout, which the <hash>.tar.zst artifact also
    -- carries so it survives a remote round trip; a local hit replays it
    -- from here. Its own table: an UPDATE rewrites a whole record, and the
    -- accessed_at bump rewrote up to 16 MB a hit. No row: empty stdout.
    CREATE TABLE IF NOT EXISTS ${store}.entry_stdout (
      hash   TEXT PRIMARY KEY,
      stdout TEXT NOT NULL,
      FOREIGN KEY (hash) REFERENCES entries(hash) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS main.runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      -- '' when the outcome derived no cache key (skipped / persistent).
      -- Every reader that must not mistake it for a key guards hash != ''.
      hash                TEXT NOT NULL,
      project             TEXT NOT NULL,
      task                TEXT NOT NULL,
      status              TEXT NOT NULL,
      exit_code           INTEGER NOT NULL,
      duration_ms         INTEGER NOT NULL,
      forward_args        TEXT,
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER NOT NULL,
      -- v11 analytics columns. Nullable until the runner / orchestrator
      -- PRs populate them. Storing them now means we can swap on the
      -- producer side without touching the schema again.
      run_id              TEXT,
      cpu_ms              INTEGER,
      peak_rss_bytes      INTEGER,
      wallclock_start_ns  INTEGER,
      wallclock_end_ns    INTEGER,
      cache_hit           INTEGER,
      -- v23: attempts a retried task took (>1); NULL for a once-run task.
      -- The direct within-run flaky signal.
      attempts            INTEGER,
      -- v25: 1 when the task declared a cache block, 0 when it runs every
      -- time by design; NULL on rows older than the column.
      cached              INTEGER,
      -- v27: why a task failed or was skipped, as the run's own footer
      -- said it (items 267–270): a skip's root blocker (a task id), or
      -- the one a task that ran behind a failure ran behind (X-183), vx's
      -- own timeout (1), the sandbox's violation count, and why a
      -- persistent task never became ready ('timeout' | 'exited' |
      -- 'spawn'). NULL where the reason does not apply.
      blocked_by          TEXT,
      timed_out           INTEGER,
      sandbox_violations  INTEGER,
      not_ready           TEXT,
      -- v31: on a hit, 1 when outputs were restored, 0 when the disk
      -- already matched (up-to-date); NULL on every other status.
      restored            INTEGER,
      -- v40: each remote read or write of the key that failed, as
      -- 'upload: <message>', '; '-joined; NULL when none did.
      remote_error        TEXT,
      -- v43: the most cores one sampling interval burned and the mean
      -- resident memory over the looks; NULL when nothing sampled.
      peak_cores          REAL,
      avg_rss_bytes       INTEGER,
      -- v44: where an executor ran it (ExecuteResult.where) and that
      -- machine's cores and memory; NULL = here.
      placement           TEXT,
      placement_cores     INTEGER,
      placement_memory    INTEGER,
      -- v46: the task with no inputs its key folded (TaskOutcome.keylessBy).
      keyless_by          TEXT,
      -- v48: the task's definition (taskDefinition): a history reader
      -- counts only the rows of the task as it is now.
      def                 TEXT,
      -- v49: the share of a core each runnable thread got where it ran
      -- (ExecuteResult.machine.cpuShare); NULL = all it wanted.
      cpu_share           REAL,
      -- v51: the rest of the results row. How long the task waited ready
      -- for a slot (NULL: it started at once); its output files' bytes,
      -- uncompressed (a hit's restored, a miss's saved; NULL: no entry);
      -- the tasks downstream of it in the run; the flaky record its note
      -- quoted (NULL: not proven flaky).
      queued_ms           INTEGER,
      output_bytes        INTEGER,
      blocks              INTEGER,
      flaky_passes        INTEGER,
      flaky_failures      INTEGER
    );
    -- Two whole-table indexes only, and both APPEND: every row of a run carries the
    -- same run_id and a started_at newer than everything before it, so
    -- 1,000 inserts touch a handful of leaf pages. The dropped ones did
    -- not — the DROPs shed them from existing databases (a schema-meta
    -- bump is for stored shapes, and an index is not one):
    --   runs_hash (2026-09-03) had no reader; 11.5 → 3.9 ms per 1,000.
    --   runs_project (project, task) (2026-09-09) scattered every run's
    --     rows over one leaf per pair: the record stage of a 1,000-hit
    --     warm run was 57–79 ms with it and 14–19 ms without, at 166k
    --     rows, and it bought its readers nothing — the history reader
    --     now scans a rowid slice (history.ts), vx why walks
    --     started_at newest-first and stops at the first match.
    --   runs_ended (2026-09-09) served only the retention DELETE, which
    --     prunes on started_at now (a row ends after it starts, so the
    --     30-day window moves by at most one task's duration).
    --   runs_failed (v38) served the flakiness probe, which reads the
    --     store's task_outcomes now.
    DROP INDEX IF EXISTS main.runs_hash;
    DROP INDEX IF EXISTS main.runs_project;
    DROP INDEX IF EXISTS main.runs_ended;
    DROP INDEX IF EXISTS main.runs_failed;
    CREATE INDEX IF NOT EXISTS main.runs_started_at ON runs(started_at);
    CREATE INDEX IF NOT EXISTS main.runs_run_id     ON runs(run_id);
    -- Per-file (mtime, size, content_hash) cache. Lets Cache.key()
    -- skip the content-hash on inputs whose stat hasn't changed
    -- since the last run. Pure performance optimization; the stored
    -- hash is the exact same one content-hashing would compute now,
    -- so the cache key derivation is unchanged.
    CREATE TABLE IF NOT EXISTS main.file_hashes (
      path         TEXT PRIMARY KEY,
      mtime_ms     INTEGER NOT NULL,
      size_bytes   INTEGER NOT NULL,
      ctime_ms     INTEGER NOT NULL,
      ino          INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      seen_at      INTEGER NOT NULL
    );
    -- v42: each task's last key by its fold up to the files and a token of
    -- the files' git records (fold-memo.ts). A memo: the KEY is unchanged.
    CREATE TABLE IF NOT EXISTS main.fold_memo (
      task_id TEXT PRIMARY KEY,
      probe   TEXT NOT NULL,
      key     TEXT NOT NULL,
      seen_at INTEGER NOT NULL
    );
    -- The size of each index blob the enumeration checked against the
    -- worktree size git recorded (A-60). Fixed for its OID, so a warm
    -- run asks git for none; swept with file_hashes by seen_at, the
    -- time the row was written. v38: in the store, so a worktree reads
    -- what another learned (2026-10-14).
    CREATE TABLE IF NOT EXISTS ${store}.blob_sizes (
      oid     TEXT PRIMARY KEY,
      size    INTEGER NOT NULL,
      seen_at INTEGER NOT NULL
    );
    -- v30: the paths an index distrusts, by a hash of the index file and the
    -- pathspecs (A-60): a warm run reads one row, not one per blob.
    CREATE TABLE IF NOT EXISTS main.blob_verdicts (
      digest  TEXT PRIMARY KEY,
      paths   TEXT NOT NULL,
      seen_at INTEGER NOT NULL
    );
    -- v16: per-output-file fingerprints, scoped by the cache entry
    -- that produced them. Lets loadOutputFilesBatch(hashes) answer
    -- "for entry X, what are its outputs supposed to look like?"
    -- with one SELECT, so the orchestrator can stat-and-skip the
    -- whole restore when the tree's already current.
    --
    -- ON DELETE CASCADE keeps these rows in sync with entries:
    -- a cache prune that drops an entry sweeps its output rows
    -- automatically.
    CREATE TABLE IF NOT EXISTS ${store}.output_files (
      entry_hash  TEXT NOT NULL,
      path        TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      mode        INTEGER NOT NULL,
      mtime_ms    INTEGER NOT NULL,
      PRIMARY KEY (entry_hash, path),
      FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
    );
    -- v28, its own table since v32: the inode and ctime THIS workspace saw
    -- after the save or restore that left the file equal to the entry. No
    -- row: never current. Apart from output_files because the entry is
    -- shared and the disk is not: two worktrees on one store overwrote each
    -- other's stamps, and every switch between them restored. No foreign
    -- key (the entry may live in another database); a prune and a re-save
    -- delete what they orphan.
    CREATE TABLE IF NOT EXISTS main.output_stamps (
      entry_hash  TEXT NOT NULL,
      path        TEXT NOT NULL,
      ino         INTEGER NOT NULL,
      ctime_ms    INTEGER NOT NULL,
      PRIMARY KEY (entry_hash, path)
    );
    -- Every directory under a whole-subtree output glob, with its mtime
    -- as of the last save/restore on THIS machine (2026-09-03). On a warm
    -- hit, unchanged mtimes prove the output SET is unchanged, replacing
    -- the glob walk that cost 0.36 ms per hit. Machine-local: a remote
    -- ingest writes none, and the first hit after it walks and records.
    CREATE TABLE IF NOT EXISTS main.output_dirs (
      entry_hash  TEXT NOT NULL,
      path        TEXT NOT NULL,
      mtime_ms    INTEGER NOT NULL,
      PRIMARY KEY (entry_hash, path)
    );
    -- v22 (Tier 3): one header row per vx-run invocation. The runs
    -- table is per-task; this is the per-invocation record that
    -- carries git/CI/host context, the command, and run-level
    -- counts so the dashboard never reconstructs a header with a
    -- lossy GROUP BY over runs.
    CREATE TABLE IF NOT EXISTS main.invocations (
      run_id            TEXT PRIMARY KEY,
      command           TEXT NOT NULL,
      requested_tasks   TEXT NOT NULL,
      cache_policy      TEXT NOT NULL,
      concurrency       INTEGER NOT NULL,
      flow              TEXT,
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER NOT NULL,
      total_duration_ms INTEGER NOT NULL,
      task_count        INTEGER NOT NULL,
      failed_count      INTEGER NOT NULL,
      hit_count         INTEGER NOT NULL,
      hit_local_count   INTEGER NOT NULL,
      hit_remote_count  INTEGER NOT NULL,
      -- v31: the hits by what they did to the disk; they sum to hit_count.
      up_to_date_count       INTEGER NOT NULL DEFAULT 0,
      restored_local_count   INTEGER NOT NULL DEFAULT 0,
      restored_remote_count  INTEGER NOT NULL DEFAULT 0,
      exit_ok           INTEGER NOT NULL,
      commit_sha        TEXT,
      branch            TEXT,
      dirty             INTEGER,
      ci                INTEGER NOT NULL,
      ci_provider       TEXT,
      host              TEXT,
      os                TEXT,
      arch              TEXT,
      vx_version        TEXT NOT NULL
    );
    -- v50: what a run said that its runs rows do not hold (run-notes.ts),
    -- for \`vx last\`: the steps it did not wait on (\`vx:prefetch\`), its
    -- warnings, colour stripped, and each failed task's output, plain,
    -- bounded and masked, with the files it names (JSON). Rows of the
    -- newest 50 runs that had any; run ids are UUIDv7, so they sort by age.
    CREATE TABLE IF NOT EXISTS main.steps (
      run_id      TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      step        TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      ok          INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS main.warnings (
      run_id TEXT NOT NULL,
      seq    INTEGER NOT NULL,
      text   TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS main.failures (
      run_id      TEXT NOT NULL,
      task_id     TEXT NOT NULL,
      input_moved TEXT,
      output      TEXT NOT NULL,
      locations   TEXT NOT NULL,
      sandbox_fix TEXT,
      PRIMARY KEY (run_id, task_id)
    );
    -- v50: a lockfile claimant's parse (orchestrator/lockfile-claim.ts): one
    -- row per lockfile and claimant, read while \`version\` and \`lock\` (the
    -- file's xxh3) match, replaced when they do not. JSON: the extra files'
    -- hashes, the importers' digests and edges, the names each records.
    CREATE TABLE IF NOT EXISTS main.lockfile_memos (
      file      TEXT NOT NULL,
      claimant  TEXT NOT NULL,
      version   INTEGER NOT NULL,
      lock      TEXT NOT NULL,
      extras    TEXT NOT NULL,
      importers TEXT NOT NULL,
      edges     TEXT NOT NULL,
      recorded  TEXT,
      PRIMARY KEY (file, claimant)
    );
    CREATE INDEX IF NOT EXISTS main.invocations_started ON invocations(started_at);
    CREATE INDEX IF NOT EXISTS main.invocations_branch  ON invocations(branch);
    CREATE INDEX IF NOT EXISTS main.invocations_ci      ON invocations(ci);
    -- v22 (Tier 3): the input-fingerprint moat: each cache ENTRY's key
    -- components (NOT a run's). Written inside the entry-save transaction,
    -- only on a miss/save, so a warm all-cache-hit run writes nothing
    -- here. v34: one row per entry, the components a JSON array of
    -- [kind, name, hash] in (kind, name) code-unit order. A row per
    -- component cost a b-tree insert each, and a task with 50 input
    -- files spent ~0.5 ms a save on them; every reader loads the whole
    -- set by entry hash and diffs it app-side anyway. ON DELETE CASCADE
    -- keeps it in sync with entries (a prune sweeps it automatically).
    CREATE TABLE IF NOT EXISTS ${store}.entry_inputs (
      entry_hash TEXT PRIMARY KEY,
      components TEXT NOT NULL,
      FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
    );
    -- v32: what belongs to the entries rather than to one workspace: the
    -- salt their value digests are taken under, so a digest an entry_inputs
    -- row holds compares with the one another workspace's run takes.
    CREATE TABLE IF NOT EXISTS ${store}.store_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- What a duration forecast reads (orchestrator/history.ts), one row per
    -- executed success, shared by every worktree of the repo so a new one
    -- forecasts on its first run (2026-10-14). Append-only: never
    -- updated, pruned by age with the run history. \`source\` tags a local
    -- run 'branch:<name>' ('branch:' detached or outside git); \`sha\` is its
    -- commit. A forecast reads a task's newest rows of one source.
    CREATE TABLE IF NOT EXISTS ${store}.task_durations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project     TEXT NOT NULL,
      task        TEXT NOT NULL,
      source      TEXT NOT NULL,
      sha         TEXT,
      duration_ms INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      -- v45: a 'remote' row's measured need (TaskResources); NULL on the
      -- rest, whose need the run history holds.
      cpu_parallelism        REAL,
      peak_rss_bytes         INTEGER,
      saturated_cores        INTEGER,
      saturated_memory_bytes INTEGER,
      -- v48: the task's definition (taskDefinition), as on \`runs\`.
      def                    TEXT
    );
    CREATE INDEX IF NOT EXISTS ${store}.task_durations_task
      ON task_durations(project, task, source, id);
    -- v37: a 'remote' row is a default-branch commit's timing a plugin
    -- imported (\`sha\` that commit): one per task, so a repeat import is a
    -- no-op under INSERT OR IGNORE.
    CREATE UNIQUE INDEX IF NOT EXISTS ${store}.task_durations_remote
      ON task_durations(sha, project, task) WHERE source = 'remote';
    -- v38: the flaky record (orchestrator/failure-mode.ts): each keyed,
    -- cached, unblocked outcome that observed its key, shared by every
    -- worktree so a key that passed in one and failed in another is flaky
    -- in both (2026-10-14). Every executed success or failure, and
    -- a key's first hit (run-history.ts): a later hit replays a pass the
    -- record holds, so a warm run on keys that passed writes no row.
    -- Append-only, ordered by id, pruned by age with the run history.
    CREATE TABLE IF NOT EXISTS ${store}.task_outcomes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project     TEXT NOT NULL,
      task        TEXT NOT NULL,
      hash        TEXT NOT NULL,
      status      TEXT NOT NULL,
      attempts    INTEGER,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${store}.task_outcomes_hash ON task_outcomes(hash, status);
    -- v37: what a plugin keeps through \`ctx.cache\` (plugin-cache.ts), by
    -- its namespaced key. Written once, never updated; pruned by age with
    -- the run history.
    CREATE TABLE IF NOT EXISTS ${store}.plugin_blobs (
      key   TEXT PRIMARY KEY,
      bytes BLOB NOT NULL,
      at    INTEGER NOT NULL
    );
    -- What a remote's has-many said it holds (remote-hits.ts), shared by
    -- every worktree: a key here is a hit until a has-many or a GET says it
    -- is gone, and a key not here is a miss. Only hits are kept. Pruned by
    -- \`seen_at\` with the run history.
    CREATE TABLE IF NOT EXISTS ${store}.remote_hits (
      hash        TEXT PRIMARY KEY,
      size        INTEGER,
      duration_ms INTEGER,
      seen_at     INTEGER NOT NULL
    );
    ${artifactTables(store)}
  `)
}

/**
 * v33: an artifact of at most `INLINE_MAX` compressed bytes lives here, its
 * exact `<hash>.tar.zst` bytes, written in the transaction that writes its
 * rows. No foreign key and outside every drop a `SCHEMA_VERSION` reset makes:
 * the artifact is the record and the entries only its inventory, so a reset
 * drops the rows and keeps these, as it keeps the files. `artifacts_meta`
 * holds the table's own layout version (`'layout'`), the one thing that may
 * drop it. `at` is the last use a row-less sweep judges, as a file's mtime.
 * A rowid table, not WITHOUT ROWID: there the blob sits in the key's b-tree,
 * so every probe of a hash reads overflow pages; 10 000 lookups took 312 ms
 * against 8.5 (a2, 2026-10-17).
 */
export function createArtifactTables(db: Database, store: 'main' | 'store'): void {
  db.exec(artifactTables(store))
}

// In the entry tables' exec, so an open runs no statement more for them.
function artifactTables(store: 'main' | 'store'): string {
  return `
    CREATE TABLE IF NOT EXISTS ${store}.artifacts (
      hash  TEXT PRIMARY KEY,
      at    INTEGER NOT NULL,
      bytes BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${store}.artifacts_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`
}

/**
 * A `WHERE <column> …` test against many hashes, as one statement whatever
 * their number. A list of `?` is a new statement per length, compiled each
 * run: 2.0 ms against 1.4 for 900 hashes through `json_each` (2026-10-03).
 * One hash keeps `= ?`, ~3 µs cheaper than parsing a one-element array, on
 * the per-hit path that asks for one at a time.
 */
export function inHashes(hashes: readonly string[]): { test: string; params: string[] } {
  return hashes.length === 1
    ? { test: '= ?', params: [hashes[0]!] }
    : { test: 'IN (SELECT value FROM json_each(?))', params: [JSON.stringify(hashes)] }
}
