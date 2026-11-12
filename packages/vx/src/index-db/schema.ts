// The index's tables, one concern: what a cache.db holds. `Cache` opens the
// file, checks `SCHEMA_VERSION` and creates these; every statement against
// them lives in the store that owns the table (file-hashes, output-index,
// history) or in cache.ts for `entries`, `entry_inputs` and
// `artifacts`.

import type { Database, SQLQueryBindings } from 'bun:sqlite'

/** SQLite's file-control opcode (sqlite3.h). */
export const SQLITE_FCNTL_PERSIST_WAL = 10

/** SQLite's answer for a file that is not a readable database: corrupt, or not one at all. */
export function unreadableIndex(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
}

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
 * What every reader and `vx last --sql` means by `runs`: the rows with
 * their run_id, in the columns' old order. TEMP, so no other vx meets it: a
 * persistent view would fail an older vx's `DROP TABLE runs` when it resets
 * the index. It shadows main.runs, which only the writers name, so a
 * VACUUM drops it first: rebuilding `runs_run ON runs(run)` resolves `runs`
 * to the view and fails ("views may not be indexed").
 */
export const RUNS_VIEW = `CREATE TEMP VIEW IF NOT EXISTS runs AS
  SELECT r.id, r.hash, r.project, r.task, r.status, r.exit_code, r.duration_ms,
    r.forward_args, r.started_at, r.ended_at, k.run_id, r.cpu_ms, r.peak_rss_bytes,
    r.wallclock_start_ns, r.wallclock_end_ns, r.cache_hit, r.attempts, r.cached,
    r.blocked_by, r.timed_out, r.sandbox_violations, r.not_ready, r.restored,
    r.remote_error, r.peak_cores, r.avg_rss_bytes, r.placement, r.placement_cores,
    r.placement_memory, r.keyless_by, r.def, r.cpu_share, r.queued_ms,
    r.output_bytes, r.blocks, r.flaky_passes, r.flaky_failures
  FROM main.runs r LEFT JOIN main.run_ids k ON k.id = r.run;`

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
      peak_rss_bytes INTEGER,
      -- v54: the run whose save or download wrote the entry as it stands
      -- (created_at is when): \`vx last --log\` shows a run's log from the
      -- entry only when it holds that run's output.
      run_id         TEXT
    );
    -- v29: an entry's stdout, which the <hash>.tar.zst artifact also
    -- carries so it survives a remote round trip; a local hit replays it
    -- from here. Its own table: an UPDATE rewrites a whole record, and the
    -- accessed_at bump rewrote up to 16 MB a hit. No row: empty stdout.
    -- v52: a zstd frame of the UTF-8 (storedLog); as text, logs were most
    -- of a store's bytes.
    CREATE TABLE IF NOT EXISTS ${store}.entry_stdout (
      hash   TEXT PRIMARY KEY,
      stdout BLOB NOT NULL,
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
      -- v53: the run's row in run_ids, not its 36-char id: the text
      -- and its index were a third of what an all-hit run added. The
      -- \`runs\` view below shows it as run_id again.
      run                 INTEGER,
      cpu_ms              INTEGER,
      peak_rss_bytes      INTEGER,
      wallclock_start_ns  INTEGER,
      wallclock_end_ns    INTEGER,
      cache_hit           INTEGER,
      -- v23: attempts a retried task took (>1); NULL for a once-run task.
      -- The direct within-run flaky signal.
      attempts            INTEGER,
      -- v25: 1 when the task declared cache: true, 0 when it runs every
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
    -- same run and a started_at newer than everything before it, so
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
    CREATE INDEX IF NOT EXISTS main.runs_run        ON runs(run);
    -- v53: each run's id once; a runs row names it by this rowid.
    CREATE TABLE IF NOT EXISTS main.run_ids (
      id     INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE
    );
    ${RUNS_VIEW}
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
    -- after the save or restore that left the file equal to the entry, and
    -- since v55 its mtime: a restore dates a file it writes now, not with
    -- the entry's saved mtime, so the row's is not the file's. No
    -- row: never current. Apart from output_files because the entry is
    -- shared and the disk is not: two worktrees on one store overwrote each
    -- other's stamps, and every switch between them restored. No foreign
    -- key (the entry may live in another database); a prune and a re-save
    -- delete what they orphan. root (v56): a hash of the workspace root's real
    -- path in a named cache dir, which clones may share and so overwrote
    -- each other's stamps the same way; 0 in a workspace's own index.
    CREATE TABLE IF NOT EXISTS main.output_stamps (
      entry_hash  TEXT NOT NULL,
      root        INTEGER NOT NULL,
      path        TEXT NOT NULL,
      ino         INTEGER NOT NULL,
      ctime_ms    INTEGER NOT NULL,
      mtime_ms    INTEGER NOT NULL,
      PRIMARY KEY (entry_hash, root, path)
    );
    -- Every directory under a whole-subtree output glob, with its mtime
    -- as of the last save/restore on THIS machine (2026-09-03). On a warm
    -- hit, unchanged mtimes prove the output SET is unchanged, replacing
    -- the glob walk that cost 0.36 ms per hit. Machine-local: a remote
    -- ingest writes none, and the first hit after it walks and records.
    -- Per workspace root, as output_stamps.
    CREATE TABLE IF NOT EXISTS main.output_dirs (
      entry_hash  TEXT NOT NULL,
      root        INTEGER NOT NULL,
      path        TEXT NOT NULL,
      mtime_ms    INTEGER NOT NULL,
      PRIMARY KEY (entry_hash, root, path)
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

/**
 * Retention: the runs table grows by one row per task per invocation,
 * hits included — a 2000-task repo accretes ~20k rows in days. 30 days
 * covers `vx info` (24 h windows) and CI-side consumers. The
 * `invocations` header is pruned on the SAME window, or a header would
 * outlive its rows and `vx last` would list a run whose detail is gone.
 * Plugin blobs and remote hits share the window. Returns the rows dropped.
 */
export function pruneHistoryRows(db: Database, cutoff: number): number {
  let dropped = db.prepare('DELETE FROM main.runs WHERE started_at < ?').run(cutoff).changes
  // A run's id goes with its last row; ids only grow, so the oldest kept row bounds them.
  dropped += db
    .prepare(
      'DELETE FROM run_ids WHERE id < COALESCE((SELECT MIN(run) FROM main.runs), (SELECT MAX(id) + 1 FROM run_ids))',
    )
    .run().changes
  dropped += db.prepare('DELETE FROM invocations WHERE started_at < ?').run(cutoff).changes
  dropped += db.prepare('DELETE FROM task_durations WHERE recorded_at < ?').run(cutoff).changes
  dropped += db.prepare('DELETE FROM task_outcomes WHERE recorded_at < ?').run(cutoff).changes
  dropped += db.prepare('DELETE FROM plugin_blobs WHERE at < ?').run(cutoff).changes
  dropped += db.prepare('DELETE FROM remote_hits WHERE seen_at < ?').run(cutoff).changes
  return dropped
}

// SCHEMA history (drop+recreate on mismatch; pre-alpha, no migrations):
//   v20: file_hashes.content_hash (git blob OIDs).
//   v21: dropped the unused outputs_hash column (pure-input hashing).
//   v22: Tier-3 dashboard tables — `invocations` (one header row per
//        `vx run` with git/CI/host context + tags) and `entry_inputs`
//        (one row per cache-key component, keyed by the cache-entry
//        HASH, the input-fingerprint moat). `entry_inputs` is written
//        INSIDE the entry-save transaction (only on a miss/save), so a
//        warm all-cache-hit run writes nothing to it — the warm path
//        does zero extra work. `invocations` is still recorded once per
//        run via `recordRunBundle`. The cache KEY is unchanged
//        (CACHE_VERSION not bumped) — these tables persist analytics
//        derived from the same `CacheKeyInput` the key already consumes.
//   v23: runs.attempts — the number of attempts a retried task took (>1),
//        the DIRECT within-run flaky signal (a task that failed then
//        passed under identical inputs is nondeterministic by definition;
//        no cross-run inference needed). Nullable; NULL for a once-run
//        task. Analytics-only — the cache KEY is unchanged.
//   v24: file_hashes.ctime_ms + .ino — the stat memo's guard against a
//        content change that PRESERVES mtime (`tar -x`, `cp -p`,
//        `rsync --times`, SOURCE_DATE_EPOCH). (mtime, size) alone
//        returned the previous run's digest for different bytes, i.e. a
//        stale cache hit. `utimes` cannot suppress ctime unprivileged
//        and an atomic write-then-rename changes the inode, so the two
//        together close it; git's index keys on ctime+ino+dev for the
//        same reason. Both come free from the stat already taken. The
//        cache KEY derivation is unchanged (CACHE_VERSION not bumped) —
//        the memo simply stops answering wrongly, so an affected task's
//        key moves from a WRONG value to the right one: it misses once,
//        re-runs, re-caches. Self-healing, never a wrong hit.
//   v25: runs.cached — whether the task declared `cache: true`. An
//        uncached task's row looked like any executed miss, so `vx why`
//        headlined "cache key changed (inputs differ)" for a task that
//        runs every time by design, and `vx last` could not mark it the
//        way the terminal summary does (`no-cache`). Analytics-only —
//        the cache KEY is unchanged.
//   v26: entries.cpu_ms / peak_rss_bytes — what the producing execution
//        used, read out of the artifact's sidecar at save and ingest
//        alike, so a hit (a remote one on a fresh runner above all) can
//        tell the history what the task needs. The cache KEY and the
//        artifact container are unchanged (no CACHE_VERSION bump: an
//        artifact without the field reads as before).
//   v28: output_files.ino + .ctime_ms — the skip-restore check's guard
//        against another entry's bytes. Two entries whose outputs carry
//        one fixed mtime (`tar -x`, `cp -p`, SOURCE_DATE_EPOCH) and one
//        size matched each other's (size, mode, mtime) rows, so a hit left
//        the last entry's bytes on disk under a green run (item 886). A row
//        is current only with the inode and ctime recorded after the save
//        or restore that wrote it. The cache KEY is unchanged.
//   v29: entries.stdout moved to entry_stdout. SQLite rewrites a whole
//        record on UPDATE, so the run-end `accessed_at` bump rewrote each
//        hit's stored stdout (up to 16 MB) with its overflow pages: 200
//        hits of 1 MB cost the close 125-150 ms. The cache KEY is
//        unchanged.
//   v30: blob_verdicts — the blob-size check's verdict by a hash of the
//        index file (A-60), so a warm run reads one row. The cache KEY is
//        unchanged.
//   v31: runs.restored and invocations' up_to_date / restored_local /
//        restored_remote counts — a hit that restored outputs apart from
//        one that found them in place, for every reader after the run.
//        The cache KEY is unchanged.
//   v32: the entry tables (entries, entry_stdout, output_files,
//        entry_inputs) may live in a shared store attached as `store`;
//        output_files' ino + ctime_ms moved to the workspace's own
//        output_stamps, output_dirs lost its foreign key, and the value
//        salt moved to store_meta. The cache KEY is unchanged.
//   v33: an artifact of at most 32 KiB compressed lives in the
//        store's `artifacts` table, written in its rows' transaction, and
//        every entry read joins it. The artifact bytes and the cache KEY are
//        unchanged (CACHE_VERSION not bumped).
//   v34: entry_inputs holds one row per entry, its key components as one
//        JSON array, not a row per component. The cache KEY is unchanged.
//   v35: config_evals and config_closures are gone: runs read configs from
//        the lock, and `vx lock` evaluates every one. The cache KEY is
//        unchanged.
//   v36: the store's task_durations: each executed success's time, tagged
//        by branch, read by the forecast. The cache KEY is unchanged.
//   v37: the store's plugin_blobs (a plugin's `ctx.cache`) and one
//        'remote' task_durations row per (sha, task). The cache KEY is
//        unchanged.
//   v38: blob_sizes moved to the store, and the store's task_outcomes
//        holds the flaky record, so worktrees share both. The cache KEY is
//        unchanged.
//   v39: invocations drops `tags` (`--tag` is gone). The cache KEY is
//        unchanged.
//   v40: runs.remote_error — each remote read or write of a task's key that
//        failed, for `vx last`. The cache KEY is unchanged.
//   v41: the artifacts table is a rowid table (layout a2). The cache KEY
//        is unchanged.
//   v42: fold_memo — each task's last key by its fold up to the files and
//        a token of their git records. The cache KEY is unchanged.
//   v43: runs.peak_cores / avg_rss_bytes — what a sampled run burned at
//        its peak and held on average. The cache KEY is unchanged.
//   v44: runs.placement — where an executor ran the task. The cache KEY
//        is unchanged.
//   v45: a 'remote' task_durations row also carries the task's measured
//        cores, memory and saturation, for a run with no local history.
//        The cache KEY is unchanged.
//   v46: runs.keyless_by — the task with no inputs a key folded, so
//        `vx why` names it. The cache KEY is unchanged.
//   v47: the store's remote_hits — what a remote's hasMany said it holds,
//        hits only, so another process trusts it. The cache KEY is
//        unchanged.
//   v48: runs.def and task_durations.def — the task's definition
//        (taskDefinition), so a task whose command changed under the same
//        name reads none of the old one's timings. The cache KEY is
//        unchanged.
//   v49: runs.cpu_share — the share of a core each runnable thread got
//        where the task ran, so a crowded run's CPU reads as need. The
//        cache KEY is unchanged.
//   v50: steps, warnings, failures and lockfile_memos — what a run said
//        and a lockfile claimant parsed, files under the cache dir until
//        now (if it can be in the DB, it is). The cache KEY is unchanged.
//   v51: runs.queued_ms, output_bytes, blocks, flaky_passes and
//        flaky_failures — the rest of what a results row shows, so `vx
//        last --sql` reads it. The cache KEY is unchanged.
//   v52: entry_stdout.stdout is a zstd frame of the log's UTF-8, not its
//        text: stored logs were half a store's bytes, more than every
//        inline artifact. The cache KEY is unchanged.
//   v53: a runs row names its run by its row in run_ids, not by the
//        36-char text; a TEMP view `runs` shows run_id as before. An
//        all-hit run of 500 tasks added 115 KB to the index. The cache
//        KEY is unchanged.
//   v54: entries.run_id — the run that wrote the entry, so `vx last
//        --log` tells a run's own output from another run's under the same
//        key. The cache KEY is unchanged.
//   v55: output_stamps.mtime_ms — the mtime the file carried when
//        stamped. A restore dates each file it writes now, as the task's
//        write would, not with the entry's saved mtime: a make-style
//        dependant took a restored upstream as older than its own output
//        and saved bytes built from another upstream. The cache KEY and
//        the stored artifact are unchanged.
//   v56: output_stamps and output_dirs carry root, in their primary key:
//        clones sharing a named cache dir overwrote each other's stamps.
//        A v55 index has no such column, so every statement on it failed;
//        the reset drops it. entry_stdout holds output bytes that are not
//        UTF-8 as written, which CACHE_VERSION v56 keys apart.
export const SCHEMA_VERSION = 'v56'

/**
 * SQL predicate selecting `runs` rows that record an EXECUTION.
 *
 * Every non-group, non-aborted outcome of a run gets a row, so the header's
 * `task_count` matches `COUNT(*)` and the run-detail timeline is complete.
 * But a `skipped` row is a task the run never executed — its upstream failed,
 * so it has no exit of its own, no duration, and made no cache decision.
 * Counting it in a RATE or a MEAN dilutes that figure with a non-event: a
 * task skipped as often as it succeeds reads 50% success, and a zero-duration
 * row drags every average toward zero.
 *
 * Lives here, beside the schema, because the same figure is computed in more
 * than one place (`Cache.stats` and the run-history queries both answer
 * "runs in the last 24h") and two copies of a rule are how they drift apart.
 */
export const EXECUTED_RUNS_SQL = "status <> 'skipped'"

/**
 * SQL predicate selecting `runs` rows that recorded a cache key. `hash` is
 * `''` for an outcome that never derived one (see {@link RunRecord.hash}),
 * and `''` is not a key: it can neither corroborate flakiness nor say the
 * inputs changed. Mirrors the `hash <> ''` guards in the cloud analytics copy.
 */
export const KEYED_RUNS_SQL = "hash <> ''"

/**
 * Close for real. A plain `close()` leaves the connection open while any
 * statement from `db.prepare()` lives (bun:sqlite 1.4.2 defers it, as
 * `sqlite3_close_v2` does), so `cache.db` and its `-wal` and `-shm` stayed
 * open after `Cache.close()`: a leaked descriptor per run for an embedder
 * (O-10).
 * `close(true)` finalizes them and closes. Below the Bun floor (1.3.14) it
 * does not finalize: it answers SQLITE_BUSY, "database is locked", and every
 * `vx run` exited 1 with that stack after its tasks had passed (M-44). There
 * the deferred close is the one that closes.
 */
export function closeDb(db: Database): void {
  try {
    db.close(true)
  } catch {
    db.close()
  }
}

/**
 * SQLite's answer when the disk under the index is full. It is a code on
 * the `SQLiteError` (`SQLITE_FULL`), never an `ENOSPC` errno, so
 * `isDiskFull` does not see it: a memo write, a snapshot flush or a prune's
 * delete on a full disk reached the user as a stack (A-14).
 */
export function isIndexFull(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'SQLITE_FULL'
}
