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
// Replace this module to plug in remote storage. The contract is:
//   key()           : derive a stable hash from a task's identity + inputs
//   get(hash, ctx?) : retrieve a previous run's metadata, or null
//   restoreOutputs  : extract the artifact's outputs/ into the project dir
//   save            : persist outputs + stdout under a hash
//   ingest          : adopt an artifact produced elsewhere (remote-hit path)
//   recordRun       : append a row to the run history table (for stats)
//   close           : release the SQLite handle

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { relPosix, UserError, xxh3, xxh3hex } from '../util/index.js'
import {
  ArchiveSecurityError,
  extractArtifactStream,
  scanArtifact,
  packArtifactBytes,
  packArtifactStream,
  planArtifact,
} from './archive.js'
import { FsCASBackend } from './cas-backend.js'

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
const CACHE_VERSION = 'vx-cache-v27'
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
const SCHEMA_VERSION = 'v24'

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

/**
 * Independent read/write control over the two cache layers (local +
 * remote). Replaces the old single `noCache` boolean: each axis can be
 * toggled on its own so `--force` (re-execute but still refresh the
 * cache) is distinct from `--no-cache` (disable everything).
 *
 * Only the task-artifact get/save path is gated. `recordRun`, `stats`,
 * `prune`, key derivation, and prefetch-ingest are never affected — they
 * are bookkeeping/analytics that a run policy has no business disabling.
 */
export interface CachePolicy {
  localRead: boolean
  localWrite: boolean
  remoteRead: boolean
  remoteWrite: boolean
}

/** All four axes on — the default when no cache flag is passed. */
export const FULL_CACHE_POLICY: CachePolicy = {
  localRead: true,
  localWrite: true,
  remoteRead: true,
  remoteWrite: true,
}

/**
 * Parse a `--cache=<spec>` value into a `CachePolicy`, starting from a
 * base (defaults to {@link FULL_CACHE_POLICY}). The spec is a
 * comma-separated list of `layer:flags` segments where `layer` is
 * `local` or `remote` and `flags` is any subset of `r` (read) and `w`
 * (write), order-independent and possibly empty.
 *
 * A mentioned layer is set EXACTLY to its flags (read = includes `r`,
 * write = includes `w`); an unmentioned layer keeps its base value.
 * So `local:rw,remote:r` = remote read-only, `remote:` = remote fully
 * off, `local:r` = local read-only with remote untouched.
 *
 * Throws a {@link UserError} on an unknown layer, an unknown flag, a
 * duplicated flag, a missing colon, or a repeated layer.
 */
export function parseCachePolicy(spec: string, base: CachePolicy = FULL_CACHE_POLICY): CachePolicy {
  const out: CachePolicy = { ...base }
  const seen = new Set<string>()
  for (const rawSeg of spec.split(',')) {
    const seg = rawSeg.trim()
    if (seg.length === 0) continue
    const colon = seg.indexOf(':')
    if (colon < 0) {
      throw new UserError(`invalid --cache segment '${seg}': expected '<layer>:<flags>'`)
    }
    const layer = seg.slice(0, colon)
    const flags = seg.slice(colon + 1)
    if (layer !== 'local' && layer !== 'remote') {
      throw new UserError(`invalid --cache layer '${layer}': expected 'local' or 'remote'`)
    }
    if (seen.has(layer)) {
      throw new UserError(`--cache layer '${layer}' specified twice`)
    }
    seen.add(layer)
    const flagSet = new Set<string>()
    for (const ch of flags) {
      if (ch !== 'r' && ch !== 'w') {
        throw new UserError(`invalid --cache flag '${ch}' for '${layer}': expected 'r' and/or 'w'`)
      }
      if (flagSet.has(ch)) {
        throw new UserError(`--cache flag '${ch}' repeated for '${layer}'`)
      }
      flagSet.add(ch)
    }
    if (layer === 'local') {
      out.localRead = flagSet.has('r')
      out.localWrite = flagSet.has('w')
    } else {
      out.remoteRead = flagSet.has('r')
      out.remoteWrite = flagSet.has('w')
    }
  }
  return out
}

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

/** More directories than this under a task's output prefixes: record nothing, keep the walk. */
export const OUTPUT_DIRS_CAP = 256

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

/**
 * A decompressed artifact above this is refused as a zstd bomb rather than
 * expanded into memory. 2 GiB comfortably exceeds any real build output while
 * bounding a malicious/compromised remote's ability to OOM a victim who takes
 * a cache hit.
 */
const MAX_DECOMPRESSED_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Read a zstd frame's declared Frame_Content_Size (RFC 8878 §3.1.1) WITHOUT
 * decompressing. Returns null when the frame omits it (streaming frames) or
 * the header is too short to parse. vx's own producer (single-shot
 * `Bun.zstdCompress` of a known buffer) always writes it, so an artifact that
 * declares an enormous size can be rejected before a byte is allocated.
 *
 * Exported for tests: pins the per-`fcsFlag` byte layouts (incl. the 2-byte
 * `+256` adjustment and the `dictIdFlag` offset) that a bomb-refusal e2e can't
 * discriminate (their max declarable sizes sit below the ceiling).
 */
export function zstdContentSize(b: Uint8Array): bigint | null {
  if (b.length < 5) return null
  // Magic_Number 0xFD2FB528, little-endian.
  if (b[0] !== 0x28 || b[1] !== 0xb5 || b[2] !== 0x2f || b[3] !== 0xfd) return null
  const desc = b[4]!
  const fcsFlag = desc >> 6
  const singleSegment = (desc >> 5) & 1
  const dictIdFlag = desc & 3
  let off = 5
  if (singleSegment === 0) off += 1 // Window_Descriptor byte
  off += dictIdFlag === 3 ? 4 : dictIdFlag // Dictionary_ID: 0,1,2,4 bytes
  let fcsSize: number
  if (fcsFlag === 0) fcsSize = singleSegment === 1 ? 1 : 0
  else if (fcsFlag === 1) fcsSize = 2
  else if (fcsFlag === 2) fcsSize = 4
  else fcsSize = 8
  if (fcsSize === 0 || b.length < off + fcsSize) return null
  let v = 0n
  for (let i = 0; i < fcsSize; i++) v |= BigInt(b[off + i]!) << BigInt(8 * i)
  if (fcsSize === 2) v += 256n // per spec, the 2-byte field stores value − 256
  return v
}

/**
 * Decompress a zstd artifact that DECLARES its content size, with a hard
 * output ceiling: refused before a byte is allocated when the declaration
 * is over the cap, and again on the actual length. A frame with no
 * declaration (a streamed producer's — vx's own, above 4 MiB) never comes
 * here: `decodedTar` decodes it as a stream under the running count, so
 * a sizeless bomb has nowhere to expand.
 */
async function zstdDecompressBounded(compressed: Uint8Array, hash: string): Promise<Uint8Array> {
  assertDeclaredSize(compressed, hash)
  const out = await Bun.zstdDecompress(compressed)
  if (out.length > MAX_DECOMPRESSED_ARTIFACT_BYTES) {
    throw new CorruptArtifactError(
      hash,
      `decompressed to ${out.length} bytes (> ${MAX_DECOMPRESSED_ARTIFACT_BYTES} cap)`,
    )
  }
  return out
}

/** The pre-decompress half of the ceiling: the frame header's own claim, when it makes one. */
function assertDeclaredSize(compressed: Uint8Array, hash: string): bigint | null {
  const declared = zstdContentSize(compressed)
  if (declared !== null && declared > BigInt(MAX_DECOMPRESSED_ARTIFACT_BYTES)) {
    throw new CorruptArtifactError(
      hash,
      `declares ${declared} decompressed bytes (> ${MAX_DECOMPRESSED_ARTIFACT_BYTES} cap)`,
    )
  }
  return declared
}

/** Compressed artifacts above this size are decoded as a stream, on restore and on ingest. */
const STREAM_DECODE_FROM = 4 * 1024 * 1024

/** Collect a byte stream; only ever used where the seam wants bytes. */
async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Bun's `CompressionStream` types do not satisfy `pipeThrough`'s pair
 * (its readable side is typed `NonSharedUint8Array`); the runtime object
 * is a plain byte transform.
 */
const zstdEncoder = (): TransformStream<Uint8Array, Uint8Array> =>
  new CompressionStream('zstd') as unknown as TransformStream<Uint8Array, Uint8Array>

const oneChunk = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

/**
 * The decoded tar as a stream: one call for a small artifact that
 * declares its size, a streamed decode otherwise — the stream setup is
 * ~35 µs, which matters at a thousand one-file artifacts and nowhere
 * else. Bytes in memory are only ever the small case (a large source
 * must be a FILE: a Blob copies its bytes and hands the decoder
 * everything at once, measured +519 MiB on 150 MiB against +448 for the
 * plain decode). The 2 GiB ceiling applies either way: the declaration
 * and the result length in one call, a running count on the stream.
 */
async function decodedTar(
  source: Uint8Array | Bun.BunFile,
  hash: string,
): Promise<ReadableStream<Uint8Array>> {
  if (source instanceof Uint8Array) {
    if (assertDeclaredSize(source, hash) === null) return zstdDecodeStream(new Blob([source]), hash)
    return oneChunk(await zstdDecompressBounded(source, hash))
  }
  if (source.size <= STREAM_DECODE_FROM) {
    const bytes = await source.bytes()
    if (assertDeclaredSize(bytes, hash) === null) return zstdDecodeStream(source, hash)
    return oneChunk(await zstdDecompressBounded(bytes, hash))
  }
  assertDeclaredSize(await source.slice(0, 32).bytes(), hash)
  return zstdDecodeStream(source, hash)
}

/**
 * The streaming twin of `zstdDecompressBounded`: the decoded bytes as a
 * stream, refused past the same ceiling. A malicious frame cannot expand
 * past the cap here either — the count runs as bytes are produced, before
 * any of them reach the reader's next entry.
 */
function zstdDecodeStream(source: Blob, hash: string): ReadableStream<Uint8Array> {
  let total = 0
  return source
    .stream()
    .pipeThrough(new DecompressionStream('zstd'))
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength
          if (total > MAX_DECOMPRESSED_ARTIFACT_BYTES) {
            controller.error(
              new CorruptArtifactError(
                hash,
                `decompresses past ${MAX_DECOMPRESSED_ARTIFACT_BYTES} bytes (cap)`,
              ),
            )
            return
          }
          controller.enqueue(chunk)
        },
      }),
    )
}

export interface CacheLayer {
  /**
   * The local handle this layer wraps, when it wraps one (`LayeredCache`).
   * `resolveCache` uses it to drop a bare local layer another declared layer
   * already contains, so `[cloud(), localCachePlugin()]` does not write the
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
  recordRun(run: RunRecord): void
  /**
   * Append every run in `runs` to the history in a single SQLite
   * transaction. ~10× faster than calling `recordRun` in a loop when
   * `runs.length > ~50` (one fsync vs. N).
   */
  recordRuns(runs: readonly RunRecord[]): void
  /**
   * Record a whole `vx run` atomically: the per-task `runs` rows and
   * the one `invocations` header row — in a SINGLE transaction (one
   * fsync). Replaces the bare `recordRuns` call in the orchestrator's
   * end-of-run path. Input-fingerprint rows are NOT written here — they
   * ride the entry-save transaction (`save`/`ingest`) so a warm
   * all-cache-hit run writes nothing.
   */
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(opts?: CacheStatsOptions): CacheStats
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
  private readonly insertRun: ReturnType<Database['prepare']>
  private readonly insertInvocation: ReturnType<Database['prepare']>
  private readonly insertEntryInput: ReturnType<Database['prepare']>
  private readonly selectFileHash: ReturnType<Database['prepare']>
  private readonly upsertFileHash: ReturnType<Database['prepare']>
  private readonly insertOutputFile: ReturnType<Database['prepare']>
  private readonly insertOutputDir: ReturnType<Database['prepare']>
  private readonly deleteOutputDirs: ReturnType<Database['prepare']>
  private readonly deleteOutputFiles: ReturnType<Database['prepare']>
  private readonly selectConfigEval: ReturnType<Database['prepare']>
  private readonly insertConfigEval: ReturnType<Database['prepare']>
  /** Memoized repo object format for blob-OID hashing (lazy-detected). */
  private objectFormat: 'sha1' | 'sha256' | null = null

  /**
   * Local-layer read/write gates for the task ARTIFACT path only.
   * `get()` returns null when `!read`; `save()` skips the artifact +
   * index write when `!write`. Everything else (recordRun, stats,
   * prune, ingest, hashing) is unaffected — those are bookkeeping a
   * run policy must not disable. Default: both true.
   */
  private readonly read: boolean
  private readonly write: boolean

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
    // and recreate. Outputs on disk become orphans; they'll be ignored
    // on next miss and reaped by `vx cache prune`.
    const meta = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
      | { value: string }
      | undefined
    if (meta && meta.value !== SCHEMA_VERSION) {
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
        attempts            INTEGER
      );
      -- runs_hash had no reader: every consumer of runs.hash looks the row
      -- up by run_id or (project, task) first. Dropped 2026-09-03 — it cost
      -- 1,000 warm-run inserts 11.5 → 3.9 ms; the DROP sheds it from
      -- existing databases (a schema-meta bump is for stored shapes, and
      -- an index is not one).
      DROP INDEX IF EXISTS runs_hash;
      CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS runs_project    ON runs(project, task);
      CREATE INDEX IF NOT EXISTS runs_ended      ON runs(ended_at);
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
    this.insertRun = this.db.prepare(`
      INSERT INTO runs(
        hash, project, task, status, exit_code, duration_ms, forward_args,
        started_at, ended_at,
        run_id, cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns,
        cache_hit, attempts
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?)
    `)
    this.insertInvocation = this.db.prepare(`
      INSERT INTO invocations(
        run_id, command, requested_tasks, cache_policy, concurrency, flow,
        started_at, ended_at, total_duration_ms,
        task_count, failed_count, hit_count, hit_local_count, hit_remote_count,
        exit_ok,
        commit_sha, branch, dirty, ci, ci_provider,
        host, os, arch, vx_version, tags
      )
      VALUES (?, ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?,  ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `)
    // INSERT OR IGNORE: re-saving the same hash (idempotent ingest /
    // overlapping concurrent saves) leaves the existing rows untouched —
    // identical inputs derive the identical hash, so the rows are too.
    this.insertEntryInput = this.db.prepare(`
      INSERT OR IGNORE INTO entry_inputs(entry_hash, kind, name, hash)
      VALUES (?, ?, ?, ?)
    `)
    this.selectFileHash = this.db.prepare(
      'SELECT mtime_ms, size_bytes, ctime_ms, ino, content_hash FROM file_hashes WHERE path = ?',
    )
    this.upsertFileHash = this.db.prepare(`
      INSERT INTO file_hashes(path, mtime_ms, size_bytes, ctime_ms, ino, content_hash, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        mtime_ms     = excluded.mtime_ms,
        size_bytes   = excluded.size_bytes,
        ctime_ms     = excluded.ctime_ms,
        ino          = excluded.ino,
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
    this.insertOutputDir = this.db.prepare(
      'INSERT INTO output_dirs(entry_hash, path, mtime_ms) VALUES (?, ?, ?)',
    )
    this.deleteOutputDirs = this.db.prepare('DELETE FROM output_dirs WHERE entry_hash = ?')
    this.selectConfigEval = this.db.prepare('SELECT json FROM config_evals WHERE key = ?')
    this.insertConfigEval = this.db.prepare(
      'INSERT OR REPLACE INTO config_evals(key, json, created_at) VALUES (?, ?, ?)',
    )
  }

  /** `ConfigEvalStore`: a cached config evaluation, honouring the local READ axis. */
  getConfigEval(key: string): string | null {
    if (!this.read) return null
    const row = this.selectConfigEval.get(key) as { json: string } | null
    return row?.json ?? null
  }

  /** `ConfigEvalStore`: each config's ordered closure, one `IN` query per 900 paths. */
  getConfigClosures(configPaths: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (!this.read || configPaths.length === 0) return out
    for (let i = 0; i < configPaths.length; i += 900) {
      const chunk = configPaths.slice(i, i + 900)
      const rows = this.db
        .query(
          `SELECT config_path, files_json FROM config_closures WHERE config_path IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...(chunk as readonly SQLQueryBindings[])) as Array<{
        config_path: string
        files_json: string
      }>
      for (const r of rows) out.set(r.config_path, JSON.parse(r.files_json) as string[])
    }
    return out
  }

  /** `ConfigEvalStore`: remember a config's ordered closure, honouring the local WRITE axis. */
  putConfigClosure(configPath: string, files: readonly string[]): void {
    if (!this.write) return
    this.db
      .prepare(
        'INSERT INTO config_closures(config_path, files_json, created_at) VALUES (?, ?, ?) ON CONFLICT(config_path) DO UPDATE SET files_json = excluded.files_json, created_at = excluded.created_at',
      )
      .run(configPath, JSON.stringify(files), Date.now())
  }

  /** `ConfigEvalStore`: the batched read — one `IN` query per 900 keys, honouring the local READ axis. */
  getConfigEvals(keys: readonly string[]): Map<string, string> {
    const out = new Map<string, string>()
    if (!this.read || keys.length === 0) return out
    for (let i = 0; i < keys.length; i += 900) {
      const chunk = keys.slice(i, i + 900)
      const rows = this.db
        .query(
          `SELECT key, json FROM config_evals WHERE key IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...(chunk as readonly SQLQueryBindings[])) as Array<{ key: string; json: string }>
      for (const r of rows) out.set(r.key, r.json)
    }
    return out
  }

  /** `ConfigEvalStore`: remember a validated evaluation, honouring the local WRITE axis. */
  putConfigEval(key: string, json: string): void {
    if (!this.write) return
    this.insertConfigEval.run(key, json, Date.now())
  }

  /**
   * Content-hash a file (as a git blob OID, v20) with an mtime+size
   * fast path. If the `file_hashes` table has a row for `path` whose
   * `(mtime_ms, size_bytes, ctime_ms, ino)` all match the current
   * stat, we reuse the stored content_hash (a memory + SQLite lookup,
   * no disk read). Otherwise we read + hash + upsert. All four fields
   * are load-bearing — see the comment at the comparison.
   *
   * The OID is byte-identical to what `git hash-object` (and the git
   * index) computes for the same content, so this fallback and the
   * `CacheKeyInput.fileHashes` index-OID fast path agree on any file
   * git stores verbatim. They do NOT agree when a clean filter
   * (`text`/`eol`/`ident`) is active: the index blob is the filtered
   * form while this hashes the worktree bytes, so `inputs.ts` drops
   * the index OID for those paths and routes them here.
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
    // ctime + ino are what make this memo SAFE, not merely fast. mtime is
    // caller-settable, so (mtime, size) alone hands back the previous run's
    // digest for genuinely different bytes whenever a producer preserves
    // mtime — `tar -x`, `unzip`, `cp -p`, `rsync --times`, any
    // SOURCE_DATE_EPOCH generator — which is a stale cache hit. `utimes`
    // cannot suppress ctime without root, and an atomic write-then-rename
    // changes the inode; git's own index keys on ctime+ino+dev for exactly
    // this reason. Both fields come from the stat we already took.
    const ctimeMs = Math.floor(st.ctimeMs)
    const ino = Number(st.ino)
    const row = this.selectFileHash.get(filePath) as
      | {
          mtime_ms: number
          size_bytes: number
          ctime_ms: number
          ino: number
          content_hash: string
        }
      | undefined
    if (
      row &&
      row.mtime_ms === mtimeMs &&
      row.size_bytes === size &&
      row.ctime_ms === ctimeMs &&
      row.ino === ino
    ) {
      return row.content_hash
    }
    const ch = await this.hashFileFromDisk(filePath)
    this.upsertFileHash.run(filePath, mtimeMs, size, ctimeMs, ino, ch, Date.now())
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
    return await this.readEntry(hash)
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
  async getIngested(hash: string): Promise<CacheEntry | null> {
    return await this.readEntry(hash)
  }

  private async readEntry(hash: string): Promise<CacheEntry | null> {
    const row = this.selectEntry.get(hash) as EntryRow | undefined
    if (!row) return null

    // Verify the tar artifact actually exists. The DB and the
    // filesystem can drift if someone manually deletes the cache dir.
    if (!(await Bun.file(this.tarPath(hash)).exists())) return null

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
    const present = await Promise.all(rows.map((r) => Bun.file(this.tarPath(r.hash)).exists()))
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
    return (await Bun.file(this.tarPath(hash)).exists()) ? 'local' : null
  }

  // Local cache has no slower layer to warm from — prefetch is a no-op.
  // The contract still resolves false so callers can treat every layer
  // uniformly (LayeredCache overrides with the real remote pull).
  async prefetch(_hash: string, _ctx?: CacheGetContext): Promise<boolean> {
    return false
  }

  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    const out = new Map<string, OutputFileRow[]>()
    if (hashes.length === 0) return out
    // Inline placeholders for an IN-list — bun:sqlite doesn't ship
    // rarray, but `IN (?, ?, …)` with N≤~999 is fast and avoids per-
    // hash select.get() overhead. `db.query` (not `db.prepare`) caches the
    // compiled statement keyed by the SQL text — so the dominant single-hash
    // warm-hit path (called up to 3× per hit) reuses one statement instead of
    // recompiling on every call.
    const placeholders = hashes.map(() => '?').join(',')
    const stmt = this.db.query(
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
    // Promise-form stat, deliberately: statSync is ~2 µs against ~13 µs in
    // isolation, but this runs under the scheduler's concurrency and the
    // async form keeps the stats on the thread pool in parallel — the sync
    // version measured slower on a 1000-hit warm run (2026-09-02).
    const results = await Promise.all(
      expected.map(async (e) => {
        try {
          const s = await stat(path.join(projectDir, e.path))
          return (
            s.size === e.size &&
            (s.mode & 0o777) === (e.mode & 0o777) &&
            // MILLISECOND comparison (sub-ms tolerance for the float
            // round-trip through utimes). Save rows carry stat-ms and
            // restoreOutputs re-syncs restored files to the row value,
            // so equality holds exactly in steady state; legacy
            // second-precision rows converge on their first restore.
            // Residual blind spot: a same-size edit landing in the SAME
            // millisecond as the recorded write, or a deliberately
            // forged mtime (touch -r) — the trade every mtime-based
            // skip check accepts.
            Math.abs(s.mtimeMs - e.mtimeMs) < 1
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

  /**
   * Snapshot every directory under each of `prefixes` for `hash`. Called
   * after a save and after a restore, when the tree is known to equal the
   * entry's set. Symlinked directories are not descended (the output walk
   * refuses them too). Over `OUTPUT_DIRS_CAP` directories, or on any
   * error, the rows are cleared and the next hit keeps the walk.
   */
  async recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
  ): Promise<void> {
    const rows: Array<[string, number]> = []
    const walk = async (rel: string): Promise<boolean> => {
      const abs = path.join(projectDir, rel)
      let st
      try {
        st = await lstat(abs)
      } catch {
        return false
      }
      if (!st.isDirectory()) return false
      rows.push([rel, st.mtimeMs])
      if (rows.length > OUTPUT_DIRS_CAP) return false
      let entries
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch {
        return false
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.isSymbolicLink()) {
          if (!(await walk(`${rel}/${e.name}`))) return false
        }
      }
      return true
    }
    let ok = true
    for (const prefix of prefixes) {
      if (!(await walk(prefix))) {
        ok = false
        break
      }
    }
    // All or nothing: a racy directory dropped alone would leave its
    // parent trusted while an addition inside it bumps only the dropped one.
    const youngest = Date.now() - OUTPUT_DIRS_RACY_MS
    if (rows.some(([, mtime]) => mtime > youngest)) ok = false
    this.db.transaction(() => {
      this.deleteOutputDirs.run(hash)
      if (!ok) return
      for (const [rel, mtime] of rows) this.insertOutputDir.run(hash, rel, mtime)
    })()
  }

  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    const out = new Map<string, OutputDirRow[]>()
    if (hashes.length === 0) return out
    const placeholders = hashes.map(() => '?').join(',')
    const rows = this.db
      .query(
        `SELECT entry_hash, path, mtime_ms FROM output_dirs WHERE entry_hash IN (${placeholders})`,
      )
      .all(...(hashes as readonly SQLQueryBindings[])) as Array<{
      entry_hash: string
      path: string
      mtime_ms: number
    }>
    for (const r of rows) {
      const list = out.get(r.entry_hash)
      const row = { path: r.path, mtimeMs: r.mtime_ms }
      if (list) list.push(row)
      else out.set(r.entry_hash, [row])
    }
    return out
  }

  /** True iff every recorded directory exists with its recorded mtime (ms). Same forged-mtime trade as the file check. */
  async outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean> {
    if (rows.length === 0) return false
    const results = await Promise.all(
      rows.map(async (r) => {
        try {
          const st = await stat(path.join(projectDir, r.path))
          return st.isDirectory() && Math.abs(st.mtimeMs - r.mtimeMs) < 1
        } catch {
          return false
        }
      }),
    )
    return results.every(Boolean)
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
    const compressed = await this.packArtifactToTemp(this.tempPath(args.hash), args)
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
  async packArtifactBytes(args: SaveArgs): Promise<Uint8Array> {
    return await this.packArtifact(args)
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
    return await bytesOf(packArtifactStream(plan).pipeThrough(zstdEncoder()))
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
      await writeFile(tmpPath, compressed)
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
      scanned = await scanArtifact(await decodedTar(source, hash))
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
    await rename(tmpPath, finalPath)

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
    const insertOutputFile = this.insertOutputFile
    const deleteOutputFiles = this.deleteOutputFiles
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
      // Replace the entry's existing output_files rows (an UPDATE on
      // the same hash should refresh, not append).
      deleteOutputFiles.run(hash)
      for (const [rel, size, mode, mtime] of outputFileRows) {
        insertOutputFile.run(hash, rel, size, mode, mtime)
      }
      // INSERT OR IGNORE: identical inputs derive this same hash, so a
      // re-save's rows are identical — keep the first set, skip the rest.
      if (inputComponents !== undefined) {
        for (const c of inputComponents) {
          insertEntryInput.run(hash, c.kind, c.name, c.hash)
        }
      }
    })
    tx()
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
   * Content-addressed storage view over the same artifacts directory.
   * Returns an `FsCASBackend` pointing at `cacheDir`, so external
   * subsystems (R2 mirror, REAPI CAS bridge, analytics scanners) can
   * read raw bytes with a `Digest`-keyed API without coupling to
   * Cache's internal save path. Read/write semantics match what
   * Cache.save writes (`<cacheDir>/<hash>.tar.zst`).
   */
  contentBackend(): FsCASBackend {
    return new FsCASBackend(this.cacheDir)
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

  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void {
    // Whole run records atomically — one transaction, one fsync: the
    // per-task `runs` rows and the one `invocations` header. The
    // input-fingerprint rows do NOT live here: they're written inside
    // the entry-save transaction (`save`/`ingest`) so a warm
    // all-cache-hit run — which writes no `runs`-vs-`entry_inputs`
    // mismatch — pays nothing for the moat it isn't refreshing.
    const insertRun = this.insertRun
    const insertInvocation = this.insertInvocation
    this.db.transaction(() => {
      for (const r of bundle.runs) insertRun.run(...bindRun(r))
      insertInvocation.run(...bindInvocation(bundle.invocation))
    })()
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

    return { evicted: victims.size, bytesFreed }
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
      this.db.prepare('DELETE FROM runs WHERE ended_at < ?').run(cutoff)
      this.db.prepare('DELETE FROM invocations WHERE ended_at < ?').run(cutoff)
      // A config that has not been loaded in 30 days was edited (its key
      // moved) or its project left; either way the row is dead weight.
      this.db.prepare('DELETE FROM config_evals WHERE created_at < ?').run(cutoff)
      this.db.prepare('DELETE FROM config_closures WHERE created_at < ?').run(cutoff)
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

/**
 * Bind a RunRecord to the positional parameters expected by the
 * `insertRun` prepared statement (17 columns). Shared between the
 * single and batched record paths.
 */
function bindRun(run: RunRecord): SQLQueryBindings[] {
  return [
    // The ONE place the no-key sentinel is applied, so the column's
    // NOT NULL invariant can't be violated from a call site.
    run.hash ?? '',
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
    run.attempts ?? null,
  ]
}

/**
 * Bind an InvocationRecord to the positional parameters of the
 * `insertInvocation` prepared statement (25 columns). Booleans map to
 * 0/1; null-or-bool columns (`dirty`) keep null distinct from 0.
 */
function bindInvocation(inv: InvocationRecord): SQLQueryBindings[] {
  return [
    inv.runId,
    inv.command,
    inv.requestedTasks,
    inv.cachePolicy,
    inv.concurrency,
    inv.flow,
    inv.startedAt,
    inv.endedAt,
    inv.totalDurationMs,
    inv.taskCount,
    inv.failedCount,
    inv.hitCount,
    inv.hitLocalCount,
    inv.hitRemoteCount,
    inv.exitOk ? 1 : 0,
    inv.commitSha,
    inv.branch,
    inv.dirty === null ? null : inv.dirty ? 1 : 0,
    inv.ci ? 1 : 0,
    inv.ciProvider,
    inv.host,
    inv.os,
    inv.arch,
    inv.vxVersion,
    inv.tags,
  ]
}

function splitTaskId(id: string): [string, string] {
  const i = id.indexOf('#')
  if (i < 0) return [id, '']
  return [id.slice(0, i), id.slice(i + 1)]
}
