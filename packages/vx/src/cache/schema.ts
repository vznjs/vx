// The index's tables, one concern: what a cache.db holds. `Cache` opens the
// file, checks `SCHEMA_VERSION` and creates these; every statement against
// them lives in the store that owns the table (file-hashes, config-evals,
// output-index, history) or in cache.ts for `entries` and `entry_inputs`.

import type { Database } from 'bun:sqlite'

export function createTables(db: Database): void {
  // Cached config evaluations (workspace/config-cache.ts): the validated
  // config as JSON, keyed by everything the evaluation could observe. A
  // separate exec so the artifact schema stays byte-identical.
  db.exec(`
    CREATE TABLE IF NOT EXISTS config_evals (
      key        TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)

  db.exec(`
    -- The queryable index: command, exit_code, duration, size,
    -- timestamps, and stdout, which the <hash>.tar.zst artifact also
    -- carries so it survives a remote round trip; a local hit
    -- replays it from here.
    CREATE TABLE IF NOT EXISTS entries (
      hash         TEXT PRIMARY KEY,
      project      TEXT NOT NULL,
      task         TEXT NOT NULL,
      command      TEXT NOT NULL,
      exit_code    INTEGER NOT NULL,
      duration_ms  INTEGER NOT NULL,
      size_bytes   INTEGER NOT NULL,
      stdout       TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      accessed_at  INTEGER NOT NULL,
      -- v26: the producing execution's usage, from the artifact's sidecar.
      cpu_ms         INTEGER,
      peak_rss_bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS runs (
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
      -- said it (items 267–270): a skip's root blocker (a task id), vx's
      -- own timeout (1), the sandbox's violation count, and why a
      -- persistent task never became ready ('timeout' | 'exited' |
      -- 'spawn'). NULL where the reason does not apply.
      blocked_by          TEXT,
      timed_out           INTEGER,
      sandbox_violations  INTEGER,
      not_ready           TEXT
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
    DROP INDEX IF EXISTS runs_hash;
    DROP INDEX IF EXISTS runs_project;
    DROP INDEX IF EXISTS runs_ended;
    CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at);
    CREATE INDEX IF NOT EXISTS runs_run_id     ON runs(run_id);
    -- The one keyed index, PARTIAL over failed rows: a green run's
    -- inserts only evaluate its predicate, so the append-only cost above
    -- holds, and the flakiness probe after a miss (failure-mode.ts,
    -- "did this key ever fail?") reads a handful of leaves instead of
    -- scanning the table (2026-09-10: 10–95 ms at 170k rows without it).
    CREATE INDEX IF NOT EXISTS runs_failed ON runs(hash) WHERE status = 'failed';
    -- Per-file (mtime, size, content_hash) cache. Lets Cache.key()
    -- skip the content-hash on inputs whose stat hasn't changed
    -- since the last run. Pure performance optimization; the stored
    -- hash is the exact same one content-hashing would compute now,
    -- so the cache key derivation is unchanged.
    CREATE TABLE IF NOT EXISTS file_hashes (
      path         TEXT PRIMARY KEY,
      mtime_ms     INTEGER NOT NULL,
      size_bytes   INTEGER NOT NULL,
      ctime_ms     INTEGER NOT NULL,
      ino          INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      seen_at      INTEGER NOT NULL
    );
    -- The size of each index blob the enumeration checked against the
    -- worktree size git recorded (A-60). Fixed for its OID, so a warm
    -- run asks git for none; swept with file_hashes by seen_at, the
    -- time the row was written.
    CREATE TABLE IF NOT EXISTS blob_sizes (
      oid     TEXT PRIMARY KEY,
      size    INTEGER NOT NULL,
      seen_at INTEGER NOT NULL
    );
    -- The paths an index's (path, OID, recorded size) entries distrust,
    -- by their digest (A-60): a warm run reads one row, not one per blob.
    CREATE TABLE IF NOT EXISTS blob_verdicts (
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
    CREATE TABLE IF NOT EXISTS output_files (
      entry_hash  TEXT NOT NULL,
      path        TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      mode        INTEGER NOT NULL,
      mtime_ms    INTEGER NOT NULL,
      -- v28: the inode and ctime this machine saw after the save or
      -- restore that left the file equal to the entry; NULL until then.
      ino         INTEGER,
      ctime_ms    INTEGER,
      PRIMARY KEY (entry_hash, path),
      FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
    );
    -- Each config's ORDERED import closure (the config first), so a warm
    -- load keys it by stat-hashing the list (the file_hashes memo) instead
    -- of reading and scanning every file. Machine-local; pruned with
    -- config_evals (2026-09-03).
    CREATE TABLE IF NOT EXISTS config_closures (
      config_path TEXT PRIMARY KEY,
      files_json  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    -- Every directory under a whole-subtree output glob, with its mtime
    -- as of the last save/restore on THIS machine (2026-09-03). On a warm
    -- hit, unchanged mtimes prove the output SET is unchanged, replacing
    -- the glob walk that cost 0.36 ms per hit. Machine-local: a remote
    -- ingest writes none, and the first hit after it walks and records.
    CREATE TABLE IF NOT EXISTS output_dirs (
      entry_hash  TEXT NOT NULL,
      path        TEXT NOT NULL,
      mtime_ms    INTEGER NOT NULL,
      PRIMARY KEY (entry_hash, path),
      FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
    );
    -- v22 (Tier 3): one header row per vx-run invocation. The runs
    -- table is per-task; this is the per-invocation record that
    -- carries git/CI/host context, the command, tags, and run-level
    -- counts so the dashboard never reconstructs a header with a
    -- lossy GROUP BY over runs.
    CREATE TABLE IF NOT EXISTS invocations (
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
      exit_ok           INTEGER NOT NULL,
      commit_sha        TEXT,
      branch            TEXT,
      dirty             INTEGER,
      ci                INTEGER NOT NULL,
      ci_provider       TEXT,
      host              TEXT,
      os                TEXT,
      arch              TEXT,
      vx_version        TEXT NOT NULL,
      tags              TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS invocations_started ON invocations(started_at);
    CREATE INDEX IF NOT EXISTS invocations_branch  ON invocations(branch);
    CREATE INDEX IF NOT EXISTS invocations_ci      ON invocations(ci);
    -- v22 (Tier 3): the input-fingerprint moat. One row per cache-key
    -- component, keyed by the cache-ENTRY hash it belongs to (NOT a
    -- run id). Written inside the entry-save transaction — only on a
    -- miss/save, never on a hit — so a warm all-cache-hit run writes
    -- nothing here (the warm path does zero extra work). The
    -- why-did-this-re-run diff reads two entry hashes (this run's
    -- runs.hash and the previous run's) and anti-joins their rows in
    -- SQL over (kind,name,hash); a JSON blob would force an app-side
    -- parse + compare on every probe. ON DELETE CASCADE keeps these
    -- rows in sync with entries (a prune sweeps them automatically).
    CREATE TABLE IF NOT EXISTS entry_inputs (
      entry_hash TEXT NOT NULL,
      kind       TEXT NOT NULL,
      name       TEXT NOT NULL,
      hash       TEXT NOT NULL,
      PRIMARY KEY (entry_hash, kind, name),
      FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
    );
  `)
}
