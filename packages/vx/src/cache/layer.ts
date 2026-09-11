// The cache layer CONTRACT and its records — what every cache implementation
// honours (`Cache`, `LayeredCache`, `ChainedCache`, a plugin's remote layer) and
// the shapes that cross it: the key input, entries, run-history rows, output
// fingerprints, stats, prune options. No implementation lives here; the one
// reference to `Cache` below is a type (the local handle a layer may wrap).

import type { Cache } from './cache.js'

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
  /**
   * Resolved `cache.inputs.runtime` commands as [command, output] pairs
   * (output = trimmed stdout+stderr, resolved live at hash time). Folded
   * into the key in a namespace distinct from workspaceRuntimeValues.
   */
  runtimeValues?: Array<[command: string, output: string]>
  /** Resolved `cache.inputs.workspaceRuntime` pairs (root-cwd commands). */
  workspaceRuntimeValues?: Array<[command: string, output: string]>
  /** Absolute paths to input files. */
  inputFiles: string[]
  workspaceRoot: string
  /** Cache keys of upstream tasks this one depends on, sorted. */
  upstreamHashes: string[]
  /**
   * Upstream hash → upstream task id, for `captureInto` row NAMING only.
   * Never folded into the digest — the key already folds the sorted
   * hashes. Lets the persisted `entry_inputs` row name which upstream
   * task a hash came from (the diff reads better than a bare hash). When
   * absent, the captured `upstream` row falls back to `name = hash`.
   */
  upstreamIds?: ReadonlyMap<string, string>
  /**
   * The task's DEPENDENCY closure with GROUP tasks expanded into the real
   * tasks they stand for — what an input-shipping executor must place in the
   * input root. A different question from what the key folds, and derived
   * differently in both directions:
   *
   * - It expands groups, which contribute a synthetic roll-up hash and no
   *   outputs of their own, so a dependent of one would otherwise describe
   *   an empty closure.
   * - It ignores `cache.inputs.tasks`. That filter says which upstream KEYS
   *   this task's key folds; what the task may READ is `dependsOn`, and
   *   locally every dependency's outputs are on disk before the command runs
   *   however the filter is written.
   *
   * NEVER folded into the digest — the key cascades through a group's own
   * roll-up hash already, and folding either difference in would move every
   * existing dependent's key without telling it anything new.
   */
  upstreamGraft?: ReadonlyArray<{
    readonly taskId: string
    readonly hash: string
    readonly projectDir: string
  }>
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
  /**
   * Material a plugin's `key` stage contributed, as sorted `[name, value]`
   * pairs. Folded only when non-empty, so a workspace without a key plugin
   * derives exactly the key it always did.
   */
  pluginParts?: ReadonlyArray<readonly [name: string, value: string]>
  /**
   * When set, `key()` pushes each component (kind, name, hash) it folds
   * — at the same fold sites, in fold order. Pure SIDE-CHANNEL: it does
   * not change the returned digest in any way. On a cache MISS the
   * orchestrator allocates an array, passes it here, and persists the
   * rows to `entry_inputs` (inside the entry-save transaction) so a
   * later run can diff its inputs against this one (the Tier-3 "why did
   * this re-run?" moat). Capturing at the fold sites keeps the
   * recorded set in lockstep with the key by construction: a future
   * component that forgets to capture is a one-line miss, not silent
   * drift. The per-file OIDs are already awaited here, so file rows cost
   * zero extra I/O — just array pushes.
   */
  captureInto?: Array<{ kind: string; name: string; hash: string }>
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  outputFiles: string[]
  /**
   * The `output_files` rows behind `outputFiles` (size / mode / mtime), when
   * the layer that produced this entry had them in hand. `restoreHit` reads
   * them for its tree-is-current check instead of re-querying — one SQL
   * round trip per cache hit, saved.
   */
  outputRows?: OutputFileRow[]
  /**
   * The `output_dirs` rows behind the directory short-circuit, when the
   * batched `getMany` loaded them — one query for the run instead of one
   * per hit (0.12 ms each across a warm 1000-project run before this).
   */
  outputDirRows?: OutputDirRow[]
  /** Captured stdout, always present (may be empty). stderr is not cached. */
  stdout: string
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
  /**
   * The task's cache key. ABSENT when the outcome never derived one — a
   * `skipped` task (its upstream failed, so it never probed) or a
   * `persistent` one (a dev server is never cached). Such a row is still a
   * task of the run and must be recorded, so the column keeps a `''`
   * sentinel rather than going nullable: `''` is impossible for a real key
   * (`Cache.key` returns 16 hex chars), the reads that must not treat it as
   * a key already guard it, and it matches what the cloud `task_runs.hash`
   * column has stored for the same concept since its first migration.
   */
  hash?: string
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
  attempts?: number // >1 when the task retried; the direct within-run flaky signal
  /**
   * Whether the task declared a `cache` block. An uncached task executes
   * on every run and its key exists only for dependents to fold, so a
   * reader (`vx why`, `vx last`) must not present its re-run as a cache
   * decision. Absent on rows written before the column existed.
   */
  cached?: boolean
}

/**
 * One header row per `vx run` invocation (the `invocations` table). All
 * fields mirror the columns; nullable VCS/host columns are `null` when
 * the probe failed (not a git repo, hostname unavailable). Recorded
 * once per run inside the same transaction as the per-task `runs` rows.
 */
export interface InvocationRecord {
  runId: string
  command: string
  /** JSON-serialized `string[]` of the requested task names. */
  requestedTasks: string
  /** Compact policy flags, e.g. `'lR,lW,rR,rW'` (an axis omitted = off). */
  cachePolicy: string
  concurrency: number
  flow: 'focused' | 'broad' | null
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  exitOk: boolean
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vxVersion: string
  /** JSON object `{k:v}` of `--tag` pairs. */
  tags: string
}

/**
 * One cache-key component row for the `entry_inputs` table — keyed by
 * the cache-entry HASH it belongs to, not a run. Written inside the
 * entry-save transaction (`writeArtifactAndIndex`) on a miss/save; a
 * cache HIT does not save, so it persists nothing (warm runs are free).
 * The diff (Phase B/B1) reads these by the run's task hash
 * (`runs.hash → entry_inputs[entry_hash]`).
 */
export interface TaskInputRow {
  entryHash: string
  kind: string
  name: string
  hash: string
}

export interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
}

export interface CacheStatsOptions {
  /** Narrow every aggregate to one project. Absent = the whole workspace. */
  project?: string
}

export interface PruneOptions {
  /** Drop entries last accessed before this ms-epoch threshold. */
  olderThanMs?: number
  /**
   * After applying olderThanMs, if the cache still exceeds this size in
   * bytes, evict LRU (smallest `accessed_at` first) until under it.
   */
  maxBytes?: number
  /**
   * Pick the victims and count the orphans, delete nothing: the result
   * says what a real prune with the same policy would reap right now.
   */
  dryRun?: boolean
}

export interface PruneResult {
  /** Index entries evicted by the age / size policy (each with its artifact). */
  evicted: number
  /** Bytes the evicted entries occupied, per the index. */
  bytesFreed: number
  /**
   * Artifacts and temp files with no index row, unlinked by the orphan
   * sweep that runs after eviction (a `SCHEMA_VERSION` drop, a deleted
   * `cache.db`, a save that crashed before its rename). Files younger
   * than one hour are never counted: they may be a save in flight.
   */
  orphans: number
  /** Bytes the reaped orphans occupied on disk. */
  orphanBytes: number
}

/**
 * Per-output-file fingerprint, scoped by the cache entry that
 * produced it. Batch-loaded once at the top of a run via
 * `loadOutputFilesBatch(hashes)` so the orchestrator's "is this
 * tree already current?" probe becomes an in-memory Map lookup
 * plus N parallel stat calls.
 *
 * `path` is project-relative (e.g. `dist/index.js`), matching how
 * outputs are addressed under `<projectDir>/` — except workspace
 * outputs, which carry the full `workspace-outputs/<rel-to-root>`
 * tar entry name (see `WORKSPACE_OUTPUT_PREFIX`); callers split on
 * the prefix and anchor those at the workspace root.
 */
export interface OutputFileRow {
  path: string
  size: number
  mode: number
  mtimeMs: number
}

/** One directory under a whole-subtree output glob, as it stood after the last save or restore on THIS machine. */
export interface OutputDirRow {
  path: string
  mtimeMs: number
}

/**
 * More directories than this under a task's output prefixes: record
 * nothing, keep the walk. 256 refused payload's `@payloadcms/ui#build`
 * (535 directories, 4,069 files), which then paid the refused snapshot's
 * walk AND the output glob on every warm no-op — 65 ms of a 320 ms run
 * (2026-09-11). Rows are 60 bytes each and the check is one stat per
 * directory, so the cap is a bound on pathological trees, not a budget.
 */
export const OUTPUT_DIRS_CAP = 8192

/**
 * A directory whose mtime lies within this many ms of the snapshot is RACY
 * and the whole snapshot is dropped. File timestamps are coarse on Linux
 * (a kernel tick, up to 10 ms), so a write landing in the same tick as the
 * one that made the directory's recorded mtime leaves the mtime unchanged
 * and the change invisible — git's index distrusts stats this young for
 * the same reason (a stray survived a hit on the ubuntu job, 2026-09-03).
 * The next hit walks, and once the tree is older than the window it is
 * recorded for good.
 */
export const OUTPUT_DIRS_RACY_MS = 50

/** The stat memo's twin of `OUTPUT_DIRS_RACY_MS`: a file changed within this window of the stat is not memoised. */
export const FILE_HASH_RACY_MS = 50

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
  /**
   * Cache-key components (Tier-3 input fingerprint) to persist into
   * `entry_inputs` in the same transaction as the entry row. Omitted on
   * the remote-hit ingest path (the artifact doesn't carry them — the
   * fingerprint is the saving machine's local moat). Only computed on a
   * miss/save, so a cache hit never reaches here.
   */
  inputComponents?: readonly TaskInputRow[]
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
  /**
   * The local handle this layer wraps, when it wraps one (`LayeredCache`).
   * `resolveCache` uses it to drop a bare local layer another declared layer
   * already contains, so a plugin that layers over the local handle does
   * not write the
   * local store twice.
   */
  readonly local?: Cache | undefined
  /**
   * `true` iff a REMOTE cache sits behind this layer. THE answer to "can
   * the remote axes of the cache policy do anything on this run?" — the
   * orchestrator clamps `remoteRead`/`remoteWrite` off when it is absent,
   * skips the up-front local classify when it is present (that classify's
   * `cache.get` would be a remote read-through awaited before scheduling),
   * and drives the prefetch pass off it.
   *
   * A layer must answer TRUTHFULLY: identity against the local cache
   * ("something other than the handle I passed in") is NOT the same
   * question — an ordinary pass-through decorator with no remote at all
   * answers yes to it. `LayeredCache` sets it, a bare `Cache` denies it,
   * and a third-party layer opts in when, and only when, it really has a
   * remote. Optional so a layer written before this contract keeps
   * type-checking; absent reads as "no remote", the safe answer.
   */
  readonly hasRemote?: boolean
  /**
   * Batch existence probe over the remote — the subset of `hashes` stored
   * remotely, in ONE round-trip, or `null` for "no batch info; use
   * per-hash". Only meaningful with `hasRemote`; a remote layer that can't
   * batch omits it and the prefetch pass falls back to per-hash GETs.
   */
  remoteHasMany?(hashes: readonly string[]): Promise<Set<string> | null>
  /**
   * Record that the remote has NO artifact for each of `hashes` (from a
   * batch probe), so a later `get`/`prefetch` short-circuits to a miss with
   * no round-trip. Only meaningful with `hasRemote`.
   */
  markRemoteAbsent?(hashes: Iterable<string>): void
  /**
   * Resolve once every background write-through upload settles. The
   * orchestrator awaits it before `close()` — an upload reading layer state
   * after close would race. Only meaningful with `hasRemote`; a layer that
   * uploads synchronously (or not at all) omits it.
   */
  drainUploads?(): Promise<void>
  key(input: CacheKeyInput): Promise<string>
  get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  /**
   * Optional batched `get` (same answers, fewer round trips). The
   * short-circuit probe uses it when a layer offers one; a layer without it
   * is probed hash by hash.
   */
  getMany?(hashes: readonly string[]): Promise<Map<string, CacheEntry>>
  /**
   * Lightweight existence probe. `'local'` / `'remote'` names the layer
   * that holds the artifact; `null` is a miss. NEVER moves bytes: no
   * artifact read, no remote download, no local ingest, no accessed_at
   * bump (the LayeredCache's remote side is an HTTP HEAD). Planning
   * (`--dry` / `--graph`) predicts hits with this instead of `get` so a
   * dry run can't pull N artifacts over the network. Remote errors
   * degrade to `null` — an existence probe never fails anything.
   */
  has(hash: string): Promise<'local' | 'remote' | null>
  /**
   * Best-effort warm of `hash` from a slower layer (the remote cache)
   * into this one, so a later `get(hash)` resolves locally without a
   * round-trip on the task's critical path. Returns `true` if the
   * artifact is now present locally, `false` on a miss / error
   * (degrades, never throws). The local `Cache` is a no-op (nothing
   * slower to warm from); `LayeredCache` owns the real implementation
   * plus the in-flight de-dup so prefetch + get share ONE remote GET.
   */
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
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
  /**
   * The directory-mtime short-circuit behind a warm hit (optional — a layer
   * without it keeps the output walk). `recordOutputDirs` snapshots every
   * directory under each of `prefixes` (project-relative, whole-subtree
   * globs only — see `wholeSubtreePrefixes`) after a save or restore;
   * `loadOutputDirsBatch` reads them back; `outputDirsCurrent` is true iff
   * every recorded directory still carries its recorded mtime, which proves
   * no file was added or removed anywhere the glob could see. Machine-local
   * state, like the output rows: a remote ingest records none.
   */
  recordOutputDirs?(hash: string, projectDir: string, prefixes: readonly string[]): Promise<void>
  loadOutputDirsBatch?(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent?(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean>
  /**
   * Extract the artifact's `outputs/` entries into `projectDir` and —
   * when `workspaceRoot` is given — its `workspace-outputs/` entries
   * into the workspace root. Callers restoring entries that may carry
   * workspace outputs must pass `workspaceRoot`.
   */
  restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void>
  save(args: {
    hash: string
    /**
     * `exitCode` is deliberately NOT accepted: vx caches only successes, so
     * the stored value is pinned to 0 and there is nothing for a caller to
     * decide. Accepting a number and discarding it invited the one shape that
     * launders a failure into a success — cache a failing task's outputs, read
     * the entry back as exit 0, and the hit classifies `cache-hit` while the
     * broken build's files are restored over a good tree. Unrepresentable
     * beats guarded.
     */
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    /**
     * Set only by ChainedCache when an EARLIER layer in the chain already
     * wrote this artifact to the same local handle: the local pack + write
     * is skipped and only the layer's remote side acts. A layer with no
     * remote side treats it as a full no-op.
     */
    skipLocalWrite?: boolean
    /**
     * Resolved `outputs.workspaceFiles` (absolute paths) + the root
     * they're relative to. Packed under `workspace-outputs/<rel>`.
     * Omitted → artifact bytes identical to the pre-workspaceFiles
     * format.
     */
    workspaceOutputFiles?: string[]
    workspaceRoot?: string
    /**
     * Cache-key components for this entry (the Tier-3 input
     * fingerprint). Persisted to `entry_inputs` inside the same
     * transaction as the entry row, via `INSERT OR IGNORE` (a re-save
     * of the same hash is a no-op). Omitted/empty → nothing written.
     * Only computed on the miss/save path — never on a hit.
     */
    inputComponents?: readonly TaskInputRow[]
  }): Promise<void>
  /**
   * Adopt an artifact produced elsewhere — the remote-hit path. Writes
   * the compressed bytes to `<cacheDir>/<hash>.tar.zst`, parses the
   * tar headers to populate the `output_files` rows, and inserts the
   * `entries` row using the caller-supplied `meta`. After this returns,
   * the next `get(hash)` resolves locally.
   */
  ingest(hash: string, compressed: Uint8Array, meta: IngestMeta): Promise<void>
  /**
   * The ONE run-history write: a whole `vx run` atomically, the per-task
   * `runs` rows and the one `invocations` header row — in a SINGLE
   * transaction (one fsync). Input-fingerprint rows are NOT written here — they
   * ride the entry-save transaction (`save`/`ingest`) so a warm
   * all-cache-hit run writes nothing.
   */
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(opts?: CacheStatsOptions): CacheStats
  /**
   * Content-hash a file with an mtime+size fast path. If the
   * `(mtime_ms, size_bytes)` of `filePath` match a previously seen
   * row, return the stored digest (a git blob OID since CACHE_VERSION
   * v20) instead of re-reading the bytes. Otherwise read + hash + upsert.
   * The hash is byte-for-byte identical to what a fresh content-hash
   * would produce — pure optimization, no cache-key change.
   */
  hashFile(filePath: string): Promise<string>
  /**
   * Absolute path to the on-disk outputs artifact for a hash —
   * `<cacheDir>/<hash>.tar.zst`. Returns the path whether or
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
