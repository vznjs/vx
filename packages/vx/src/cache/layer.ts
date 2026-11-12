// The cache layer contract and the records that cross it: every cache
// implementation (`Cache`, `LayeredCache`, a plugin's remote layer) honours it.
// No implementation lives here.

import type { Cache } from './cache.js'
import type { ArtifactInfo } from './layered-cache.js'
import type { OutputDirRow, OutputFileRow } from '../memo/index.js'

export interface CacheKeyInput {
  taskId: string
  /**
   * Hash of the resolved task config: everything the user wrote, including
   * values a config imported.
   */
  taskConfigHash: string
  /** Runtime values of the declared env inputs, `undefined` for an unset name. */
  envValues: Array<[name: string, value: string | undefined]>
  /**
   * Resolved `inputs.runtime` commands as [command, trimmed output] pairs,
   * folded apart from workspaceRuntimeValues.
   */
  runtimeValues?: Array<[command: string, output: string]>
  /** Resolved `inputs.workspaceRuntime` pairs (root-cwd commands). */
  workspaceRuntimeValues?: Array<[command: string, output: string]>
  /** Absolute paths to input files. */
  inputFiles: string[]
  workspaceRoot: string
  /** Cache keys of upstream tasks this one depends on, sorted. */
  upstreamHashes: string[]
  /**
   * Upstream hash → task id, only to name `captureInto` rows; never folded (the
   * key folds the sorted hashes).
   */
  upstreamIds?: ReadonlyMap<string, string>
  /**
   * The task's dependency closure with groups expanded: what an input-shipping
   * executor must place in the input root. It ignores `inputs.tasks`, which
   * filters the key, not what the task may read. Never folded: the key already
   * cascades through a group's roll-up hash.
   */
  upstreamGraft?: ReadonlyArray<{
    readonly taskId: string
    readonly hash: string
    readonly projectDir: string
  }>
  /** CLI args forwarded after `--`. Folded, so different args never share a hit. */
  forwardArgs?: readonly string[]
  /**
   * Precomputed git blob OIDs by absolute path (the run's `git ls-files -s`). A
   * listed path skips `hashFile`; the key is the same either way.
   */
  fileHashes?: ReadonlyMap<string, string>
  /**
   * A plugin's `key` stage material as sorted `[name, value]` pairs. Folded
   * only when non-empty, so a workspace without one keeps its keys.
   */
  pluginParts?: ReadonlyArray<readonly [name: string, value: string]>
  /**
   * The platform a task declaring `exec.platforms` runs on. Folded only when
   * set.
   */
  platform?: string
  /**
   * When set, `key()` pushes each component it folds, at the fold sites,
   * without changing the digest. A miss persists them to `entry_inputs` so a
   * later run can say why it re-ran; capturing at the fold sites keeps the
   * record in step with the key.
   */
  captureInto?: Array<{ kind: string; name: string; hash: string }>
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  /**
   * CPU time and peak RSS of the producing execution, carried in the artifact
   * so a remote entry knows them too. A hit reports them as what it skipped.
   */
  cpuMs?: number
  peakRssBytes?: number
  outputFiles: string[]
  /**
   * The `output_files` rows behind `outputFiles`, when the layer had them:
   * `restoreHit` reads them instead of querying again.
   */
  outputRows?: OutputFileRow[]
  /**
   * The `output_dirs` rows behind the directory short-circuit, when the batched
   * `getMany` loaded them: one query per run, not per hit.
   */
  outputDirRows?: OutputDirRow[]
  /**
   * The task's output log, both streams in print order. A local entry's is a
   * getter that reads on each access: read it once.
   */
  stdout: string
  storedAt: string
  /**
   * Where the hit came from: `'remote'` when LayeredCache pulled it this
   * lookup, so the run can report `cache-hit-remote`.
   */
  source?: 'local' | 'remote'
  /** The artifact's compressed size, when the index knows it. */
  sizeBytes?: number
  /** On a remote hit this run pulled: how long the download and its ingest took. */
  fetchMs?: number
}

/**
 * One key component as `key()` folded it. Persisted on a miss so a later run
 * can diff its inputs; a hit saves nothing.
 */
export interface TaskInputComponent {
  kind: string
  name: string
  hash: string
}

/**
 * One `entry_inputs` row, keyed by the entry hash, written in the entry-save
 * transaction on a miss. The diff reads them through `runs.hash`.
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
  /** Of those hits, the ones that restored outputs; the rest found the disk up to date. */
  restoredCountLast24h: number
}

export interface CacheStatsOptions {
  /** Narrow every aggregate to one project. Absent = the whole workspace. */
  project?: string
}

export interface PruneOptions {
  /** Drop entries last accessed before this ms-epoch threshold. */
  olderThanMs?: number
  /**
   * After `olderThanMs`, evict least recently used (a row-less artifact by its
   * file time) until the cache is under this many bytes.
   */
  maxBytes?: number
  /**
   * Pick the victims and count the orphans, delete nothing: the result
   * says what a real prune with the same policy would reap right now.
   */
  dry?: boolean
}

export interface PruneResult {
  /** Index entries evicted by the age / size policy (each with its artifact). */
  evicted: number
  /** Bytes the evicted entries occupied, per the index. */
  bytesFreed: number
  /**
   * Artifacts and temp files with no index row (a dropped row, a deleted
   * `cache.db`, a crashed save), unlinked by the same policy. Files younger
   * than an hour are never counted.
   */
  orphans: number
  /** Bytes the reaped orphans occupied on disk. */
  orphanBytes: number
  /**
   * Run history and hash-memo rows older than 30 days, dropped. Absent
   * when none went, and on a dry run.
   */
  historyRows?: number
  /** Bytes the index files shrank by once those rows' pages were given back. */
  historyBytes?: number
}

/**
 * Context for `get()`. Needed when the lookup may resolve remotely: the local
 * row a remote hit inserts needs `taskId` and `command`, which the artifact
 * does not carry.
 */
export interface CacheGetContext {
  taskId: string
  command: string
  /**
   * The task's declared `outputs`. A remote artifact is ingested only when
   * every file it carries is one of them, so network bytes cannot write an
   * input or a git hook. Absent, names are not checked.
   */
  outputs?: DeclaredOutputs
}

/** A task's declared outputs, as its config spells them. */
export interface DeclaredOutputs {
  files: readonly string[]
  workspaceFiles: readonly string[]
}

/** Metadata supplied at ingest time — values the artifact does not carry. */
export interface IngestMeta {
  taskId: string
  command: string
  /** Wall-clock time of the original task execution. */
  durationMs: number
  /**
   * Key components to persist into `entry_inputs` with the entry row. Omitted
   * on a remote ingest: the artifact does not carry them.
   */
  inputComponents?: readonly TaskInputRow[]
  /** See `CacheGetContext.outputs`: the names the artifact may carry. */
  outputs?: DeclaredOutputs
}

/**
 * Bytes that are not the artifact their key names: they do not decompress or
 * parse, or a remote's digest or signature check failed. The hit becomes a
 * miss, and the re-run's save replaces that remote's copy.
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

/** A `CorruptArtifactError` by name: a plugin may load its own copy of core. */
export function isCorruptArtifact(err: unknown): boolean {
  return err instanceof Error && err.name === 'CorruptArtifactError'
}

/**
 * `restoreOutputs` found no artifact where the probe found one: a prune, a
 * clean or a re-save removed it in between. The entry is a miss and the task
 * runs. Also thrown, with `reason`, for an artifact whose bytes are wrong: the
 * entry is dropped and saved again.
 */
export class ArtifactVanishedError extends Error {
  constructor(
    public readonly hash: string,
    /** Why the entry cannot be restored, when it is not gone but unreadable. */
    reason?: string,
    /** The `CorruptArtifactError` behind a `reason`. */
    cause?: unknown,
  ) {
    super(
      reason ??
        `its cache artifact ${hash} vanished before the restore (another process removed or replaced it)`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'ArtifactVanishedError'
  }
}

/**
 * The machine-local memos a key and a hit read: file hashes and the output rows
 * and stamps that prove a tree current.
 */
export interface TaskMemo {
  /**
   * Content-hash a file, reusing the stored digest (a git blob OID) while its
   * `(mtime_ms, size_bytes)` match. Same hash a fresh read gives.
   */
  hashFile(filePath: string): Promise<string>
  /**
   * Output-file fingerprints for many entries in one query, by entry hash.
   * Misses are absent.
   */
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  /**
   * True iff every `expected` row's file under `projectDir` matches its size,
   * mode and mtime: the hit then skips clean and restore. Any mismatch or
   * missing file falls through to a real restore.
   */
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): boolean
  /**
   * The directory-mtime short-circuit behind a warm hit (optional).
   * `recordOutputDirs` snapshots every directory under `prefixes` after a save
   * or restore; `outputDirsCurrent` is true iff each still has its recorded
   * mtime, proving no file was added or removed. `holds`, when given, is asked
   * of each non-directory path; false records nothing, since a snapshot of a
   * tree the entry does not hold would vouch for it later.
   */
  recordOutputDirs?(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  /**
   * Stamp `hash`'s output rows with each file's inode and ctime once the tree
   * equals the entry (optional: without it `isOutputsCurrent` trusts no row and
   * every hit restores). Skips a file that no longer matches.
   */
  recordOutputStamps?(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch?(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent?(projectDir: string, rows: readonly OutputDirRow[]): boolean
}

/**
 * The shape every cache implementation honours, so `executeTask` takes `Cache`
 * or `LayeredCache` alike.
 */
export interface CacheLayer {
  /** The local store's memos (`TaskMemo`). */
  readonly memo: TaskMemo
  /**
   * The local handle this layer wraps, if any: `resolveCache` drops a bare
   * local layer another layer already contains, so the local store is not
   * written twice.
   */
  readonly local?: Cache | undefined
  /**
   * Whether a remote sits behind this layer. With none, the run clamps the
   * remote policy axes off; with one, it skips the up-front local classify and
   * runs the prefetch pass. Answer truthfully: a pass-through decorator has no
   * remote. Absent reads as no remote.
   */
  readonly hasRemote?: boolean
  /**
   * Which `hashes` the remote holds and what the first holder knows of each, in
   * one round trip, or `null` to probe per hash.
   */
  remoteHasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null>
  /**
   * `remoteHasMany`, asking a remote with no batch query key by key,
   * `concurrency` at a time: a complete answer or `null`. For a run that plans
   * on the answer.
   */
  remoteHasEach?(
    hashes: readonly string[],
    concurrency: number,
  ): Promise<Map<string, ArtifactInfo> | null>
  /**
   * The subset of `hashes` the local store holds; the prefetch pass probes the
   * remote only for the rest.
   */
  localHasMany?(hashes: readonly string[]): Promise<Set<string>>
  /**
   * The subset of `hashes` the local index remembers a remote holding: trusted
   * with no round trip, so a pull starts at once.
   */
  remoteKnown?(hashes: readonly string[]): Map<string, ArtifactInfo>
  /**
   * Record that the remote holds none of `hashes`, so a later `get` misses with
   * no round trip.
   */
  markRemoteAbsent?(hashes: Iterable<string>): void
  /**
   * The run's up-front keys for each remote it writes but does not read
   * (`--force`): one background probe, and an upload the remote already holds
   * is skipped.
   */
  probeBeforeUpload?(hashes: Promise<readonly string[]>): void
  /** Resolves once every background upload settles; awaited before `close()`. */
  drainUploads?(): Promise<void>
  /** The run was stopped: start no more uploads, and let `drainUploads` resolve now. */
  stopUploads?(): void
  key(input: CacheKeyInput): Promise<string>
  get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  /**
   * `get` past the run's read policy: an entry this run's own machines saved is
   * its work, not a hit.
   */
  getSaved?(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  /**
   * True once a remote the run reads holds entry `hash`, uploading the local
   * entry where none does.
   */
  share?(hash: string): Promise<boolean>
  /**
   * The local entry uploaded over each written remote's copy, which another
   * machine found corrupt (`TaskArtifacts.resend`). True when one took it.
   */
  resend?(hash: string): Promise<boolean>
  /**
   * Whether a remote this run writes took entry `hash` when `save` uploaded
   * it, or already held it; undefined when this run sent it to none.
   */
  uploaded?(hash: string): Promise<boolean | undefined>
  /** Optional batched `get`; without it the short-circuit probes hash by hash. */
  getMany?(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ): Promise<Map<string, CacheEntry>>
  /**
   * Existence probe: `'local'`, `'remote'` or `null`. Never moves bytes or
   * bumps `accessed_at`, so `--dry` predicts hits without downloads. Remote
   * errors read as `null`.
   */
  has(hash: string): Promise<'local' | 'remote' | null>
  /**
   * Best-effort warm of `hash` from the remote into the local store, off the
   * task's critical path. Never throws; `LayeredCache` shares one GET between
   * prefetch and `get`.
   */
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  /**
   * Extract `outputs/` into `projectDir` and, given `workspaceRoot`,
   * `workspace-outputs/` into the root. Pass `workspaceRoot` whenever the entry
   * may carry workspace outputs.
   */
  restoreOutputs(
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
    /** The task's declared outputs: an entry outside them fails the restore, nothing written. */
    outputs?: DeclaredOutputs,
  ): Promise<void>
  save(args: {
    hash: string
    /**
     * No `exitCode`: vx caches only successes, so the stored value is 0. Taking
     * one would let a failing task's outputs be read back as a green hit.
     */
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    /** The empty directories under the outputs (absolute), kept so a hit makes them. */
    outputDirs?: string[]
    /**
     * Resolved `outputs.workspaceFiles` and their root, packed under
     * `workspace-outputs/<rel>`.
     */
    workspaceOutputFiles?: string[]
    /** The empty directories under `workspaceOutputFiles`' globs (absolute). */
    workspaceOutputDirs?: string[]
    workspaceRoot?: string
    /**
     * Key components persisted to `entry_inputs` with the entry row (`INSERT OR
     * IGNORE`). Miss path only.
     */
    inputComponents?: readonly TaskInputRow[]
    /** No remote held `hash` when the run asked: an upload asks none first. */
    absent?: boolean
  }): Promise<void>
  /**
   * Adopt an artifact produced elsewhere (a remote hit): stream it to
   * `<cacheDir>/<hash>.tar.zst`, index its files and insert the entry with
   * `meta`.
   */
  ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void>
  stats(opts?: CacheStatsOptions): CacheStats
  /**
   * Where a file-backed artifact for `hash` lives, whether or not it exists (a
   * small one lives in the index). `restoreOutputs` is how to materialize it.
   */
  outputsPath(hash: string): string
  /** The stored artifact's compressed size, wherever it lives; undefined when none is stored. */
  artifactSize?(hash: string): number | undefined
  /** The output files' bytes, uncompressed, of the entry this process just saved; asked once. */
  outputBytes?(hash: string): number | undefined
  /**
   * True when the last `save` of `hash` found the key stored and kept that
   * entry (a `--force` run): nothing of this run's was saved; asked once.
   */
  kept?(hash: string): boolean
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}

/**
 * The `save()` args, for `LayeredCache` to forward.
 *
 * @internal
 */
export type SaveArgs = Parameters<CacheLayer['save']>[0]
