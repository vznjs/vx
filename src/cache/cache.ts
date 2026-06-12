// Content-addressed task cache.
//
// On-disk layout:
//   <cacheDir>/cache.db            — SQLite index (entries + runs + file_hashes)
//   <cacheDir>/<hash>.tar.zst      — per-entry artifact:
//                                      stdout    (captured stdout, always present)
//                                      outputs/  (declared output files, when any)
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
// Replace this module to plug in remote storage. The contract is:
//   key()           : derive a stable hash from a task's identity + inputs
//   get(hash, ctx?) : retrieve a previous run's metadata, or null
//   restoreOutputs  : extract the artifact's outputs/ into the project dir
//   save            : persist outputs + stdout under a hash
//   ingest          : adopt an artifact produced elsewhere (remote-hit path)
//   recordRun       : append a row to the run history table (for stats)
//   close           : release the SQLite handle

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { relPosix, xxh3 } from '../util/index.js'
import { extractOutputs, parseTarHeaders, readTarText, type TarHeader } from './tar.js'

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
const CACHE_VERSION = 'vx-cache-v21'
const SCHEMA_VERSION = 'v19'

export interface CacheKeyInput {
  taskId: string
  /**
   * Hash of the resolved task config (post-evaluation). Folds in everything
   * the user wrote — command, env declarations (passThrough names + define
   * key/value pairs), dependsOn, cache.inputs declarations, outputs — including
   * values that arrived via `import` at config-load time.
   */
  taskConfigHash: string
  /**
   * Runtime values of declared cache-input env names (from parent at hash
   * time). Independent of `exec.env`; lives here for cache identity.
   */
  envValues: Array<[name: string, value: string]>
  /** Absolute paths to input files. */
  inputFiles: string[]
  workspaceRoot: string
  /** Cache keys of upstream tasks this one depends on, sorted. */
  upstreamHashes: string[]
  /**
   * Workspace-level fingerprint — typically a hash of `pnpm-lock.yaml` +
   * `pnpm-workspace.yaml`. Folds resolved dep versions and workspace shape
   * into every task's key, so a lockfile bump invalidates everything.
   */
  workspaceFingerprint: string
  /**
   * CLI args forwarded to the task (after `--`). Folded into the key so that
   * the same command with different forwarded args is treated as a distinct
   * run, never a spurious cache hit.
   */
  forwardArgs?: readonly string[]
  /**
   * Hash of the project's `package.json` bytes. Folded into the key
   * implicitly (Turbo / Nx parity) so dep changes invalidate every
   * task in that project, even when `cache.inputs.files` doesn't
   * cover package.json. Empty string when the project has no
   * package.json (impossible in practice — workspace discovery
   * requires one — but we don't fail-loud here).
   */
  projectPackageJsonHash: string
  /**
   * Precomputed content hashes (git blob OIDs) keyed by absolute
   * path — typically the trusted-index OID map harvested by the
   * run's bulk `git ls-files -s`. Paths present here skip `hashFile`
   * entirely (no stat, no SQLite, no read); missing paths fall back
   * to `hashFile`, which computes the byte-identical blob OID from
   * disk. Pure fast path: the derived key never depends on whether a
   * hash arrived via the map or the fallback.
   */
  fileHashes?: ReadonlyMap<string, string>
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  outputFiles: string[]
  /** Captured stdout, always present (may be empty). stderr is not cached. */
  stdout: string
  /**
   * Content identity of the declared outputs: fold of every
   * `outputs/<rel>` entry's (path, bytes), or undefined when the
   * task declares no outputs. Downstream cache keys fold THIS
   * instead of the task hash when present (early cutoff): an
   * upstream that re-executes but reproduces identical outputs no
   * longer cascades misses.
   */
  outputsHash?: string
  storedAt: string
  /**
   * Where this hit was resolved from. `'local'` for a SQLite-backed
   * Cache; `'remote'` when LayeredCache pulled the artifact from the
   * remote layer this lookup (even though it's been materialized into
   * local for next time). Lets the orchestrator surface
   * `cache-hit-remote` so users see when remote caching actually saved
   * them work vs. a stale-local replay.
   */
  source?: 'local' | 'remote'
}

export interface RunRecord {
  hash: string
  project: string
  task: string
  status: 'success' | 'failed' | 'cache-hit' | 'cache-hit-remote' | 'skipped'
  exitCode: number
  durationMs: number
  forwardArgs?: readonly string[]
  startedAt: number // ms-epoch wall clock
  endedAt: number // ms-epoch wall clock
  /**
   * Optional analytics columns. Populated by the orchestrator/runner;
   * stored as NULL on rows from older runs. Surfaced via `vx stats`
   * and consumable from CI by reading cache.db directly.
   */
  runId?: string // ULID shared across every task in one `vx run` invocation
  cpuMs?: number // sum of user + system CPU time for the child process
  peakRssBytes?: number // peak resident set size of the child process
  wallclockStartNs?: bigint // hrtime span relative to run t=0
  wallclockEndNs?: bigint
  cacheHit?: boolean // convenience for flamegraph color; derivable from status
}

export interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
}

export interface PruneOptions {
  /** Drop entries last accessed before this ms-epoch threshold. */
  olderThanMs?: number
  /**
   * After applying olderThanMs, if the cache still exceeds this size in
   * bytes, evict LRU (smallest `accessed_at` first) until under it.
   */
  maxBytes?: number
}

export interface PruneResult {
  evicted: number
  bytesFreed: number
}

/**
 * Per-output-file fingerprint, scoped by the cache entry that
 * produced it. Batch-loaded once at the top of a run via
 * `loadOutputFilesBatch(hashes)` so the orchestrator's "is this
 * tree already current?" probe becomes an in-memory Map lookup
 * plus N parallel stat calls.
 *
 * `path` is project-relative (e.g. `dist/index.js`), matching how
 * outputs are addressed under `<projectDir>/`.
 */
export interface OutputFileRow {
  path: string
  size: number
  mode: number
  mtimeMs: number
}

/**
 * The shape every cache implementation honors. `Cache` (the local v10
 * implementation) and `LayeredCache` both `implements` this so the
 * orchestrator's `executeTask` can take either without a discriminated
 * union and we get a compile-time guarantee the surfaces stay congruent.
 */
/**
 * Context passed to `get()`. Optional, but required when the lookup
 * may resolve through the remote layer — the local SQL row inserted on
 * remote-hit needs `taskId` + `command` to be queryable later (the
 * artifact itself doesn't carry them). `Cache` (local) ignores this
 * field; `LayeredCache` forwards it to `Cache.ingest`.
 */
export interface CacheGetContext {
  taskId: string
  command: string
}

/** Metadata supplied at ingest time — values the artifact does not carry. */
export interface IngestMeta {
  taskId: string
  command: string
  /** Wall-clock time of the original task execution. */
  durationMs: number
}

/**
 * The supplied artifact bytes don't decompress/parse as a vx artifact.
 * Thrown by `save`/`ingest` BEFORE anything reaches the final cache
 * path — a rejected artifact leaves no `<hash>.tar.zst` and no SQL row.
 * The LayeredCache treats this as a remote fault on the remote-hit
 * path (degrades to a cache miss).
 */
export class CorruptArtifactError extends Error {
  constructor(
    public readonly hash: string,
    reason: string,
    public override readonly cause?: unknown,
  ) {
    super(`cache: corrupt artifact for ${hash}: ${reason}`)
    this.name = 'CorruptArtifactError'
  }
}

export interface CacheLayer {
  key(input: CacheKeyInput): Promise<string>
  get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  /**
   * Batched lookup of per-output-file fingerprints for many cache
   * entries in one SQL round-trip. Returns a Map keyed by entry hash.
   *
   * Orchestrator pattern: call this once at `prepareRun` for every
   * task whose hash is known up-front, then per-task `executeCachedTask`
   * does a Map.get (O(1)) + parallel stat checks to decide whether the
   * on-disk tree is already current.
   *
   * Hashes with no rows (cache misses) are absent from the result.
   */
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  /**
   * Stat each `expected` row's target under `projectDir` and return
   * `true` iff every (size, mode, mtime) matches. Missing files,
   * stat errors, or any mismatch → `false`.
   *
   * Pure FS check — no DB access. Caller batches the expected rows
   * via `loadOutputFilesBatch`. Lets the orchestrator skip
   * `cleanOutputs + restoreOutputs` entirely when the cached
   * snapshot is already in place. Integrity-preserving: detects
   * out-of-band file edits or deletions and falls through to a real
   * restore.
   */
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean>
  restoreOutputs(hash: string, projectDir: string): Promise<void>
  save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
    projectDir: string
    outputFiles: string[]
  }): Promise<string | null>
  /**
   * Adopt an artifact produced elsewhere — the remote-hit path. Writes
   * the compressed bytes to `<cacheDir>/<hash>.tar.zst`, parses the
   * tar headers to populate the `output_files` rows, and inserts the
   * `entries` row using the caller-supplied `meta`. After this returns,
   * the next `get(hash)` resolves locally.
   */
  ingest(hash: string, compressed: Uint8Array, meta: IngestMeta): Promise<void>
  recordRun(run: RunRecord): void
  /**
   * Append every run in `runs` to the history in a single SQLite
   * transaction. ~10× faster than calling `recordRun` in a loop when
   * `runs.length > ~50` (one fsync vs. N).
   */
  recordRuns(runs: readonly RunRecord[]): void
  stats(): CacheStats
  /**
   * Content-hash a file with an mtime+size fast path. If the
   * `(mtime_ms, size_bytes)` of `filePath` match a previously seen
   * row, return the stored xxh3 digest instead of re-reading the
   * bytes. Otherwise read + hash + upsert. The hash is byte-for-byte
   * identical to what a fresh content-hash would produce — pure
   * optimization, no cache-key change.
   */
  hashFile(filePath: string): Promise<string>
  /**
   * Absolute path to the on-disk outputs artifact for a hash —
   * `<cacheDir>/<hash>.tar` since v15. Returns the path whether or
   * not the artifact exists. Exposed for telemetry / dashboards;
   * `restoreOutputs` is the canonical way to materialize the bytes.
   */
  outputsPath(hash: string): string
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}

/**
 * Convenience alias for the `save()` args. Used by `LayeredCache` to
 * forward call args without redeclaring the structural shape — NOT
 * part of the conceptual cache contract; consumers should call
 * `CacheLayer.save({ ... })` directly.
 *
 * @internal
 */
export type SaveArgs = Parameters<CacheLayer['save']>[0]

interface EntryRow {
  hash: string
  project: string
  task: string
  command: string
  exit_code: number
  duration_ms: number
  size_bytes: number
  outputs_hash: string | null
  created_at: number
  accessed_at: number
}

export class Cache implements CacheLayer {
  private readonly db: Database
  private readonly insertEntry: ReturnType<Database['prepare']>
  private readonly selectEntry: ReturnType<Database['prepare']>
  private readonly bumpAccessed: ReturnType<Database['prepare']>
  private readonly insertRun: ReturnType<Database['prepare']>
  private readonly selectFileHash: ReturnType<Database['prepare']>
  private readonly upsertFileHash: ReturnType<Database['prepare']>
  private readonly insertOutputFile: ReturnType<Database['prepare']>
  private readonly deleteOutputFiles: ReturnType<Database['prepare']>
  /**
   * Single-slot stash of the most recently decompressed tar. Populated
   * by `get()`, consumed by the next matching `restoreOutputs()`. The
   * orchestrator's cache-hit path always calls these back-to-back for
   * the same hash, so a one-entry slot is enough to avoid a second
   * round of zstd decompression on every hit. Evicted on hash change,
   * cleared on close().
   */
  private decompressedTar: { hash: string; bytes: Uint8Array } | null = null
  /** Memoized repo object format for blob-OID hashing (lazy-detected). */
  private objectFormat: 'sha1' | 'sha256' | null = null

  constructor(private readonly cacheDir: string) {
    // Ensure the directory exists before opening the DB — bun:sqlite
    // won't create parent dirs for us. The constructor stays sync
    // because callers use `new Cache(...)` directly; `mkdirSync` keeps
    // that property without a subprocess fork.
    mkdirSync(cacheDir, { recursive: true })
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
    // and recreate. Outputs on disk become orphans; they'll be ignored
    // on next miss and reaped by `vx cache prune`.
    const meta = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
      | { value: string }
      | undefined
    if (meta && meta.value !== SCHEMA_VERSION) {
      this.db.exec(
        'DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS file_hashes; DROP TABLE IF EXISTS output_files;',
      )
      this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(SCHEMA_VERSION)
    } else if (!meta) {
      this.db
        .prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?)")
        .run(SCHEMA_VERSION)
    }

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
        outputs_hash TEXT,
        created_at   INTEGER NOT NULL,
        accessed_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
        cache_hit           INTEGER
      );
      CREATE INDEX IF NOT EXISTS runs_hash       ON runs(hash);
      CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS runs_project    ON runs(project, task);
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
    `)

    this.insertEntry = this.db.prepare(`
      INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, outputs_hash, created_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        outputs_hash = excluded.outputs_hash,
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
    this.insertRun = this.db.prepare(`
      INSERT INTO runs(
        hash, project, task, status, exit_code, duration_ms, forward_args,
        started_at, ended_at,
        run_id, cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns,
        cache_hit
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?)
    `)
    this.selectFileHash = this.db.prepare(
      'SELECT mtime_ms, size_bytes, content_hash FROM file_hashes WHERE path = ?',
    )
    this.upsertFileHash = this.db.prepare(`
      INSERT INTO file_hashes(path, mtime_ms, size_bytes, content_hash, seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        mtime_ms     = excluded.mtime_ms,
        size_bytes   = excluded.size_bytes,
        content_hash = excluded.content_hash,
        seen_at      = excluded.seen_at
    `)
    this.insertOutputFile = this.db.prepare(`
      INSERT INTO output_files(entry_hash, path, size_bytes, mode, mtime_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entry_hash, path) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        mode       = excluded.mode,
        mtime_ms   = excluded.mtime_ms
    `)
    this.deleteOutputFiles = this.db.prepare('DELETE FROM output_files WHERE entry_hash = ?')
  }

  /**
   * Content-hash a file (as a git blob OID, v20) with an mtime+size
   * fast path. If the `file_hashes` table has a row for `path` whose
   * `(mtime_ms, size_bytes)` match the current stat, we reuse the
   * stored content_hash (a memory + SQLite lookup, no disk read).
   * Otherwise we read + hash + upsert.
   *
   * The OID is byte-identical to what `git hash-object` (and the git
   * index) computes for the same content, so this fallback and the
   * `CacheKeyInput.fileHashes` index-OID fast path never diverge —
   * a file's key contribution can't flip across dirty↔clean
   * transitions.
   */
  async hashFile(filePath: string): Promise<string> {
    // statSync intentional: a single stat is ~1.6µs (Bun 1.3); the
    // async-stat equivalent adds ~75µs of Promise machinery per call.
    // Promise.all over the batched callers (key derivation) gives no
    // I/O parallelism benefit because the stat is faster than the
    // threadpool dispatch overhead.
    let st
    try {
      st = statSync(filePath)
    } catch {
      // Caller is responsible for skipping files that don't exist;
      // fall through to the content-hash path which will throw with
      // a more useful error.
      return await this.hashFileFromDisk(filePath)
    }
    const mtimeMs = Math.floor(st.mtimeMs)
    const size = st.size
    const row = this.selectFileHash.get(filePath) as
      | { mtime_ms: number; size_bytes: number; content_hash: string }
      | undefined
    if (row && row.mtime_ms === mtimeMs && row.size_bytes === size) {
      return row.content_hash
    }
    const ch = await this.hashFileFromDisk(filePath)
    this.upsertFileHash.run(filePath, mtimeMs, size, ch, Date.now())
    return ch
  }

  /**
   * Git blob OID of the file's bytes:
   * `hex(HASH("blob " + byteLength + "\0" + content))`, where HASH is
   * the repo's object format. Same value `git hash-object` prints and
   * the same value the index stores. Computed in-process — no git
   * spawn per file.
   */
  private async hashFileFromDisk(filePath: string): Promise<string> {
    const bytes = await Bun.file(filePath).bytes()
    const hasher = new Bun.CryptoHasher(this.objectFormat ?? this.detectObjectFormat(filePath))
    hasher.update(`blob ${bytes.byteLength}\0`)
    hasher.update(bytes)
    return hasher.digest('hex')
  }

  /**
   * Repo object format — sha1 unless the repo was created with
   * `--object-format=sha256`. One `git rev-parse` spawn per Cache
   * lifetime, and only when at least one file misses the mtime+size
   * memo. Outside a repo (unit fixtures) we default to sha1, which is
   * still a deterministic blob-OID domain.
   */
  private detectObjectFormat(nearPath: string): 'sha1' | 'sha256' {
    let detected: 'sha1' | 'sha256' = 'sha1'
    try {
      const proc = Bun.spawnSync({
        cmd: ['git', 'rev-parse', '--show-object-format'],
        cwd: path.dirname(nearPath),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (proc.exitCode === 0 && new TextDecoder().decode(proc.stdout).trim() === 'sha256') {
        detected = 'sha256'
      }
    } catch {
      // git unavailable → sha1 default keeps hashing deterministic.
    }
    this.objectFormat = detected
    return detected
  }

  async key(input: CacheKeyInput): Promise<string> {
    // Seed-chained xxHash3: each step folds one field into the
    // running digest via `xxh3(part, prevDigest)`. Equivalent to the
    // old CryptoHasher.update() pattern, no intermediate buffer.
    // Field-order matters; each line is prefixed with its label so
    // adjacent fields can't collide via concat.
    let h = xxh3(CACHE_VERSION)
    h = xxh3(`task:${input.taskId}`, h)
    h = xxh3(`workspace:${input.workspaceFingerprint}`, h)
    h = xxh3(`pkg:${input.projectPackageJsonHash}`, h)
    h = xxh3(`config:${input.taskConfigHash}`, h)

    const forwarded = input.forwardArgs ?? []
    h = xxh3(`forward-args:${forwarded.length}`, h)
    for (const a of forwarded) h = xxh3(a, h)

    h = xxh3(`env-values:${input.envValues.length}`, h)
    // \0 delimiter, not `=`: names and values may themselves contain
    // `=`, and `A` + `B=C` must never fold the same bytes as `A=B` + `C`.
    for (const [n, v] of input.envValues) h = xxh3(`${n}\0${v}`, h)

    const upstream = [...input.upstreamHashes].sort()
    h = xxh3(`upstream:${upstream.length}`, h)
    for (const u of upstream) h = xxh3(u, h)

    const sortedInputs = [...input.inputFiles].sort()
    h = xxh3(`inputs:${sortedInputs.length}`, h)
    // Per-file hash source, in preference order: the caller-supplied
    // index-OID map (clean tracked files — zero I/O), then hashFile's
    // mtime+size memo (no read), then a full in-process blob-OID
    // computation. All three produce identical bytes for identical
    // content. The fold order is locked to `sortedInputs` so results
    // are stable across runs.
    const fileHashes = await Promise.all(
      sortedInputs.map((f) => input.fileHashes?.get(f) ?? this.hashFile(f)),
    )
    for (let i = 0; i < sortedInputs.length; i++) {
      const file = sortedInputs[i]!
      const rel = relPosix(input.workspaceRoot, file)
      h = xxh3(`${rel}\0${fileHashes[i]!}`, h)
    }

    return h.toString(16).padStart(16, '0')
  }

  // ctx is accepted but ignored — the local layer reads metadata from
  // the entries row. It's part of the contract so LayeredCache can
  // route metadata to `ingest()` on remote-hit without a separate API.
  async get(hash: string, _ctx?: CacheGetContext): Promise<CacheEntry | null> {
    const row = this.selectEntry.get(hash) as EntryRow | undefined
    if (!row) return null

    // Verify the tar artifact actually exists. The DB and the
    // filesystem can drift if someone manually deletes the cache dir.
    if (!(await Bun.file(this.tarPath(hash)).exists())) return null

    this.bumpAccessed.run(Date.now(), hash)

    // Read the tar once: get the entry list AND pull `stdout` in a
    // single decompress. The decompressed bytes are stashed for the
    // matching `restoreOutputs()` call — the orchestrator's cache-hit
    // path does get→restore back-to-back for the same hash, so we
    // skip a second decompress on every hit.
    const compressed = await Bun.file(this.tarPath(hash)).bytes()
    const tarBytes = await Bun.zstdDecompress(compressed)
    this.decompressedTar = { hash, bytes: tarBytes }
    const headers = parseTarHeaders(tarBytes)
    const outputFiles = headers
      .filter((h) => h.name.startsWith('outputs/') && !h.isDir)
      .map((h) => h.name.slice('outputs/'.length))

    return {
      hash: row.hash,
      taskId: `${row.project}#${row.task}`,
      command: row.command,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      outputFiles,
      stdout: readTarText(tarBytes, headers, 'stdout'),
      ...(row.outputs_hash ? { outputsHash: row.outputs_hash } : {}),
      storedAt: new Date(row.created_at).toISOString(),
      source: 'local',
    }
  }

  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    const out = new Map<string, OutputFileRow[]>()
    if (hashes.length === 0) return out
    // Inline placeholders for an IN-list — bun:sqlite doesn't ship
    // rarray, but `IN (?, ?, …)` with N≤~999 is fast and avoids per-
    // hash select.get() overhead.
    const placeholders = hashes.map(() => '?').join(',')
    const stmt = this.db.prepare(
      `SELECT entry_hash, path, size_bytes, mode, mtime_ms FROM output_files WHERE entry_hash IN (${placeholders})`,
    )
    const rows = stmt.all(...(hashes as readonly SQLQueryBindings[])) as Array<{
      entry_hash: string
      path: string
      size_bytes: number
      mode: number
      mtime_ms: number
    }>
    for (const r of rows) {
      let list = out.get(r.entry_hash)
      if (!list) {
        list = []
        out.set(r.entry_hash, list)
      }
      list.push({ path: r.path, size: r.size_bytes, mode: r.mode, mtimeMs: r.mtime_ms })
    }
    return out
  }

  async isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean> {
    // Empty manifest case (a task produced no outputs) → trivially
    // current; the on-disk tree under projectDir is whatever it was,
    // and nothing was supposed to land there.
    if (expected.length === 0) return true
    const results = await Promise.all(
      expected.map(async (e) => {
        try {
          const s = await stat(path.join(projectDir, e.path))
          return (
            s.size === e.size &&
            (s.mode & 0o777) === (e.mode & 0o777) &&
            // mtime is restored at seconds-granularity via utimes in
            // `extractOutputs`, and that's the precision the manifest
            // stores too — compare at the same precision.
            Math.floor(s.mtimeMs / 1000) === Math.floor(e.mtimeMs / 1000)
          )
        } catch {
          return false
        }
      }),
    )
    return results.every(Boolean)
  }

  outputsPath(hash: string): string {
    return this.tarPath(hash)
  }

  async restoreOutputs(hash: string, projectDir: string): Promise<void> {
    // In-process tar extraction with optional per-file skip + slot reuse.
    //
    // Three compounding wins vs the prior subprocess `tar -xf` approach:
    //   - Reuses bytes stashed by the matching `get()` call (single
    //     decompress across the get→restore pair).
    //   - No fork+exec on the hot path (~5-10ms reclaimed per hit).
    //
    // The "tree is already current" skip-everything check happens at
    // the orchestrator level (using the batched `output_files` map),
    // BEFORE this method runs. By the time we're here we've committed
    // to a fresh extract.
    //
    // `stdout` / `stderr` entries in the archive are ignored on this
    // path — they're surfaced via `get()` for the orchestrator to
    // replay through the logger.
    let tarBytes: Uint8Array
    if (this.decompressedTar && this.decompressedTar.hash === hash) {
      tarBytes = this.decompressedTar.bytes
      this.decompressedTar = null
    } else {
      const src = this.tarPath(hash)
      if (!(await Bun.file(src).exists())) return
      const compressed = await Bun.file(src).bytes()
      tarBytes = await Bun.zstdDecompress(compressed)
    }

    const headers = parseTarHeaders(tarBytes)
    if (!headers.some((h) => h.name.startsWith('outputs/'))) return

    await extractOutputs(tarBytes, projectDir)
  }

  async save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
    projectDir: string
    outputFiles: string[]
  }): Promise<string | null> {
    // Layout (v17): one `<hash>.tar.zst` per entry. Tar carries ONLY
    // the things you'd want to re-materialize on a cache hit:
    //
    //   stdout            — captured stdout (ALWAYS present, may be empty)
    //   outputs/<rel>     — declared output files (omitted when none)
    //
    // Metadata (command, exitCode, durationMs, storedAt) lives in
    // SQLite, not the artifact. Remote-hit ingestion takes metadata
    // through `ingest()` arguments — the artifact stays clean bytes.
    const compressed = await this.packArtifact(args)
    return this.writeArtifactAndIndex(args.hash, compressed, {
      taskId: args.entry.taskId,
      command: args.entry.command,
      durationMs: args.entry.durationMs,
    })
  }

  async ingest(hash: string, compressed: Uint8Array, meta: IngestMeta): Promise<void> {
    // Return value (outputs hash) intentionally dropped: remote-hit
    // ingestion happens inside get(), which re-reads the entry row.
    void (await this.writeArtifactAndIndex(hash, compressed, meta))
  }

  /**
   * Stage stdout + outputs, tar them, zstd-compress, return the bytes.
   * No disk write to the final cache path — that's the index step's
   * job. Pure transform, so `ingest()` can skip this and just hand its
   * remote-supplied bytes straight to `writeArtifactAndIndex`.
   */
  private async packArtifact(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
    projectDir: string
    outputFiles: string[]
  }): Promise<Uint8Array> {
    const stage = await mkdtemp(path.join(os.tmpdir(), 'vx-save-'))
    try {
      if (args.outputFiles.length > 0) {
        const stageOutputs = path.join(stage, 'outputs')
        await Promise.all(
          args.outputFiles.map(async (f) => {
            const rel = path.relative(args.projectDir, f)
            const dest = path.join(stageOutputs, rel)
            // Bun.write creates parent dirs as needed.
            await Bun.write(dest, Bun.file(f))
          }),
        )
      }
      // stdout is ALWAYS present in the artifact, even if empty, so the
      // archive layout is predictable: a successful read finds `stdout`
      // and zero-or-more `outputs/<rel>` entries.
      await Bun.write(path.join(stage, 'stdout'), args.entry.stdout ?? '')

      const topLevel: string[] = ['stdout']
      if (args.outputFiles.length > 0) topLevel.unshift('outputs')

      // `--format=ustar` forces strict POSIX ustar — no PAX extended-
      // header records. BSD tar (macOS default) emits PAX per entry
      // by default for xattrs / mtime-nanos; those records would
      // otherwise show up as junk `PaxHeaders/<name>` entries in our
      // restored trees. GNU tar also accepts the flag (no-op on its
      // side). Names > 100 chars still work via ustar's prefix+name
      // (255 chars) or GNU longname fallback if the tar binary
      // chooses to emit one.
      const proc = Bun.spawn(['tar', '--format=ustar', '-cf', '-', '-C', stage, ...topLevel], {
        stdout: 'pipe',
        stderr: 'pipe',
        // COPYFILE_DISABLE blocks Apple's copyfile() from attaching
        // xattrs to staged files via inherited child copies; tar then
        // has nothing to emit AppleDouble for.
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      })
      const [tarBytes, stderrText] = await Promise.all([
        new Response(proc.stdout).bytes(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      if (proc.exitCode !== 0) {
        throw new Error(`save: tar exited ${proc.exitCode}: ${stderrText.trim()}`)
      }
      return await Bun.zstdCompress(tarBytes)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  /**
   * Atomically write `compressed` to `<hash>.tar.zst` and (re)build
   * the entries + output_files SQL rows from the tar headers. Shared
   * by `save()` (we just packed the bytes) and `ingest()` (we got
   * them from the remote layer).
   */
  private async writeArtifactAndIndex(
    hash: string,
    compressed: Uint8Array,
    meta: IngestMeta,
  ): Promise<string | null> {
    // Validate BEFORE anything touches the final path. `ingest()` feeds
    // us network bytes; a truncated/garbage body that went live first
    // would leave a corrupt `<hash>.tar.zst` behind (with no SQL row,
    // since the decompress throw aborted indexing) for every later
    // reader to trip over. Decompress + parse also produce the
    // `output_files` rows: same headers extractOutputs will see on
    // restore, so the size/mode/mtime fingerprint we store matches
    // what isOutputsCurrent will compare against post-restore.
    let tarBytes: Uint8Array
    try {
      tarBytes = await Bun.zstdDecompress(compressed)
    } catch (err) {
      throw new CorruptArtifactError(hash, 'zstd decompression failed', err)
    }
    const headers = parseTarHeaders(tarBytes)
    // v17 invariant: every artifact carries a `stdout` entry. Its
    // absence means the bytes decompressed but aren't a vx artifact.
    if (!headers.some((h) => h.name === 'stdout' && !h.isDir)) {
      throw new CorruptArtifactError(hash, 'missing stdout entry')
    }

    const finalPath = this.tarPath(hash)
    // tmp suffix mixes pid + hrtime + a random hex chunk so two saves
    // of the same hash from the same process (or from two forked
    // workers that happen to share a wall-clock ms) don't pick the
    // same tmp filename and race on the rename.
    const tmpPath = `${finalPath}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2, 10)}`
    await mkdir(this.cacheDir, { recursive: true })
    await Bun.write(tmpPath, compressed)
    // POSIX rename atomically REPLACES the destination if it exists,
    // so we don't need a pre-rm. The pre-rm was actively harmful —
    // it opened a race window where writer B could delete writer A's
    // just-renamed file BEFORE A's subsequent stat, producing a
    // spurious ENOENT. The rename itself preserves the "either-or"
    // semantics for concurrent readers.
    await rename(tmpPath, finalPath)

    const totalBytes = compressed.byteLength
    const outputFileRows: Array<[string, number, number, number]> = []
    // Early-cutoff identity: fold (rel, bytes) of every output entry,
    // sorted by path so the fold is independent of tar member order.
    // Header mtimes deliberately do NOT participate — a rebuild that
    // reproduces identical bytes must produce the same identity.
    const outputEntries: TarHeader[] = []
    for (const h of headers) {
      if (!h.name.startsWith('outputs/') || h.isDir) continue
      const rel = h.name.slice('outputs/'.length)
      if (rel.length === 0) continue
      outputFileRows.push([rel, h.size, h.mode & 0o777, Math.floor(h.mtimeMs)])
      outputEntries.push(h)
    }
    let outputsHash: string | null = null
    if (outputEntries.length > 0) {
      outputEntries.sort((a, b) => (a.name < b.name ? -1 : 1))
      let oh = xxh3('outputs-content:v1')
      for (const h of outputEntries) {
        oh = xxh3(`${h.name}\0`, oh)
        oh = xxh3(tarBytes.subarray(h.dataOffset, h.dataOffset + h.size), oh)
      }
      outputsHash = oh.toString(16).padStart(16, '0')
    }

    const [project, task] = splitTaskId(meta.taskId)
    const now = Date.now()

    // One transaction for the entries row + every output_files row.
    // One fsync regardless of output-file count.
    const insertEntry = this.insertEntry
    const insertOutputFile = this.insertOutputFile
    const deleteOutputFiles = this.deleteOutputFiles
    const tx = this.db.transaction(() => {
      insertEntry.run(
        hash,
        project,
        task,
        meta.command,
        0, // exitCode: we never cache failures
        meta.durationMs,
        totalBytes,
        outputsHash,
        now,
        now,
      )
      // Replace the entry's existing output_files rows (an UPDATE on
      // the same hash should refresh, not append).
      deleteOutputFiles.run(hash)
      for (const [rel, size, mode, mtime] of outputFileRows) {
        insertOutputFile.run(hash, rel, size, mode, mtime)
      }
    })
    tx()
    return outputsHash
  }

  recordRun(run: RunRecord): void {
    this.insertRun.run(...bindRun(run))
  }

  recordRuns(runs: readonly RunRecord[]): void {
    if (runs.length === 0) return
    if (runs.length === 1) {
      this.insertRun.run(...bindRun(runs[0]!))
      return
    }
    // `bun:sqlite`'s `transaction()` returns a callable that wraps the
    // body in BEGIN/COMMIT, fsyncing once at the end. For a 200-task
    // run that's one fsync instead of 200.
    const insert = this.insertRun
    const tx = this.db.transaction((batch: readonly RunRecord[]) => {
      for (const r of batch) insert.run(...bindRun(r))
    })
    tx(runs)
  }

  stats(): CacheStats {
    const aggregate = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM entries')
      .get() as { n: number; bytes: number }
    const since = Date.now() - 24 * 60 * 60 * 1000
    const runs = this.db
      .prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END), 0) AS hits FROM runs WHERE started_at >= ?",
      )
      .get(since) as { total: number; hits: number }
    return {
      entryCount: aggregate.n,
      totalBytes: aggregate.bytes,
      runCountLast24h: runs.total,
      hitCountLast24h: runs.hits,
    }
  }

  async prune(options: PruneOptions): Promise<PruneResult> {
    const { olderThanMs, maxBytes } = options
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
        const candidates = (
          victims.size === 0
            ? (this.db
                .prepare('SELECT hash, size_bytes FROM entries ORDER BY accessed_at ASC')
                .all() as Array<{ hash: string; size_bytes: number }>)
            : (this.db
                .prepare(
                  `SELECT hash, size_bytes FROM entries WHERE hash NOT IN (${[...victims].map(() => '?').join(',')}) ORDER BY accessed_at ASC`,
                )
                .all(...[...victims]) as Array<{ hash: string; size_bytes: number }>)
        ) satisfies Array<{ hash: string; size_bytes: number }>
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
    // Promise.all over the unlinks.
    if (victims.size > 0) {
      const hashes = [...victims]
      const placeholders = hashes.map(() => '?').join(',')
      const stmt = this.db.prepare(`DELETE FROM entries WHERE hash IN (${placeholders})`)
      this.db.transaction(() => {
        stmt.run(...(hashes as readonly SQLQueryBindings[]))
      })()
      await Promise.all(hashes.map((h) => rm(this.tarPath(h), { force: true })))
    }

    return { evicted: victims.size, bytesFreed }
  }

  close(): void {
    this.decompressedTar = null
    this.db.close()
  }

  private tarPath(hash: string): string {
    return path.join(this.cacheDir, `${hash}.tar.zst`)
  }
}

/**
 * Bind a RunRecord to the positional parameters expected by the
 * `insertRun` prepared statement (17 columns). Shared between the
 * single and batched record paths.
 */
function bindRun(run: RunRecord): SQLQueryBindings[] {
  return [
    run.hash,
    run.project,
    run.task,
    run.status,
    run.exitCode,
    run.durationMs,
    run.forwardArgs ? JSON.stringify(run.forwardArgs) : null,
    run.startedAt,
    run.endedAt,
    run.runId ?? null,
    run.cpuMs ?? null,
    run.peakRssBytes ?? null,
    run.wallclockStartNs !== undefined ? run.wallclockStartNs : null,
    run.wallclockEndNs !== undefined ? run.wallclockEndNs : null,
    run.cacheHit === undefined ? null : run.cacheHit ? 1 : 0,
  ]
}

function splitTaskId(id: string): [string, string] {
  const i = id.indexOf('#')
  if (i < 0) return [id, '']
  return [id.slice(0, i), id.slice(i + 1)]
}
