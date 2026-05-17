// Content-addressed task cache, v15 (xxh3 keys, tar.zst artifact) / v15 (schema).
//
// On-disk layout:
//   <cacheDir>/cache.db            — SQLite index (entries + runs + file_hashes)
//   <cacheDir>/<hash>.tar.zst      — per-entry artifact: outputs/ + (optional)
//                                    stdout + (optional) stderr
//
// SQLite holds the index — hash, project, task, command, exitCode,
// durationMs, sizeBytes, timestamps. The artifact is a pure dump of
// the run's outputs and captured streams. stdout/stderr live in the
// artifact (not the DB) so a remote pull round-trip carries them
// with the bytes.
//
// Replace this module to plug in remote storage. The contract is:
//   key()           : derive a stable hash from a task's identity + inputs
//   get(hash)       : retrieve a previous run's metadata, or null
//   restoreOutputs  : extract the artifact's outputs/ into the project dir
//   save            : persist outputs + stdout/stderr under a hash
//   recordRun       : append a row to the run history table (for stats)
//   close           : release the SQLite handle

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { xxh3, xxh3hex, xxh3hexOf } from '../util/hash.js'
import { relPosix } from '../util/paths.js'
import { extractOutputs, parseTarHeaders, readTarText } from './tar.js'

// v15: cache-key hash swapped from SHA-256 to xxHash3 (~5× faster,
// 16-hex keys, Turbo parity on width). Schema also bumps to v15:
// `file_hashes.sha256` column renamed to `content_hash`; the
// migration path DROPs stale tables before CREATE TABLE IF NOT
// EXISTS so column renames take effect on existing DBs. stdout/stderr
// continue to live in the `<hash>.tar.zst` artifact (from v14), as
// `stdout` / `stderr` entries only when non-empty. Output files live
// inside the tar under `outputs/`. Empty tasks produce an empty
// archive. The entries table remains the queryable index.
const CACHE_VERSION = 'vx-cache-v15'
// v16: dropped manifest.json from the tar artifact; output-file
// fingerprints (size, mode, mtime) now live in the SQLite
// `output_files` table, batch-loaded once at the top of a run. Lets
// the orchestrator probe "is this entry's tree already current?"
// via a Map lookup + N stats — no zstd decompress, no tar I/O, no
// JSON parse on the warm-cache-hit path.
const SCHEMA_VERSION = 'v16'

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
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  outputFiles: string[]
  stdout: string
  stderr: string
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
  bytesUploaded?: number // remote-cache push size; null if no remote layer
  bytesDownloaded?: number // remote-cache pull size on hit
}

export interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
}

/**
 * Per-task aggregates pulled from the `runs` table for ETA + progress
 * estimation in the TUI / dashboards. Capped at 50 most-recent rows
 * per `(project, task)`; `recent` is the top 10 for live-rendering.
 */
export interface TaskHistoryRow {
  runs: number
  avgMs: number
  p50Ms: number
  p99Ms: number
  successRate: number
  hitRate: number
  recent: { startedAt: number; durationMs: number; status: string; hash: string }[]
}

/** Keyed by `${project}#${task}`. Missing keys = never-run-before task. */
export type TaskHistoryMap = Map<string, TaskHistoryRow>

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
 * Metadata-only view of a cache entry — the SQL columns, without the
 * tar artifact's stdout/stderr/outputFiles. Returned by `getMetaBatch`
 * for fast bulk cache-hit probing: no zstd decompress, no tar header
 * parse. Callers that need the artifact body call `restoreOutputs`
 * afterwards. Nx's `cache.ts:getBatch` pattern, scoped to the
 * metadata layer.
 */
export interface CacheEntryMeta {
  hash: string
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  storedAt: string
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
export interface CacheLayer {
  key(input: CacheKeyInput): Promise<string>
  get(hash: string): Promise<CacheEntry | null>
  /**
   * Batched metadata-only probe. Returns a Map keyed by hash holding
   * `CacheEntryMeta` for every input hash that resolved to a local
   * hit. Skips the tar decompress that `get()` does — call
   * `restoreOutputs` afterwards if the artifact body is needed.
   *
   * One SQL query (rarray) covers all hashes; the artifact-existence
   * check still walks `Bun.file(...).exists()` per hit but does so in
   * parallel via `Promise.all`. For orchestrator hot-path use: build
   * the list of leaf-task hashes upfront, batch-probe, dispatch only
   * the misses to the scheduler's exec path.
   */
  getMetaBatch(hashes: readonly string[]): Promise<Map<string, CacheEntryMeta>>
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
  }): Promise<void>
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
  /**
   * Batched lookup of per-`(project, task)` aggregates over the most
   * recent 50 runs per pair. One SQL transaction; cheap enough to run
   * unconditionally at `runStart`.
   */
  getTaskHistory(taskIds: readonly string[]): TaskHistoryMap
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
  /**
   * Single-slot stash of the most recently decompressed tar. Populated
   * by `get()`, consumed by the next matching `restoreOutputs()`. The
   * orchestrator's cache-hit path always calls these back-to-back for
   * the same hash, so a one-entry slot is enough to avoid a second
   * round of zstd decompression on every hit. Evicted on hash change,
   * cleared on close().
   */
  private decompressedTar: { hash: string; bytes: Uint8Array } | null = null

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
        cache_hit           INTEGER,
        bytes_uploaded      INTEGER,
        bytes_downloaded    INTEGER
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
      INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, created_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
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
        cache_hit, bytes_uploaded, bytes_downloaded
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?)
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
  }

  /**
   * Content-hash a file with an mtime+size fast path. If the
   * `file_hashes` table has a row for `path` whose `(mtime_ms,
   * size_bytes)` match the current stat, we reuse the stored
   * content_hash (a memory + SQLite lookup, no disk read). Otherwise
   * we read + hash + upsert.
   *
   * This produces the exact same hash a fresh content-hash would, so
   * the cache key derivation is unchanged. Pure performance win.
   */
  async hashFile(filePath: string): Promise<string> {
    let stat
    try {
      stat = statSync(filePath)
    } catch {
      // Caller is responsible for skipping files that don't exist;
      // fall through to the content-hash path which will throw with
      // a more useful error.
      return await hashFileFromDisk(filePath)
    }
    const mtimeMs = Math.floor(stat.mtimeMs)
    const size = stat.size
    const row = this.selectFileHash.get(filePath) as
      | { mtime_ms: number; size_bytes: number; content_hash: string }
      | undefined
    if (row && row.mtime_ms === mtimeMs && row.size_bytes === size) {
      return row.content_hash
    }
    const ch = await hashFileFromDisk(filePath)
    this.upsertFileHash.run(filePath, mtimeMs, size, ch, Date.now())
    return ch
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
    for (const [n, v] of input.envValues) h = xxh3(`${n}=${v}`, h)

    const upstream = [...input.upstreamHashes].sort()
    h = xxh3(`upstream:${upstream.length}`, h)
    for (const u of upstream) h = xxh3(u, h)

    const sortedInputs = [...input.inputFiles].sort()
    h = xxh3(`inputs:${sortedInputs.length}`, h)
    // Hash in parallel via the mtime+size fast-path. Unchanged files
    // reuse the stored content_hash (no disk read); changed/new files
    // do the full content hash and upsert. The fold order is locked
    // to `sortedInputs` so results are stable across runs.
    const fileHashes = await Promise.all(sortedInputs.map((f) => this.hashFile(f)))
    for (let i = 0; i < sortedInputs.length; i++) {
      const file = sortedInputs[i]!
      const rel = relPosix(input.workspaceRoot, file)
      h = xxh3(`${rel}\0${fileHashes[i]!}`, h)
    }

    return xxh3hexOf(h)
  }

  async get(hash: string): Promise<CacheEntry | null> {
    const row = this.selectEntry.get(hash) as EntryRow | undefined
    if (!row) return null

    // Verify the tar artifact actually exists. The DB and the
    // filesystem can drift if someone manually deletes the cache dir.
    if (!(await Bun.file(this.tarPath(hash)).exists())) return null

    this.bumpAccessed.run(Date.now(), hash)

    // Read the tar once: get the entry list AND pull `stdout`/`stderr`
    // contents (if present) in a single decompress. The decompressed
    // bytes are stashed for the matching `restoreOutputs()` call —
    // the orchestrator's cache-hit path does get→restore back-to-back
    // so we skip a second decompress on every hit. Manifest entries
    // are ignored here — they're consumed by `restoreOutputs()`.
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
      stderr: readTarText(tarBytes, headers, 'stderr'),
      storedAt: new Date(row.created_at).toISOString(),
      source: 'local',
    }
  }

  async getMetaBatch(hashes: readonly string[]): Promise<Map<string, CacheEntryMeta>> {
    // Single SQL query for all hashes (rarray virtual table via
    // bun:sqlite's `IN (?)` with a JSON array — bun:sqlite accepts
    // arrays as bind args via the array-binding form). Avoids N
    // prepared-statement round-trips.
    const out = new Map<string, CacheEntryMeta>()
    if (hashes.length === 0) return out
    // Inline placeholders — bun:sqlite doesn't ship an rarray extension
    // by default, but a `WHERE hash IN (?, ?, ?, …)` for N ≤ ~999
    // hashes is fast and avoids per-hash select.get() overhead.
    const placeholders = hashes.map(() => '?').join(',')
    const stmt = this.db.prepare(`SELECT * FROM entries WHERE hash IN (${placeholders})`)
    const rows = stmt.all(...(hashes as readonly SQLQueryBindings[])) as EntryRow[]
    // Verify the on-disk artifact for each row in parallel. Skip the
    // expensive zstd decompress — callers only need the metadata at
    // this stage. The tar body gets read on the eventual
    // `restoreOutputs(hash, ...)` call (or not at all on cache miss).
    const verifyResults = await Promise.all(
      rows.map(async (row) => ({
        row,
        exists: await Bun.file(this.tarPath(row.hash)).exists(),
      })),
    )
    const now = Date.now()
    const verified: EntryRow[] = []
    for (const { row, exists } of verifyResults) {
      if (!exists) continue
      verified.push(row)
      out.set(row.hash, {
        hash: row.hash,
        taskId: `${row.project}#${row.task}`,
        command: row.command,
        exitCode: row.exit_code,
        durationMs: row.duration_ms,
        storedAt: new Date(row.created_at).toISOString(),
      })
    }
    // Batch the accessed_at bump too — one transaction vs N.
    if (verified.length > 0) {
      const tx = this.db.transaction((items: EntryRow[]) => {
        for (const r of items) this.bumpAccessed.run(now, r.hash)
      })
      tx(verified)
    }
    return out
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
  }): Promise<void> {
    // Layout (v15): one `<hash>.tar.zst` per entry. Tar carries ONLY
    // the things you'd want to re-materialize on a cache hit:
    //
    //   outputs/<rel>     — declared output files (omitted entirely
    //                       when args.outputFiles is empty)
    //   stdout            — captured stdout (omitted when empty)
    //   stderr            — captured stderr (omitted when empty)
    //
    // If a task has no outputs and produced no stdout/stderr, the
    // archive is essentially empty (~ a few bytes of zstd framing).
    // Metadata about the entry — command, exit code, duration —
    // lives in the SQLite entries row, not the artifact.
    //
    // We write to a `.tmp` sibling and rename atomically so a
    // concurrent reader sees either no entry or a complete one.
    // The tmp suffix mixes pid + hrtime + a random hex chunk so two
    // saves of the same hash from the same process (or from two
    // forked workers that happen to share a wall-clock ms) don't
    // pick the same tmp filename and race on the rename.
    const finalPath = this.tarPath(args.hash)
    const tmpPath = `${finalPath}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2, 10)}`
    await mkdir(this.cacheDir, { recursive: true })

    // Stage stdout / stderr / outputs into a temp dir, then tar the
    // contents. Stage paths mirror the final tar layout one-to-one.
    const stage = await mkdtemp(path.join(os.tmpdir(), 'vx-save-'))
    const outputFileRows: Array<[string, number, number, number]> = []
    try {
      if (args.outputFiles.length > 0) {
        const stageOutputs = path.join(stage, 'outputs')
        const writes = args.outputFiles.map(async (f) => {
          const rel = path.relative(args.projectDir, f)
          const dest = path.join(stageOutputs, rel)
          // Bun.write creates parent dirs as needed.
          await Bun.write(dest, Bun.file(f))
        })
        await Promise.all(writes)
        // Stat the STAGED files (not the originals) — those bytes
        // are what go into the tar, and tar's stored mtime is the
        // staged file's mtime truncated to seconds. extractOutputs
        // restores files with that same tar-stored mtime, so
        // recording the staged file's mtime here makes the saved
        // fingerprint match what isOutputsCurrent will compare
        // against post-restore.
        const stagedStats = await Promise.all(
          args.outputFiles.map((f) => {
            const rel = path.relative(args.projectDir, f)
            return stat(path.join(stageOutputs, rel))
          }),
        )
        for (let i = 0; i < args.outputFiles.length; i++) {
          const rel = path.relative(args.projectDir, args.outputFiles[i]!).split(path.sep).join('/')
          const s = stagedStats[i]!
          outputFileRows.push([rel, s.size, s.mode & 0o777, Math.floor(s.mtimeMs)])
        }
      }
      if (args.entry.stdout && args.entry.stdout.length > 0) {
        await Bun.write(path.join(stage, 'stdout'), args.entry.stdout)
      }
      if (args.entry.stderr && args.entry.stderr.length > 0) {
        await Bun.write(path.join(stage, 'stderr'), args.entry.stderr)
      }

      // List the top-level entries we just staged so tar emits them
      // with names like `outputs/...` / `stdout` / `stderr` — no
      // leading `./` prefix that would break the restore's entry-name
      // matching. (v16 dropped `manifest.json` — output-file
      // fingerprints live in the SQLite `output_files` table now.)
      const topLevel: string[] = []
      if (args.outputFiles.length > 0) topLevel.push('outputs')
      if (args.entry.stdout && args.entry.stdout.length > 0) topLevel.push('stdout')
      if (args.entry.stderr && args.entry.stderr.length > 0) topLevel.push('stderr')

      let tarBytes: Uint8Array
      if (topLevel.length === 0) {
        // Empty archive — task produced no outputs and no captured
        // logs. Tar requires at least one entry, so build a two-block
        // zero-padded EOF manually (the on-disk shape of an empty tar).
        tarBytes = new Uint8Array(1024)
      } else {
        // `--format=ustar` forces strict POSIX ustar — no PAX
        // extended-header records. BSD tar (macOS default) emits PAX
        // per entry by default for xattrs / mtime-nanos; those
        // records would otherwise show up as junk `PaxHeaders/<name>`
        // entries in our restored trees. GNU tar also accepts the
        // flag (no-op on its side, since it defaults to GNU format
        // which already avoids PAX). Names > 100 chars still work
        // via ustar's prefix+name (255 chars) or via GNU longname
        // fallback if the tar binary chooses to emit one.
        const proc = Bun.spawn(['tar', '--format=ustar', '-cf', '-', '-C', stage, ...topLevel], {
          stdout: 'pipe',
          stderr: 'pipe',
          // COPYFILE_DISABLE blocks Apple's copyfile() from
          // attaching xattrs to staged files via inherited child
          // copies; tar then has nothing to emit AppleDouble for.
          env: { ...process.env, COPYFILE_DISABLE: '1' },
        })
        const [bytes, stderrText] = await Promise.all([
          new Response(proc.stdout).bytes(),
          new Response(proc.stderr).text(),
        ])
        await proc.exited
        if (proc.exitCode !== 0) {
          throw new Error(`save: tar exited ${proc.exitCode}: ${stderrText.trim()}`)
        }
        tarBytes = bytes
      }
      const compressed = await Bun.zstdCompress(tarBytes)
      await Bun.write(tmpPath, compressed)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }

    // POSIX rename atomically REPLACES the destination if it exists,
    // so we don't need a pre-rm. The pre-rm was actively harmful —
    // it opened a race window where writer B could delete writer A's
    // just-renamed file BEFORE A's subsequent stat, producing a
    // spurious ENOENT. The rename itself preserves the "either-or"
    // semantics for concurrent readers.
    await rename(tmpPath, finalPath)

    const totalBytes = (await stat(finalPath)).size

    const [project, task] = splitTaskId(args.entry.taskId)
    const now = Date.now()

    // One transaction for the entries row + every output_files row.
    // One fsync regardless of output-file count.
    const insertEntry = this.insertEntry
    const insertOutputFile = this.insertOutputFile
    const hash = args.hash
    const tx = this.db.transaction(() => {
      insertEntry.run(
        hash,
        project,
        task,
        args.entry.command,
        args.entry.exitCode,
        args.entry.durationMs,
        totalBytes,
        now,
        now,
      )
      // Replace the entry's existing output_files rows (an UPDATE
      // on the same hash should refresh, not append).
      this.db.prepare('DELETE FROM output_files WHERE entry_hash = ?').run(hash)
      for (const [rel, size, mode, mtime] of outputFileRows) {
        insertOutputFile.run(hash, rel, size, mode, mtime)
      }
    })
    tx()
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

  getTaskHistory(taskIds: readonly string[]): TaskHistoryMap {
    const out: TaskHistoryMap = new Map()
    if (taskIds.length === 0) return out

    // Decompose `${project}#${task}` once. Skip malformed ids defensively.
    const pairs: { project: string; task: string; key: string }[] = []
    for (const id of taskIds) {
      const i = id.indexOf('#')
      if (i < 0) continue
      pairs.push({ project: id.slice(0, i), task: id.slice(i + 1), key: id })
    }
    if (pairs.length === 0) return out

    // SQLite doesn't allow tuple IN (?, ?) parameter binding, so we
    // build a `(project, task) IN (VALUES (?, ?), (?, ?), ...)` clause
    // for the row-fetch query; the per-pair fanout for aggregates uses
    // a CTE-based window function to cap at 50 rows per pair.
    const placeholders = pairs.map(() => '(?, ?)').join(', ')
    const bindings: string[] = []
    for (const p of pairs) {
      bindings.push(p.project, p.task)
    }

    // Pull the 50 most-recent rows per (project, task). We do the
    // aggregation client-side (cheap; ≤ 50 × N rows) so we avoid
    // depending on SQLite extensions for percentile_cont.
    const rows = this.db
      .prepare(
        `
        WITH ranked AS (
          SELECT project, task, started_at, ended_at, duration_ms, status, hash, cache_hit,
                 ROW_NUMBER() OVER (
                   PARTITION BY project, task
                   ORDER BY started_at DESC
                 ) AS rn
            FROM runs
           WHERE (project, task) IN (VALUES ${placeholders})
        )
        SELECT project, task, started_at, duration_ms, status, hash, cache_hit
          FROM ranked
         WHERE rn <= 50
         ORDER BY project, task, started_at DESC
        `,
      )
      .all(...bindings) as Array<{
      project: string
      task: string
      started_at: number
      duration_ms: number
      status: string
      hash: string
      cache_hit: number | null
    }>

    // Group rows in-order (the SQL ORDER BY guarantees per-key
    // contiguity, and within each key newest-first).
    type Row = (typeof rows)[number]
    const grouped = new Map<string, Row[]>()
    for (const r of rows) {
      const key = `${r.project}#${r.task}`
      let bucket = grouped.get(key)
      if (!bucket) {
        bucket = []
        grouped.set(key, bucket)
      }
      bucket.push(r)
    }

    for (const [key, bucket] of grouped) {
      const runs = bucket.length
      let sum = 0
      let successes = 0
      let hits = 0
      const sortedDurations: number[] = []
      for (const r of bucket) {
        sum += r.duration_ms
        if (r.status === 'success' || r.status === 'cache-hit' || r.status === 'cache-hit-remote') {
          successes++
        }
        if (r.cache_hit === 1) hits++
        sortedDurations.push(r.duration_ms)
      }
      sortedDurations.sort((a, b) => a - b)
      const p = (q: number): number => {
        if (sortedDurations.length === 0) return 0
        const idx = Math.min(
          sortedDurations.length - 1,
          Math.floor(q * (sortedDurations.length - 1)),
        )
        return sortedDurations[idx] ?? 0
      }

      out.set(key, {
        runs,
        avgMs: sum / runs,
        p50Ms: p(0.5),
        p99Ms: p(0.99),
        successRate: successes / runs,
        hitRate: hits / runs,
        recent: bucket.slice(0, 10).map((r) => ({
          startedAt: r.started_at,
          durationMs: r.duration_ms,
          status: r.status,
          hash: r.hash,
        })),
      })
    }

    return out
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

    // Perform the deletions: DB row + on-disk tar.
    const deleteEntry = this.db.prepare('DELETE FROM entries WHERE hash = ?')
    for (const hash of victims) {
      deleteEntry.run(hash)
      await rm(this.tarPath(hash), { force: true })
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
    run.bytesUploaded ?? null,
    run.bytesDownloaded ?? null,
  ]
}

function splitTaskId(id: string): [string, string] {
  const i = id.indexOf('#')
  if (i < 0) return [id, '']
  return [id.slice(0, i), id.slice(i + 1)]
}

async function hashFileFromDisk(filePath: string): Promise<string> {
  // Bun.hash.xxHash3 has no streaming API, so we load the whole file.
  // Input files are source code (typically < 1MB each); the memory
  // hit is bounded and the ~5× throughput win vs sha256-streaming
  // dominates on a cache-warm path that hashes hundreds of them.
  const bytes = await Bun.file(filePath).bytes()
  return xxh3hex(bytes)
}
