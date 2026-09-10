// Content-addressed task cache.
//
// On-disk layout:
//   <cacheDir>/cache.db            — SQLite index (entries + runs + file_hashes)
//   <cacheDir>/<hash>.tar.zst      — per-entry artifact:
//                                      stdout             (captured stdout, always present)
//                                      outputs/           (declared output files, when any)
//                                      workspace-outputs/ (declared outputs.workspaceFiles,
//                                                          root-relative, when any)
//
// The artifact carries ONLY replayable bytes (logs + outputs). Entry
// metadata — taskId, command, exitCode, durationMs, storedAt — lives
// in the SQLite `entries` row. The same tar.zst bytes ship to a remote
// cache server unchanged; on remote-hit, the caller supplies metadata
// via the `ingest(hash, bytes, meta)` API so the local SQL index gets
// populated without sniffing the artifact.
//
// We never cache failed runs, so stderr is dropped from the cached
// surface entirely. Live runs still stream stderr through the logger
// for the user to see — but on a cache hit there's nothing to replay
// (the original run was successful and stderr typically empty).
//
// This is core's FLOOR, not a module to replace: remote storage is a
// `RemoteCacheLayer` (has / get / put) that `LayeredCache` wraps around
// this handle, declared by a plugin's `cache` hook. The contract every
// layer speaks is `CacheLayer` in layer.ts; `plugin-host.ts` enforces it.

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { relPosix, xxh3, xxh3hex, span } from '../util/index.js'
import {
  ArchiveSecurityError,
  extractArtifactStream,
  scanArtifact,
  packArtifactBytes,
  packArtifactStream,
  planArtifact,
} from './archive.js'
import { FsCASBackend } from './cas-backend.js'
import {
  type CacheEntry,
  type CacheGetContext,
  type CacheKeyInput,
  type CacheLayer,
  type CacheStats,
  type CacheStatsOptions,
  CorruptArtifactError,
  type IngestMeta,
  type InvocationRecord,
  type OutputDirRow,
  type OutputFileRow,
  type PruneOptions,
  type PruneResult,
  type RunRecord,
  type SaveArgs,
  type TaskInputRow,
} from './layer.js'
import { bytesOf, decodedTar, STREAM_DECODE_FROM, zstdEncoder } from './zstd.js'
import { ConfigEvalTable } from './config-evals.js'
import { FileHashStore } from './file-hashes.js'
import { OutputIndex } from './output-index.js'
import { RunHistory } from './run-history.js'

// v17: artifact carries only logs + outputs (stdout + outputs/<rel>).
// Local and remote layers transport the SAME tar.zst bytes — no
// separate stage/meta.json/tar.gz dance for remote, no
// `cache-archive.ts`. stderr is no longer cached: we only cache
// successful runs and stderr is rarely meaningful on success.
// v19: '^task' dependsOn expansion switched from transitive-deps to
// nearest-holder frontier — upstream-hash sets shrink, so keys change.
// v20: input-file content hashes switched from xxh3 to git blob OIDs
// (Turbo parity). Clean tracked files take their OID straight from
// the index (harvested by the bulk `git ls-files -s`); dirty /
// untracked files get the identical OID computed in-process. Every
// file's hash bytes change → bump. SCHEMA_VERSION moves with it:
// pre-v20 `file_hashes.content_hash` rows hold xxh3 digests that
// must not leak into the OID domain via the mtime+size memo.
// v22: reverted the v21 output-fold "early cutoff". Downstream keys
// fold the upstream's INPUT key (its task hash) again — pure-input
// transitive hashing (Turbo/Nx model). No output content participates
// in any cache key. SCHEMA v21 drops the now-unused outputs_hash
// column. Early cutoff removed (an upstream that re-emits identical
// output still re-runs dependents) — rare, not worth the cascade.
// v23: fold cache.inputs.runtime / workspaceRuntime command output into
// the key (two namespaced sections after env-values). Command strings
// live in the resolved config (frozen by `vx lock`); the OUTPUT is
// resolved live every run, so it stays correct under --frozen. No
// SCHEMA bump — only Cache.key derivation changed.
// v24: vx-lock.json added to the always-ignored input set (cache/
// inputs.ts ALWAYS_IGNORE). A task whose globs matched the root
// lockfile (broad `**/*` on the root project) drops it from the hashed
// file set, so those keys change; tasks that never matched it are
// byte-identical. No SCHEMA bump — only the input file set changed.
//
// CACHE_VERSION stays v24 through the Tier-3 schema roll (SCHEMA v22).
// Tier 3 persists the very components already fed to `Cache.key()` —
// it adds nothing to, reorders nothing in, and reweights nothing
// inside the key fold (the new `captureInto` sink is a pure
// side-channel). A task's hash is byte-identical before and after, so
// existing artifacts stay valid and there is no cache-version bump.
// v25: the ARTIFACT BYTES are wrong in every existing entry, while the
// key that addresses them is unchanged — the one situation a version
// bump exists for. Two defects: (a) `packArtifact` staged outputs with
// `Bun.write`, which does not carry the source mode, so every artifact
// records 0644 and a cache hit strips the executable bit off any binary
// or generated script; (b) it packed `--format=ustar`, which splits a
// name over 100 bytes into prefix+name, and the reader read only `name`
// — so those entries lost their `outputs/` prefix and were silently
// dropped from both the restore and the output_files index. Neither is
// self-healing: the stored bytes/headers are already wrong, so without a
// new namespace the fixed code would keep replaying them forever.
// v26: same situation, different producer. A task whose child was killed by
// a shutdown signal reported `aborted`, but `aborted` did not propagate to
// dependents — so a dependent ran against PARTIAL outputs, succeeded, and
// cached what it built. The fold takes the upstream's INPUT key, which a
// signal does not change, so that entry sits under exactly the key a healthy
// run derives and replays forever as a green hit. Fixing the propagation
// stops new poison but cannot reach entries already written, and a
// `LayeredCache` uploads them, so the reach is a whole team's shared cache
// rather than one developer's disk. Pre-alpha, so one cold rebuild is the
// cheap side of that trade.
export const CACHE_VERSION = 'vx-cache-v27'

/**
 * An artifact or temp file without an `entries` row is reaped by
 * `prune()` only once it is this old. A save renames the artifact into
 * place and commits its row in the same tick; a crashed save's temp is
 * stale long before this. Generous on purpose — a false orphan costs a
 * re-run, a leaked temp costs disk.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000

export interface SchemaReset {
  from: string
  to: string
}

/** Say once, on the channel the opener has, that an upgrade emptied the index. */
export function noteSchemaReset(cache: Cache, warn: (message: string) => void): void {
  if (cache.schemaReset === null) return
  const { from, to } = cache.schemaReset
  warn(
    `[vx] cache index reset: schema ${from} → ${to} (vx upgraded); every cached task misses once and re-saves, and \`vx cache prune\` reclaims the old artifacts`,
  )
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
//   v25: runs.cached — whether the task declared a `cache` block. An
//        uncached task's row looked like any executed miss, so `vx why`
//        headlined "cache key changed (inputs differ)" for a task that
//        runs every time by design, and `vx last` could not mark it the
//        way the terminal summary does (`no-cache`). Analytics-only —
//        the cache KEY is unchanged.
export const SCHEMA_VERSION = 'v25'

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
 * Artifact + `output_files` namespace prefix for workspace-root-
 * anchored outputs (`cache.outputs.workspaceFiles`). Project outputs
 * keep their bare project-relative `path` rows; workspace rows store
 * the full `workspace-outputs/<rel-to-root>` tar entry name as the
 * discriminator — least-invasive row format, no schema change. A
 * project output dir literally named `workspace-outputs/` would
 * collide with the namespace; the name is reserved.
 */
export const WORKSPACE_OUTPUT_PREFIX = 'workspace-outputs/'

// The contract, the policy grammar and the zstd framing live beside this
// file; they are re-exported here so an importer of `./cache.js` — the
// module index, the sibling layers, the tests — keeps one path.
export * from './layer.js'
export * from './policy.js'
export { zstdContentSize } from './zstd.js'

interface EntryRow {
  hash: string
  project: string
  task: string
  command: string
  exit_code: number
  duration_ms: number
  size_bytes: number
  stdout: string
  created_at: number
  accessed_at: number
}

function entryOf(row: EntryRow, fileRows: OutputFileRow[]): CacheEntry {
  return {
    hash: row.hash,
    taskId: `${row.project}#${row.task}`,
    command: row.command,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    outputFiles: fileRows.map((r) => r.path),
    outputRows: fileRows,
    stdout: row.stdout,
    storedAt: new Date(row.created_at).toISOString(),
    source: 'local',
  }
}

export class Cache implements CacheLayer {
  /** This IS the local layer — there is nothing slower behind it. */
  readonly hasRemote = false

  private readonly db: Database
  private readonly insertEntry: ReturnType<Database['prepare']>
  private readonly selectEntry: ReturnType<Database['prepare']>
  private readonly bumpAccessed: ReturnType<Database['prepare']>
  private readonly touched = new Set<string>()
  private readonly insertEntryInput: ReturnType<Database['prepare']>
  /** The per-file (mtime, size) → blob-OID memo behind `hashFile`. */
  private readonly files: FileHashStore
  private readonly configEvals: ConfigEvalTable
  private readonly outputs: OutputIndex
  private readonly history: RunHistory

  /**
   * Local-layer read/write gates for the task ARTIFACT path only.
   * `get()` returns null when `!read`; `save()` skips the artifact +
   * index write when `!write`. Everything else (recordRun, stats,
   * prune, ingest, hashing) is unaffected — those are bookkeeping a
   * run policy must not disable. Default: both true.
   */
  private readonly read: boolean
  private readonly write: boolean

  /**
   * Set when THIS open found an index written by another `SCHEMA_VERSION`
   * and dropped every table. The next open sees the current version and
   * reports null, so whoever opened first is the one that can say so —
   * `noteSchemaReset` is that one line, at every opener that has a
   * channel. Without it an upgrade empties the cache and the history in
   * silence, and the all-miss run that follows looks like a bug.
   */
  readonly schemaReset: SchemaReset | null = null

  constructor(
    private readonly cacheDir: string,
    localPolicy: { read: boolean; write: boolean } = { read: true, write: true },
  ) {
    this.read = localPolicy.read
    this.write = localPolicy.write
    // Ensure the directory exists before opening the DB — bun:sqlite
    // won't create parent dirs for us. The constructor stays sync
    // because callers use `new Cache(...)` directly; `mkdirSync` keeps
    // that property without a subprocess fork.
    mkdirSync(cacheDir, { recursive: true })
    // Make the cache dir invisible to git, every time it is created: a
    // `*` .gitignore inside it (the Cargo / Nx convention). Two reasons,
    // both measured. A cache nobody ignored gets COMMITTED by the next
    // `git add -A`; and vx's own `git status -uall` walks it — 1000
    // artifacts doubled the enumeration on the bench workspace before
    // its generator ignored `.vx`. An ignored directory is skipped by the
    // walk entirely. Only written when absent, so a user's own file wins.
    const ignore = path.join(cacheDir, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
    this.db = new Database(path.join(cacheDir, 'cache.db'), { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    // busy_timeout makes concurrent writers wait for the lock instead of
    // failing immediately with SQLITE_BUSY. Two parallel `vx run`
    // invocations in CI is a normal pattern; without this the second one
    // crashes in recordRun().
    this.db.exec('PRAGMA busy_timeout = 5000')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    // Schema-version gate runs BEFORE the rest of the schema lands so
    // a column rename (e.g. v15's `sha256` → `content_hash`) actually
    // takes effect on stale DBs. Pre-alpha: no migrations, just drop
    // and recreate. Artifacts on disk become orphans: a lookup never
    // sees them (rows first, then the file), the next save of the same
    // key renames over them, and `prune()`'s orphan sweep unlinks the
    // rest.
    const meta = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
      | { value: string }
      | undefined
    if (meta && meta.value !== SCHEMA_VERSION) {
      this.schemaReset = { from: meta.value, to: SCHEMA_VERSION }
      this.db.exec(
        'DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS file_hashes; DROP TABLE IF EXISTS output_files; DROP TABLE IF EXISTS invocations; DROP TABLE IF EXISTS run_task_inputs; DROP TABLE IF EXISTS entry_inputs; DROP TABLE IF EXISTS config_evals;',
      )
      this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(SCHEMA_VERSION)
    } else if (!meta) {
      this.db
        .prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?)")
        .run(SCHEMA_VERSION)
    }

    // Cached config evaluations (workspace/config-cache.ts): the validated
    // config as JSON, keyed by everything the evaluation could observe. A
    // separate exec so the artifact schema above stays byte-identical.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config_evals (
        key        TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)

    this.db.exec(`
      -- stdout/stderr live in the <hash>.tar.zst artifact, not here
      -- (v14+) — so they survive remote round-trips. The entries
      -- table is the queryable index: command, exit_code, duration,
      -- size, timestamps.
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
        accessed_at  INTEGER NOT NULL
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
        cached              INTEGER
      );
      -- Two indexes only, and both APPEND: every row of a run carries the
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
        PRIMARY KEY (entry_hash, path),
        FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
      );
      -- Every directory under a whole-subtree output glob, with its mtime
      -- as of the last save/restore on THIS machine (2026-09-03). On a warm
      -- hit, unchanged mtimes prove the output SET is unchanged, replacing
      -- the glob walk that cost 0.36 ms per hit. Machine-local: a remote
      -- ingest writes none, and the first hit after it walks and records.
      -- Each config's ORDERED import closure (the config first), so a warm
      -- load keys it by stat-hashing the list (the file_hashes memo) instead
      -- of reading and scanning every file. Machine-local; pruned with
      -- config_evals (2026-09-03).
      CREATE TABLE IF NOT EXISTS config_closures (
        config_path TEXT PRIMARY KEY,
        files_json  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
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

    this.insertEntry = this.db.prepare(`
      INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        stdout       = excluded.stdout,
        project      = excluded.project,
        task         = excluded.task,
        command      = excluded.command,
        exit_code    = excluded.exit_code,
        duration_ms  = excluded.duration_ms,
        size_bytes   = excluded.size_bytes,
        accessed_at  = excluded.accessed_at
    `)
    this.selectEntry = this.db.prepare('SELECT * FROM entries WHERE hash = ?')
    this.bumpAccessed = this.db.prepare('UPDATE entries SET accessed_at = ? WHERE hash = ?')
    // INSERT OR IGNORE: re-saving the same hash (idempotent ingest /
    // overlapping concurrent saves) leaves the existing rows untouched —
    // identical inputs derive the identical hash, so the rows are too.
    this.insertEntryInput = this.db.prepare(`
      INSERT OR IGNORE INTO entry_inputs(entry_hash, kind, name, hash)
      VALUES (?, ?, ?, ?)
    `)
    // The slices: each owns its statements over this handle and its table(s);
    // the schema above is the one place every table is declared.
    this.files = new FileHashStore(this.db, cacheDir)
    this.configEvals = new ConfigEvalTable(this.db, localPolicy)
    this.outputs = new OutputIndex(this.db)
    this.history = new RunHistory(this.db)
  }

  // --- config evaluations: `ConfigEvalStore`, delegated to `ConfigEvalTable` ---
  getConfigEval(key: string): string | null {
    return this.configEvals.getConfigEval(key)
  }
  getConfigClosures(configPaths: readonly string[]): Map<string, string[]> {
    return this.configEvals.getConfigClosures(configPaths)
  }
  putConfigClosure(configPath: string, files: readonly string[]): void {
    this.configEvals.putConfigClosure(configPath, files)
  }
  getConfigEvals(keys: readonly string[]): Map<string, string> {
    return this.configEvals.getConfigEvals(keys)
  }
  putConfigEval(key: string, json: string): void {
    this.configEvals.putConfigEval(key, json)
  }
  // --- input file hashes: delegated to `FileHashStore` (see file-hashes.ts) ---
  hashFile(filePath: string): Promise<string> {
    return this.files.hashFile(filePath)
  }
  hashFiles(paths: readonly string[]): Promise<Map<string, string>> {
    return this.files.hashFiles(paths)
  }
  async key(input: CacheKeyInput): Promise<string> {
    // Seed-chained xxHash3: each step folds one field into the
    // running digest via `xxh3(part, prevDigest)`. Equivalent to the
    // old CryptoHasher.update() pattern, no intermediate buffer.
    // Field-order matters; each line is prefixed with its label so
    // adjacent fields can't collide via concat.
    // Optional capture sink — see CacheKeyInput.captureInto. Pure
    // side-channel; every push below mirrors the fold immediately
    // above/beside it so the recorded set can't drift from the key.
    const cap = input.captureInto
    let h = xxh3(CACHE_VERSION)
    h = xxh3(`task:${input.taskId}`, h)
    h = xxh3(`workspace:${input.workspaceFingerprint}`, h)
    h = xxh3(`pkg:${input.projectPackageJsonHash}`, h)
    h = xxh3(`config:${input.taskConfigHash}`, h)
    if (cap) {
      cap.push({ kind: 'workspace', name: 'fingerprint', hash: input.workspaceFingerprint })
      cap.push({ kind: 'package', name: 'package.json', hash: input.projectPackageJsonHash })
      cap.push({ kind: 'config', name: 'config', hash: input.taskConfigHash })
    }

    // NOTE on `cap` (entry_inputs capture): the `hash` field stores a
    // DIGEST of each component, never the raw value. For value-bearing kinds
    // (env, runtime, ws-runtime, forward) the payload is a secret or
    // sensitive string (API keys via cache.inputs.env, runtime-command
    // output, args after `--`), so we push `xxh3hex(v)` — the diff consumer
    // only needs to know whether a component CHANGED, which a digest
    // preserves losslessly. cache.db must never hold plaintext secrets at
    // rest. The cache KEY (`h`) folds the plaintext separately below and is
    // unaffected.
    const forwarded = input.forwardArgs ?? []
    h = xxh3(`forward-args:${forwarded.length}`, h)
    for (const a of forwarded) h = xxh3(a, h)
    if (cap && forwarded.length > 0) {
      cap.push({ kind: 'forward', name: 'argv', hash: xxh3hex(JSON.stringify(forwarded)) })
    }

    h = xxh3(`env-values:${input.envValues.length}`, h)
    // \0 delimiter, not `=`: names and values may themselves contain
    // `=`, and `A` + `B=C` must never fold the same bytes as `A=B` + `C`.
    for (const [n, v] of input.envValues) h = xxh3(`${n}\0${v}`, h)
    if (cap)
      for (const [n, v] of input.envValues) cap.push({ kind: 'env', name: n, hash: xxh3hex(v) })

    const runtimeValues = input.runtimeValues ?? []
    h = xxh3(`runtime-values:${runtimeValues.length}`, h)
    for (const [c, o] of runtimeValues) h = xxh3(`${c}\0${o}`, h)
    if (cap)
      for (const [c, o] of runtimeValues) cap.push({ kind: 'runtime', name: c, hash: xxh3hex(o) })

    const wsRuntimeValues = input.workspaceRuntimeValues ?? []
    h = xxh3(`ws-runtime-values:${wsRuntimeValues.length}`, h)
    for (const [c, o] of wsRuntimeValues) h = xxh3(`${c}\0${o}`, h)
    if (cap)
      for (const [c, o] of wsRuntimeValues)
        cap.push({ kind: 'ws-runtime', name: c, hash: xxh3hex(o) })

    const upstream = [...input.upstreamHashes].sort()
    h = xxh3(`upstream:${upstream.length}`, h)
    for (const u of upstream) h = xxh3(u, h)
    if (cap) {
      for (const u of upstream) {
        cap.push({ kind: 'upstream', name: input.upstreamIds?.get(u) ?? u, hash: u })
      }
    }

    const pluginParts = input.pluginParts ?? []
    if (pluginParts.length > 0) {
      h = xxh3(`plugin:${pluginParts.length}`, h)
      for (const [n, v] of pluginParts) h = xxh3(`${n}\0${v}`, h)
      if (cap) {
        for (const [n, v] of pluginParts) cap.push({ kind: 'plugin', name: n, hash: xxh3hex(v) })
      }
    }

    const sortedInputs = [...input.inputFiles].sort()
    h = xxh3(`inputs:${sortedInputs.length}`, h)
    // Per-file hash source, in preference order: the caller-supplied
    // index-OID map (clean tracked files — zero I/O), then hashFile's
    // stat memo (no read), then a full in-process blob-OID computation.
    // All three describe the WORKTREE bytes, which is what the task
    // reads — the index-OID map is only populated for paths whose
    // worktree form matches their index form, because a clean filter
    // (`text`/`eol`/`ident`) makes the index blob a DIFFERENT sequence
    // of bytes and folding it would let two distinct worktree contents
    // share a key. The fold order is locked to `sortedInputs` so
    // results are stable across runs.
    const fileHashes = await Promise.all(
      sortedInputs.map((f) => input.fileHashes?.get(f) ?? this.hashFile(f)),
    )
    for (let i = 0; i < sortedInputs.length; i++) {
      const file = sortedInputs[i]!
      const rel = relPosix(input.workspaceRoot, file)
      const oid = fileHashes[i]!
      h = xxh3(`${rel}\0${oid}`, h)
      // The OID is already awaited — file capture is zero extra I/O.
      if (cap) cap.push({ kind: 'file', name: rel, hash: oid })
    }

    return h.toString(16).padStart(16, '0')
  }

  // ctx is accepted but ignored — the local layer reads metadata from
  // the entries row. It's part of the contract so LayeredCache can
  // route metadata to `ingest()` on remote-hit without a separate API.
  async get(hash: string, _ctx?: CacheGetContext): Promise<CacheEntry | null> {
    // Local reads disabled (e.g. `--force` / `--cache=local:w`): report a
    // miss so the task re-executes. The artifact + index are untouched.
    if (!this.read) return null
    return this.readEntry(hash)
  }

  /**
   * Read an entry BYPASSING the local read gate. The gate means "don't
   * serve hits out of the PRE-EXISTING local cache" — it must not throw
   * away bytes this run just downloaded. `LayeredCache` calls this to
   * deliver an artifact it ingested from the remote; under
   * `--cache=local:,remote:rw` the gated `get` returned null for the row
   * `ingest` had just written, so the task re-executed and re-uploaded on
   * every single run.
   */
  getIngested(hash: string): Promise<CacheEntry | null> {
    return this.readEntry(hash)
  }

  private async readEntry(hash: string): Promise<CacheEntry | null> {
    const row = this.selectEntry.get(hash) as EntryRow | undefined
    if (!row) return null

    // Verify the tar artifact actually exists. The DB and the
    // filesystem can drift if someone manually deletes the cache dir.
    if (!existsSync(this.tarPath(hash))) return null

    // Deferred: per-hit UPDATEs cost ~60 ms across 2000+ probes on a
    // full-cache run. Hashes are collected and flushed as ONE batched
    // UPDATE by flushAccessed() (called from prune/stats/close), which
    // is when accessed_at is actually read.
    this.touched.add(hash)

    // Pure SQL: outputFiles come from the output_files rows and
    // stdout from the entries row. The artifact is NOT touched here —
    // decompressing it made hit cost scale with artifact size (73 ms
    // for four up-to-date hits on ~70 MB binaries). restoreOutputs
    // reads the artifact itself, only when extraction actually runs.
    const fileRows = this.loadOutputFilesBatch([hash]).get(hash) ?? []
    const entry = entryOf(row, fileRows)
    entry.outputDirRows = this.loadOutputDirsBatch([hash]).get(hash) ?? []
    return entry
  }

  /**
   * `get` for many hashes at once: one `entries` query and one
   * `output_files` query per chunk instead of two per hash, with the
   * artifact-existence stats in flight together. Same answers as N calls
   * to `get` — a hash whose artifact is gone is simply absent from the map.
   * The up-front short-circuit probe is the caller; per-hit `get` stays for
   * the lazy path.
   */
  async getMany(hashes: readonly string[]): Promise<Map<string, CacheEntry>> {
    const out = new Map<string, CacheEntry>()
    if (!this.read || hashes.length === 0) return out
    const rows: EntryRow[] = []
    for (let i = 0; i < hashes.length; i += 900) {
      const chunk = hashes.slice(i, i + 900)
      const placeholders = chunk.map(() => '?').join(',')
      rows.push(
        ...(this.db
          .query(`SELECT * FROM entries WHERE hash IN (${placeholders})`)
          .all(...(chunk as readonly SQLQueryBindings[])) as EntryRow[]),
      )
    }
    if (rows.length === 0) return out
    const present = rows.map((r) => existsSync(this.tarPath(r.hash)))
    const live = rows.filter((_r, i) => present[i])
    const liveHashes = live.map((r) => r.hash)
    const fileRows = this.loadOutputFilesBatch(liveHashes)
    const dirRows = this.loadOutputDirsBatch(liveHashes)
    for (const row of live) {
      this.touched.add(row.hash)
      const entry = entryOf(row, fileRows.get(row.hash) ?? [])
      entry.outputDirRows = dirRows.get(row.hash) ?? []
      out.set(row.hash, entry)
    }
    return out
  }

  // Existence probe: SQL row + artifact-on-disk check, no byte reads
  // and no accessed_at bump (the plan path must stay read-only).
  async has(hash: string): Promise<'local' | 'remote' | null> {
    if (!this.read) return null
    const row = this.selectEntry.get(hash) as EntryRow | undefined
    if (!row) return null
    return existsSync(this.tarPath(hash)) ? 'local' : null
  }

  // Local cache has no slower layer to warm from — prefetch is a no-op.
  // The contract still resolves false so callers can treat every layer
  // uniformly (LayeredCache overrides with the real remote pull).
  async prefetch(_hash: string, _ctx?: CacheGetContext): Promise<boolean> {
    return false
  }

  // --- output fingerprints: delegated to `OutputIndex` (see output-index.ts) ---
  // The slices' proofs and hashes are returned as the slice's own promise —
  // no `async` wrapper, no `return await`: each of those added a promise and
  // a microtask hop per call, and a 1,000-hit warm run pays the proofs
  // 2,000 times (measured 2026-09-10: +3 ms on `classify + probe`).
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    return this.outputs.loadOutputFilesBatch(hashes)
  }
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean> {
    return this.outputs.isOutputsCurrent(projectDir, expected)
  }
  outputsPath(hash: string): string {
    return this.tarPath(hash)
  }

  async recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
  ): Promise<void> {
    await this.outputs.recordOutputDirs(hash, projectDir, prefixes)
  }
  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    return this.outputs.loadOutputDirsBatch(hashes)
  }
  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean> {
    return this.outputs.outputDirsCurrent(projectDir, rows)
  }
  async restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void> {
    // In-process extraction — no fork+exec on the hot path
    // (~5-10ms reclaimed per hit vs the prior subprocess `tar -xf`).
    //
    // The "tree is already current" skip-everything check happens at
    // the orchestrator level (using the batched `output_files` map),
    // BEFORE this method runs. By the time we're here we've committed
    // to a fresh extract.
    //
    // `stdout` / `stderr` entries in the archive are ignored on this
    // path — they're surfaced via `get()` for the orchestrator to
    // replay through the logger.
    const src = this.tarPath(hash)
    // The caller already committed to this hit and WIPED the declared
    // outputs, so returning quietly here would report a green cache hit over
    // an emptied output tree. The artifact existed when `get()` probed it, so
    // its absence now means something removed it underneath us (a concurrent
    // `vx cache prune` is the documented way) — fail loud; the task re-runs.
    if (!(await Bun.file(src).exists())) {
      throw new CorruptArtifactError(hash, 'artifact file vanished before restore')
    }
    // The index says exactly which files this entry materializes. If the
    // archive cannot produce one of them, restoring "successfully" leaves a
    // hole that no later run detects: the skip-restore check compares the
    // same truncated expectation against the same truncated tree and agrees
    // forever. Refuse instead of silently under-restoring — checked before
    // anything is renamed into place.
    const rows = this.loadOutputFilesBatch([hash]).get(hash) ?? []
    const expected = rows
      .filter((r) => workspaceRoot !== undefined || !r.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
      .map((r) => (r.path.startsWith(WORKSPACE_OUTPUT_PREFIX) ? r.path : `outputs/${r.path}`))
    const verify = (provided: ReadonlySet<string>): void => {
      const missing = expected.filter((name) => !provided.has(name))
      if (missing.length > 0) {
        throw new CorruptArtifactError(
          hash,
          `artifact is missing ${missing.length} recorded output(s): ${missing.slice(0, 3).join(', ')}`,
        )
      }
    }

    // One tar reader and one extractor either way; only the decode differs
    // by size. A large artifact is decoded and read as it streams, so the
    // restore costs a chunk of memory, not 4× the artifact (measured
    // 2026-09-03 on 150 MiB: +644 MiB in memory, +49 MiB streamed, same
    // wall time). A small one is decoded in one call: the stream setup
    // costs ~35 µs per artifact, which is 4% of the headline restore row
    // when every artifact is a one-file `dist/` (measured: 390 vs 355 ms
    // per 1 000). The local artifact was validated at ingest, so a missing
    // declared size is allowed; the output ceiling applies to both.
    try {
      const tar = await decodedTar(Bun.file(src), hash)
      await extractArtifactStream(tar, projectDir, workspaceRoot, verify)
    } catch (err) {
      if (err instanceof ArchiveSecurityError || err instanceof CorruptArtifactError) throw err
      throw new CorruptArtifactError(hash, 'artifact is not a readable archive', err)
    }
  }

  async save(args: {
    hash: string
    /** See `CacheLayer.save` — `exitCode` is not a caller's to supply. */
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    /** See `CacheLayer.save`. */
    skipLocalWrite?: boolean
    workspaceOutputFiles?: string[]
    workspaceRoot?: string
    inputComponents?: readonly TaskInputRow[]
  }): Promise<void> {
    // Layout (v17, extended additively for workspaceFiles): one
    // `<hash>.tar.zst` per entry. Tar carries ONLY the things you'd
    // want to re-materialize on a cache hit:
    //
    //   stdout                      — captured stdout (ALWAYS present, may be empty)
    //   outputs/<rel>               — declared output files (omitted when none)
    //   workspace-outputs/<rel>     — declared outputs.workspaceFiles,
    //                                 rel to the WORKSPACE ROOT (omitted when none)
    //
    // Metadata (command, exitCode, durationMs, storedAt) lives in
    // SQLite, not the artifact. Remote-hit ingestion takes metadata
    // through `ingest()` arguments — the artifact stays clean bytes.
    //
    // Local writes disabled (e.g. `--cache=local:,remote:rw`): produce
    // no `<hash>.tar.zst` and no index row. The LayeredCache wrapping us
    // still uploads to remote — it calls `packArtifact` itself to get
    // the bytes, since there's no local artifact to read off disk.
    if (!this.write) return
    if (args.skipLocalWrite === true) return
    await mkdir(this.cacheDir, { recursive: true })
    const endPack = span('save: pack')
    const compressed = await this.packArtifactToTemp(this.tempPath(args.hash), args)
    endPack()
    await this.writeArtifactAndIndex(args.hash, compressed, {
      taskId: args.entry.taskId,
      command: args.entry.command,
      durationMs: args.entry.durationMs,
      ...(args.inputComponents !== undefined ? { inputComponents: args.inputComponents } : {}),
    })
  }

  /**
   * Whether this local layer persists artifacts. The LayeredCache reads
   * it to decide between uploading the on-disk artifact (write enabled)
   * vs. packing bytes in memory (write disabled) for a remote upload.
   */
  get localWritesEnabled(): boolean {
    return this.write
  }

  /**
   * Pack the save args into tar.zst bytes WITHOUT touching disk or the
   * index. Used by the LayeredCache when local writes are disabled but
   * a remote upload still needs the artifact bytes.
   */
  packArtifactBytes(args: SaveArgs): Promise<Uint8Array> {
    return this.packArtifact(args)
  }

  async ingest(hash: string, compressed: Uint8Array, meta: IngestMeta): Promise<void> {
    await this.writeArtifactAndIndex(hash, compressed, meta)
  }

  /**
   * Collect stdout + outputs into artifact bytes, zstd-compress, return
   * them. No disk write to the final cache path — that's the index
   * step's job. Pure transform, so `ingest()` can skip this and hand
   * its remote-supplied bytes straight to `writeArtifactAndIndex`.
   *
   * Entries are named directly into the archive, so there is no staging
   * copy of every output byte and no `tar` subprocess (see
   * `archive.ts`).
   */
  /** Archive name → absolute source path for every declared output. */
  private outputsOf(args: {
    projectDir: string
    outputFiles: string[]
    workspaceOutputFiles?: string[]
    workspaceRoot?: string
  }): Map<string, string> {
    const outputs = new Map<string, string>()
    for (const f of args.outputFiles) {
      outputs.set(`outputs/${path.relative(args.projectDir, f)}`, f)
    }
    // Caller passes workspaceRoot whenever workspaceOutputFiles is
    // non-empty; the rels are root-anchored by construction.
    for (const f of args.workspaceOutputFiles ?? []) {
      outputs.set(`${WORKSPACE_OUTPUT_PREFIX}${path.relative(args.workspaceRoot!, f)}`, f)
    }
    return outputs
  }

  /**
   * The compressed artifact, in memory: the remote upload when local
   * writes are off. A large artifact is packed and compressed as a
   * stream and collected — the seam takes bytes.
   */
  private async packArtifact(args: {
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    workspaceOutputFiles?: string[]
    workspaceRoot?: string
  }): Promise<Uint8Array> {
    // stdout is ALWAYS present in the artifact, even if empty, so the
    // layout is predictable: a successful read finds `stdout` and
    // zero-or-more `outputs/<rel>` / `workspace-outputs/<rel>` entries.
    const plan = await planArtifact({
      stdout: args.entry.stdout ?? '',
      outputs: this.outputsOf(args),
    })
    if (plan.size <= STREAM_DECODE_FROM)
      return await Bun.zstdCompress(await packArtifactBytes(plan))
    return bytesOf(packArtifactStream(plan).pipeThrough(zstdEncoder()))
  }

  /**
   * Pack for the local save. A large artifact is read from disk as it is
   * written and compressed as a stream straight into the temp, so it
   * never sits in memory (measured 2026-09-03 on a 150 MiB output: +705
   * MiB before). The streamed compressor is ~2.4× the one-call cost per
   * byte and a stream costs ~35 µs to set up, so a small artifact is
   * packed in memory and compressed in one call — returned as bytes,
   * nothing written yet.
   */
  private async packArtifactToTemp(
    tmpPath: string,
    args: Parameters<Cache['packArtifact']>[0],
  ): Promise<Uint8Array | { tmpPath: string }> {
    const plan = await planArtifact({
      stdout: args.entry.stdout ?? '',
      outputs: this.outputsOf(args),
    })
    if (plan.size <= STREAM_DECODE_FROM)
      return await Bun.zstdCompress(await packArtifactBytes(plan))
    const sink = Bun.file(tmpPath).writer()
    try {
      for await (const chunk of packArtifactStream(plan).pipeThrough(zstdEncoder())) {
        await sink.write(chunk)
      }
    } catch (err) {
      // An output that vanished or changed shape between the plan's stat
      // and its read: the partial temp must not outlive the failure.
      await sink.end()
      await unlink(tmpPath).catch(() => undefined)
      throw err
    }
    await sink.end()
    return { tmpPath }
  }

  /**
   * Atomically write `compressed` to `<hash>.tar.zst` and (re)build the
   * entries + output_files SQL rows from the archive itself. Shared by
   * `save()` (we just packed the bytes) and `ingest()` (we got them from
   * the remote layer) — both index the identical values, because both
   * read them out of the artifact.
   */
  /** tmp suffix mixes pid + hrtime + a random hex chunk so two saves of
   *  the same hash from the same process (or from two forked workers that
   *  happen to share a wall-clock ms) don't pick the same tmp filename and
   *  race on the rename. */
  private tempPath(hash: string): string {
    return `${this.tarPath(hash)}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2, 10)}`
  }

  private async writeArtifactAndIndex(
    hash: string,
    compressed: Uint8Array | { tmpPath: string },
    meta: IngestMeta,
  ): Promise<void> {
    // Validate BEFORE anything touches the final path. `ingest()` feeds
    // us network bytes; a truncated/garbage body that went live first
    // would leave a corrupt `<hash>.tar.zst` behind (with no SQL row,
    // since the decompress throw aborted indexing) for every later
    // reader to trip over. Decompress + parse also produce the
    // `output_files` rows: same headers the restore will see on
    // restore, so the size/mode/mtime fingerprint we store matches
    // what isOutputsCurrent will compare against post-restore.
    const finalPath = this.tarPath(hash)
    let tmpPath: string
    if (compressed instanceof Uint8Array) {
      tmpPath = this.tempPath(hash)
      await mkdir(this.cacheDir, { recursive: true })
      // The temp is written BEFORE validation so a large artifact can be
      // scanned from the file as it decodes — a file stream reads in
      // bounded pieces; the bytes in memory would not (see `decodedTar`).
      // The final path is still untouched until the archive has passed.
      // node's writeFile, not Bun.write: the latter copies the buffer first
      // (measured on 150 MiB: +151 MiB and 33 ms against +0 and 21 ms).
      const endWrite = span('save: write temp')
      await writeFile(tmpPath, compressed)
      endWrite()
    } else {
      // `save` already streamed the artifact into its temp.
      tmpPath = compressed.tmpPath
    }
    let scanned: Awaited<ReturnType<typeof scanArtifact>>
    try {
      // ingest() is the UNTRUSTED boundary — `compressed` is bytes just
      // pulled from a remote. Refuse a bomb (declared or sizeless) before it
      // can expand into memory.
      const source =
        compressed instanceof Uint8Array && compressed.byteLength <= STREAM_DECODE_FROM
          ? compressed
          : Bun.file(tmpPath)
      const endScan = span('save: scan')
      scanned = await scanArtifact(await decodedTar(source, hash))
      endScan()
      // v17 invariant: every artifact carries a `stdout` entry. Its
      // absence means the bytes decompressed but aren't a vx artifact.
      if (scanned.stdout === null) {
        throw new CorruptArtifactError(hash, 'missing stdout entry')
      }
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined)
      if (err instanceof ArchiveSecurityError || err instanceof CorruptArtifactError) throw err
      throw new CorruptArtifactError(hash, 'artifact is not a readable archive', err)
    }
    const { entries } = scanned
    // POSIX rename atomically REPLACES the destination if it exists,
    // so we don't need a pre-rm. The pre-rm was actively harmful —
    // it opened a race window where writer B could delete writer A's
    // just-renamed file BEFORE A's subsequent stat, producing a
    // spurious ENOENT. The rename itself preserves the "either-or"
    // semantics for concurrent readers.
    const endRename = span('save: rename')
    await rename(tmpPath, finalPath)
    endRename()

    const totalBytes =
      compressed instanceof Uint8Array ? compressed.byteLength : Bun.file(finalPath).size
    const outputFileRows: Array<[string, number, number, number]> = []
    // Per-output-file fingerprint rows feed the skip-restore check.
    // Row paths: project entries store the bare rel (`outputs/`
    // stripped); workspace entries keep the full
    // `workspace-outputs/<rel>` name as the namespace discriminator.
    //
    // Mode and MILLISECOND mtime come from the artifact's own sidecar
    // (`.vx-meta.json`), written from a stat taken while packing. Both
    // paths — save and remote ingest — therefore index the same values,
    // and `restoreOutputs` materialises exactly them, so
    // `isOutputsCurrent` compares equal at ms precision straight after a
    // restore. (Tar headers carry seconds, which is why the save path
    // used to need a second stat pass the ingest path could not have.)
    for (const e of entries) {
      let rowPath: string | null = null
      if (e.name.startsWith('outputs/')) {
        const rel = e.name.slice('outputs/'.length)
        if (rel.length > 0) rowPath = rel
      } else if (e.name.startsWith(WORKSPACE_OUTPUT_PREFIX)) {
        if (e.name.length > WORKSPACE_OUTPUT_PREFIX.length) rowPath = e.name
      }
      if (rowPath === null) continue
      outputFileRows.push([rowPath, e.size, e.mode & 0o777, Math.floor(e.mtimeMs)])
    }
    const stdoutText = scanned.stdout

    const [project, task] = splitTaskId(meta.taskId)
    const now = Date.now()

    // One transaction for the entries row + every output_files row +
    // the Tier-3 entry_inputs fingerprint rows. One fsync regardless of
    // row count. The fingerprint rows ride this save-time transaction
    // (not the per-run path) so a warm all-cache-hit run — which never
    // saves — writes none of them.
    const insertEntry = this.insertEntry
    const outputs = this.outputs
    const insertEntryInput = this.insertEntryInput
    const inputComponents = meta.inputComponents
    const tx = this.db.transaction(() => {
      insertEntry.run(
        hash,
        project,
        task,
        meta.command,
        // exitCode. Pinned, not supplied: vx caches only successes, and neither
        // `save` nor `ingest` accepts one (see their arg types). The column
        // stays because the READ side still defends against a non-zero value —
        // a row from a foreign or hand-edited cache.db classifies the hit
        // `failed` rather than laundering a broken build into a green run.
        0,
        meta.durationMs,
        totalBytes,
        stdoutText,
        now,
        now,
      )
      outputs.replaceFileRows(hash, outputFileRows)
      // INSERT OR IGNORE: identical inputs derive this same hash, so a
      // re-save's rows are identical — keep the first set, skip the rest.
      if (inputComponents !== undefined) {
        for (const c of inputComponents) {
          insertEntryInput.run(hash, c.kind, c.name, c.hash)
        }
      }
    })
    const endTx = span('save: index tx')
    tx()
    endTx()
  }

  /** Apply the deferred accessed_at bumps in one statement. */
  private flushAccessed(): void {
    if (this.touched.size === 0) return
    const hashes = [...this.touched]
    this.touched.clear()
    const now = Date.now()
    // Chunked: SQLite's bound-parameter ceiling is 32k on modern
    // builds, but 900 keeps us safe on any build at negligible cost.
    for (let i = 0; i < hashes.length; i += 900) {
      const chunk = hashes.slice(i, i + 900)
      const placeholders = chunk.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE entries SET accessed_at = ? WHERE hash IN (${placeholders})`)
        .run(now, ...chunk)
    }
  }

  /**
   * Raw `bun:sqlite` Database handle. Exposed for subsystems that
   * need to issue their own queries (LocalHistoryProvider's CTE,
   * future analytics consumers) without us proxying every method.
   * Callers must NOT close the handle directly — `Cache.close()` owns
   * the lifetime.
   */
  dbHandle(): Database {
    return this.db
  }

  /**
   * Content-addressed view over the same artifacts directory: an
   * `FsCASBackend` rooted at `cacheDir`, reading and writing the
   * `<hash>.tar.zst` files `Cache.save` produces, keyed by `Digest`.
   * A write through it lands `<digest.hash>.tar.zst` with no index row:
   * under a hash no row references it is an orphan `prune()` reaps after
   * the in-flight grace window; under a hash a LIVE row references it
   * REPLACES that entry's bytes, and the next lookup serves them. So it is
   * a raw bytes view of the artifacts directory, not a save path — nothing
   * in core writes through it, and a consumer that does owns that risk.
   */
  contentBackend(): FsCASBackend {
    return new FsCASBackend(this.cacheDir)
  }

  // --- run history: delegated to `RunHistory` (see run-history.ts) ---
  recordRun(run: RunRecord): void {
    this.history.recordRun(run)
  }
  recordRuns(runs: readonly RunRecord[]): void {
    this.history.recordRuns(runs)
  }
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void {
    this.history.recordRunBundle(bundle)
  }
  stats(opts: CacheStatsOptions = {}): CacheStats {
    this.flushAccessed()
    const project = opts.project
    const scoped = project !== undefined
    const scopeParams: string[] = project === undefined ? [] : [project]
    const aggregate = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM entries${
          scoped ? ' WHERE project = ?' : ''
        }`,
      )
      .get(...scopeParams) as { n: number; bytes: number }
    const since = Date.now() - 24 * 60 * 60 * 1000
    const runs = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status IN ('cache-hit', 'cache-hit-remote') THEN 1 ELSE 0 END), 0) AS hits FROM runs WHERE started_at >= ? AND ${EXECUTED_RUNS_SQL}${
          scoped ? ' AND project = ?' : ''
        }`,
      )
      .get(since, ...scopeParams) as { total: number; hits: number }
    return {
      entryCount: aggregate.n,
      totalBytes: aggregate.bytes,
      runCountLast24h: runs.total,
      hitCountLast24h: runs.hits,
    }
  }

  async prune(options: PruneOptions): Promise<PruneResult> {
    this.flushAccessed()
    const { olderThanMs, maxBytes, dryRun = false } = options
    if (olderThanMs === undefined && maxBytes === undefined) {
      throw new Error('prune: pass at least one of `olderThanMs` or `maxBytes`')
    }

    const victims = new Set<string>()
    let bytesFreed = 0

    if (olderThanMs !== undefined) {
      const rows = this.db
        .prepare('SELECT hash, size_bytes FROM entries WHERE accessed_at < ?')
        .all(olderThanMs) as Array<{ hash: string; size_bytes: number }>
      for (const r of rows) {
        victims.add(r.hash)
        bytesFreed += r.size_bytes
      }
    }

    if (maxBytes !== undefined) {
      const totalRow = this.db
        .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM entries')
        .get() as { bytes: number }
      let remaining = totalRow.bytes - bytesFreed
      if (remaining > maxBytes) {
        // Exclude already-picked victims in JS, not via a SQL NOT-IN —
        // an IN-list over tens of thousands of TTL victims would blow
        // SQLite's bound-parameter ceiling (see flushAccessed's 900 cap).
        const candidates = (
          this.db
            .prepare('SELECT hash, size_bytes FROM entries ORDER BY accessed_at ASC')
            .all() as Array<{ hash: string; size_bytes: number }>
        ).filter((row) => !victims.has(row.hash))
        for (const row of candidates) {
          if (remaining <= maxBytes) break
          victims.add(row.hash)
          bytesFreed += row.size_bytes
          remaining -= row.size_bytes
        }
      }
    }

    // Delete DB rows in a single transaction (one fsync; ON DELETE
    // CASCADE clears `output_files`) and unlink artifacts in parallel.
    // Replaces N round-trips + serialized rm with one transaction + a
    // Promise.all over the unlinks. The IN-list is chunked at 900 like
    // flushAccessed so a huge eviction stays under any build's
    // bound-parameter ceiling.
    if (dryRun) {
      const orphans = await this.orphanStats()
      return {
        evicted: victims.size,
        bytesFreed,
        orphans: orphans.orphans,
        orphanBytes: orphans.orphanBytes,
      }
    }
    if (victims.size > 0) {
      const hashes = [...victims]
      this.db.transaction(() => {
        for (let i = 0; i < hashes.length; i += 900) {
          const chunk = hashes.slice(i, i + 900)
          this.db
            .prepare(`DELETE FROM entries WHERE hash IN (${chunk.map(() => '?').join(',')})`)
            .run(...(chunk as readonly SQLQueryBindings[]))
        }
      })()
      await Promise.all(hashes.map((h) => rm(this.tarPath(h), { force: true })))
    }

    const orphans = await this.reapOrphans()
    return { evicted: victims.size, bytesFreed, ...orphans }
  }

  /**
   * Unlink artifacts the index does not know: a `<hash>.tar.zst` with no
   * `entries` row (a `SCHEMA_VERSION` drop, a `cache.db` deleted by hand)
   * and a `<hash>.tar.zst.tmp-*` a crashed save never renamed. Nothing
   * else reaps them — a lookup starts at the row, and a save of the same
   * key renames over the file, so a key that never recurs leaks its bytes
   * forever. Files younger than the grace window are left alone: a save
   * renames the artifact into place BEFORE its row commits, and its temp
   * exists while the bytes are still being written, so a fresh file
   * without a row is a save in flight, not an orphan.
   */
  private async reapOrphans(): Promise<{ orphans: number; orphanBytes: number }> {
    let orphans = 0
    let orphanBytes = 0
    await Promise.all(
      (await this.scanOrphans()).map(async (o) => {
        try {
          // unlink, not `rm({ force })`: force swallows ENOENT, and a file a
          // concurrent prune took first must not be counted as ours.
          await unlink(o.file)
          orphans += 1
          orphanBytes += o.size
        } catch {
          // Gone under us (a concurrent prune, a save's own cleanup): not ours.
        }
      }),
    )
    return { orphans, orphanBytes }
  }

  /** What `prune()` would reap right now, for `vx info` to say before anyone prunes. */
  async orphanStats(): Promise<{ orphans: number; orphanBytes: number }> {
    const found = await this.scanOrphans()
    let orphanBytes = 0
    for (const o of found) orphanBytes += o.size
    return { orphans: found.length, orphanBytes }
  }

  /** Row-less artifacts and temps past the in-flight grace window: one readdir, one stat per candidate. */
  private async scanOrphans(): Promise<Array<{ file: string; size: number }>> {
    let names: string[]
    try {
      names = await readdir(this.cacheDir)
    } catch {
      return []
    }
    const indexed = new Set(
      (this.db.prepare('SELECT hash FROM entries').all() as Array<{ hash: string }>).map(
        (r) => r.hash,
      ),
    )
    const cutoff = Date.now() - ORPHAN_GRACE_MS
    const candidates: string[] = []
    for (const name of names) {
      if (name.indexOf('.tar.zst.tmp-') > 0) {
        candidates.push(name)
      } else if (name.endsWith('.tar.zst') && !indexed.has(name.slice(0, -'.tar.zst'.length))) {
        candidates.push(name)
      }
    }
    const found: Array<{ file: string; size: number }> = []
    await Promise.all(
      candidates.map(async (name) => {
        const file = path.join(this.cacheDir, name)
        try {
          const st = await stat(file)
          if (st.isFile() && st.mtimeMs <= cutoff) found.push({ file, size: st.size })
        } catch {
          // Gone between readdir and stat: not an orphan any more.
        }
      }),
    )
    return found
  }

  close(): void {
    // Run-history retention: the runs table grows by one row per
    // executed task per invocation — a 2000-task repo accretes ~20k
    // rows in days, inflating insert and checkpoint cost forever.
    // 30 days comfortably covers `vx stats` (24 h windows) and any
    // CI-side analytics consumers. The `invocations` header table (one
    // row per `vx run`) is pruned on the SAME window — otherwise a
    // header would outlive its `runs` rows, so `vx info`/`vx last` would
    // list an invocation whose task detail is already gone, and the
    // table would grow unbounded on a long-lived checkout.
    try {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      this.history.pruneOlderThan(cutoff)
      this.configEvals.pruneOlderThan(cutoff)
    } catch {
      // Retention is best-effort; never block closing the handle.
    }
    try {
      this.flushAccessed()
    } catch {
      // Same contract as the retention prune above, which was already
      // guarded while this sibling was not: `accessed_at` is LRU
      // bookkeeping, never correctness, and the run's results are
      // already recorded by the time we get here. Letting it throw also
      // SKIPPED `db.close()` below, leaking the handle. Reachable when
      // the cache dir is removed under a live handle (a concurrent
      // `rm -rf .vx/cache`): macOS answers SQLITE_IOERR_VNODE on a
      // write to an unlinked file where Linux happily writes on.
    }
    this.db.close()
  }

  private tarPath(hash: string): string {
    return path.join(this.cacheDir, `${hash}.tar.zst`)
  }
}

function splitTaskId(id: string): [string, string] {
  const i = id.indexOf('#')
  if (i < 0) return [id, '']
  return [id.slice(0, i), id.slice(i + 1)]
}
