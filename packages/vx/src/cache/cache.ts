// Content-addressed task cache.
//
// On-disk layout:
//   <cacheDir>/cache.db — SQLite index (entries + runs + file_hashes)
//   <cacheDir>/<hash>.tar.zst — per-entry artifact:
//                                      stdout (captured stdout, always present)
//                                      outputs/ (declared output files, when any)
//                                      workspace-outputs/ (declared outputs.workspaceFiles,
//                                                          root-relative, when any)
//
// The artifact carries ONLY replayable bytes (logs + outputs). Entry
// metadata — taskId, command, exitCode, durationMs, storedAt — lives
// in the SQLite `entries` row. The same tar.zst bytes ship to a remote
// cache server unchanged; on remote-hit, the caller supplies metadata
// via the `ingest(hash, body, meta)` API so the local SQL index gets
// populated without sniffing the artifact.
//
// We never cache failed runs, so stderr is dropped from the cached
// surface entirely. Live runs still stream stderr through the logger
// for the user to see — but on a cache hit there's nothing to replay
// (the original run was successful and stderr typically empty).
//
// With a shared store (the default: `docs/design/shared-store-2026-10.md`)
// the entries and their artifacts live in `<store>/store.db` and
// `<store>/<hash>.tar.zst`, attached to the workspace's own `cache.db`,
// which keeps the history and the memos: every workspace of one user hits
// what another saved, and none reads another's runs.
//
// This is core's FLOOR, not a module to replace: remote storage is a
// `RemoteCacheLayer` (has / get / put) that `LayeredCache` wraps around
// this handle, declared by a plugin's `cache` hook. The contract every
// layer speaks is `CacheLayer` in layer.ts; `plugin-host.ts` enforces it.

import { Database } from 'bun:sqlite'
import { closeDb } from '../index-db/index.js'
import { splitTaskId } from '../util/index.js'
import {
  type CacheEntry,
  type CacheGetContext,
  type CacheKeyInput,
  type CacheLayer,
  type CacheStats,
  type CacheStatsOptions,
  type DeclaredOutputs,
  type IngestMeta,
  type PruneOptions,
  type PruneResult,
  type SaveArgs,
  type TaskInputRow,
  type TaskMemo,
} from './layer.js'
import { LocalMemo, type RemoteHits, type StoreMemo } from '../memo/index.js'
import { MAX_DECOMPRESSED_ARTIFACT_BYTES } from './zstd.js'
import { foldKey } from './key-fold.js'
import { behindLink } from './linked-inputs.js'
import { WalCheckpointer } from './checkpointer.js'
import * as lookup from './lookup.js'
import * as restoring from './restore.js'
import * as saving from './save.js'
import * as pruning from './prune.js'
import { flushIndex } from './save.js'
import {
  DEFAULT_STORE,
  type SchemaReset,
  StoreIndex,
  type StoreOptions,
  digestValue,
  flushAccessed,
  guard,
  historyFilesOf,
  indexErrorOf,
} from './store-index.js'

/** What a run's background uploads moved: totals over the ones that landed. */
export interface UploadTally {
  count: number
  bytes: number
  /** Summed per-upload time; uploads overlap, so this exceeds the wall. */
  ms: number
  failed: number
}

/** One task's traffic with the remotes this run, by its key. */
export interface RemoteKeyTraffic {
  /** Its uploads queued or running. */
  uploading: number
  /** An upload of it landed on a remote. */
  landed: boolean
  /** Each distinct remote read or write of it that failed: `upload: <message>`. */
  failures: string[]
}

/** The run's remote traffic per key: what the footer's remote part counts, task by task. */
export interface RemoteTraffic {
  /** Uploads queued or running across every remote. */
  inFlight: number
  readonly keys: Map<string, RemoteKeyTraffic>
}

/**
 * `memo.hashFile(file)`, and `seen` told the ctime of the stat the digest
 * came from when the memo is core's own (the re-check's tie rule,
 * `InputFact.ctimeMs`). Any other memo tells nothing, and so does one
 * whose `hashFile` was replaced since.
 */
export function hashFileSeen(
  memo: TaskMemo,
  file: string,
  seen: (ctimeMs: number) => void,
): Promise<string> {
  return ownHasher(memo) ? memo.hashFileSeen(file, seen) : memo.hashFile(file)
}

/**
 * Each of `files` by `memo.hashFile`'s answer, with one memo query for
 * them all when the memo is core's own (`hashFiles`), where one
 * point query per file took the lock each time: 10 of vueuse's 45 ms of
 * keys. A file that cannot be hashed is absent: the caller
 * asks `hashFile` for it, and its error is that call's.
 */
export async function hashFilesOf(
  memo: TaskMemo,
  files: readonly string[],
): Promise<Map<string, string>> {
  if (ownHasher(memo)) return memo.hashFiles(files)
  const out = new Map<string, string>()
  await Promise.all(
    files.map((f) =>
      memo.hashFile(f).then(
        (id) => void out.set(f, id),
        () => {},
      ),
    ),
  )
  return out
}

/** Core's own memo, its `hashFile` not replaced since (a test's double). */
function ownHasher(memo: TaskMemo): memo is LocalMemo {
  return memo instanceof LocalMemo && memo.hashFile === LocalMemo.prototype.hashFile
}

/**
 * The hashes of every entry this machine's index holds for `taskId`: an
 * additive task's miss reads their rows to tell the files a save or
 * restore of its own left from what it found. A function, not
 * a layer method, so the package's API is unchanged; a layer with no
 * local index (a test double) answers none.
 */
export function taskEntryHashes(layer: CacheLayer, taskId: string): string[] {
  const local = layer instanceof Cache ? layer : (layer as { local?: unknown }).local
  if (!(local instanceof Cache)) return []
  const [project, task] = splitTaskId(taskId)
  const ix = storeIndexOf(local)
  return guard(ix, () =>
    (
      ix.db
        .query('SELECT hash FROM entries WHERE project = ? AND task = ?')
        .all(project, task) as Array<{ hash: string }>
    ).map((r) => r.hash),
  )
}

/**
 * The files a second connection writes a run's hits through
 * (history-stream.ts); undefined when the store keeps no history on disk.
 * A function, as `indexDb` is: no plugin writes the history.
 */
export function historyFiles(cache: Cache): { index: string; store?: string } | undefined {
  return historyFilesOf(storeIndexOf(cache))
}

/**
 * The cache's `bun:sqlite` handle, for core's own readers (`vx last`, `vx
 * why`, the history provider). A function, not a member: the façade hands
 * `Cache` to plugins and no plugin touches cache.db. Callers
 * never close it — `Cache.close()` owns the lifetime.
 */
export function indexDb(cache: Cache): Database {
  return storeIndexOf(cache).db
}

/** The salted digest value-bearing rows hold (`digestValue`), for the history writer. */
export function valueDigest(cache: Cache): (value: string) => string {
  return (value) => digestValue(storeIndexOf(cache), value)
}

/** Whether this open may write the index: one it cannot write keeps no history. */
export function indexWritable(cache: Cache): boolean {
  return storeIndexOf(cache).writeBlocked === null
}

/**
 * `err` as a reader of `indexDb(cache)` reports it: a page SQLite cannot
 * read is refused by its file, as every `Cache` read refuses it, where
 * `vx last` and `vx why` printed a raw `SQLiteError` and a stack.
 */
export function indexError(cache: Cache, err: unknown): unknown {
  return indexErrorOf(storeIndexOf(cache), err)
}

function closeStore(ix: StoreIndex): void {
  try {
    flushIndex(ix)
    const held = ix.localMemo.takeHeldBlobSizes()
    if (held !== undefined && held.size > 0) ix.files.rememberBlobSizes(held)
    flushAccessed(ix)
    ix.outputs.flushOutputDirs()
    ix.folds.flush()
  } catch {
    // `accessed_at` is LRU bookkeeping, never correctness, and the run's
    // results are already recorded by the time we get here. Letting it throw
    // also SKIPPED `db.close()` below, leaking the handle. Reachable when the
    // cache dir is removed under a live handle (a concurrent `rm
    // -rf.vx/cache`): macOS answers SQLITE_IOERR_VNODE on a write to an
    // unlinked file where Linux happily writes on.
  }
  if (ix.checkpoints instanceof WalCheckpointer) ix.checkpoints.terminate()
  ix.checkpoints = undefined
  closeDb(ix.db)
}

const indexes = new WeakMap<Cache, StoreIndex>()

/**
 * The store index behind `cache`, for the cache module's own files and
 * tests: the one way past the class wall, and not in `index.ts`.
 */
export function storeIndexOf(cache: Cache): StoreIndex {
  return indexes.get(cache)!
}

export class Cache implements CacheLayer {
  /** This IS the local layer — there is nothing slower behind it. */
  readonly hasRemote = false
  /**
   * The run's uploads to a remote behind this cache, tallied by the
   * `LayeredCache` over it (a plugin's, constructed over `ctx.localCache`)
   * so the run can report them without a method on the layer seam.
   */
  readonly uploads: UploadTally = { count: 0, bytes: 0, ms: 0, failed: 0 }
  /** The run's hits pulled from those remotes, and their bytes on the wire. */
  readonly downloads: { count: number; bytes: number } = { count: 0, bytes: 0 }
  /** The same remotes' traffic per key, filled by the same `LayeredCache`. */
  readonly traffic: RemoteTraffic = { inFlight: 0, keys: new Map() }
  private readonly ix: StoreIndex

  /** A reading verb's open: it never resets the index (the constructor's `mode`). */
  static inspect(cacheDir: string): Cache {
    return new Cache(cacheDir, undefined, undefined, undefined, 'inspect')
  }

  constructor(
    cacheDir: string,
    localPolicy: { read: boolean; write: boolean } = { read: true, write: true },
    /**
     * The workspace root, where the file hasher asks git for the object format
     * (file-hashes.ts), and whose output stamps and snapshots this handle
     * reads in a named cache dir.
     */
    repoDir?: string,
    /**
     * The largest artifact, decoded, this cache saves, ingests or
     * restores (zstd.ts). Lowered only by a test, through
     * `RunOptions.artifactCeiling`: 2 GiB of output is out of a test's reach.
     */
    artifactCeiling: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
    /**
     * `'inspect'`: a reading verb (`why`, `last`, `info`). It never resets
     * the index: a schema it cannot read is refused, named, and left as it
     * was. `'preview'`: a dry prune or a `--dry` plan, which reads such an
     * index as the reset the real prune or run does first leaves it, empty,
     * with the store still reached, so it names what that prune takes.
     */
    mode: 'open' | 'inspect' | 'preview' = 'open',
    /**
     * The shared store's directory, unversioned: every key is seeded with
     * `CACHE_VERSION`, so two vx versions never read each other's entries,
     * and the store's own schema is `store_meta.schema` (`matchStoreSchema`). Or
     * `null` for an index that holds its entries itself (a `cacheDir`).
     * Undefined follows the layout the index records: a reading verb, a
     * plugin's handle.
     */
    storeRoot?: string | null,
    store: StoreOptions = DEFAULT_STORE,
  ) {
    this.ix = new StoreIndex(
      cacheDir,
      localPolicy,
      repoDir,
      artifactCeiling,
      mode,
      storeRoot,
      store,
    )
    indexes.set(this, this.ix)
  }

  /** The run this cache saves for: each entry it writes records it (`entries.run_id`). */
  get runId(): string | undefined {
    return this.ix.runId
  }
  set runId(runId: string | undefined) {
    this.ix.runId = runId
  }

  /** What the remotes said they hold, across runs (remote-hits.ts). */
  get remoteHits(): RemoteHits {
    return this.ix.remoteHits
  }

  /** The shared store this index attached, or undefined when it holds its entries itself. */
  get storeDir(): string | undefined {
    return this.ix.storeDir
  }

  /**
   * Set when THIS open found an index written by another `SCHEMA_VERSION`
   * and dropped every table. The next open sees the current version and
   * reports null. vx prints nothing for it: the cache is vx's to keep.
   */
  get schemaReset(): SchemaReset | null {
    return this.ix.schemaReset
  }

  /**
   * Set when THIS open found the shared store written under another
   * `SCHEMA_VERSION` and dropped its inventory; the artifacts stay and are
   * indexed again as they hit. Never printed: the cache is vx's to keep.
   */
  get storeReset(): SchemaReset | null {
    return this.ix.storeReset
  }

  /** The memos a task's key and hit read on this machine (`TaskMemo`). */
  get memo(): StoreMemo {
    return this.ix.localMemo
  }

  key(input: CacheKeyInput): Promise<string> {
    const hashFile = (f: string): Promise<string> => this.ix.localMemo.hashFile(f)
    return foldKey(
      input,
      hashFile,
      (f) => this.ix.localMemo.relFor(input.workspaceRoot, f),
      (v) => digestValue(this.ix, v),
      (link) => behindLink(link, hashFile),
    )
  }

  // Local cache has no slower layer to warm from — prefetch is a no-op.
  // The contract still resolves false so callers can treat every layer
  // uniformly (LayeredCache overrides with the real remote pull).
  async prefetch(_hash: string, _ctx?: CacheGetContext): Promise<boolean> {
    return false
  }
  // ctx is accepted but ignored — the local layer reads metadata from
  // the entries row. It's part of the contract so LayeredCache can
  // route metadata to `ingest()` on remote-hit without a separate API.
  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> {
    return lookup.get(this.ix, hash, ctx)
  }

  /**
   * Read an entry BYPASSING the local read gate. The gate means "don't
   * serve hits out of the PRE-EXISTING local cache" — it must not throw
   * away bytes this run just downloaded. `LayeredCache` calls this to
   * deliver an artifact it ingested from the remote; under
   * `--cache-policy=local:,remote:rw` the gated `get` returned null for the row
   * `ingest` had just written, so the task re-executed and re-uploaded on
   * every single run.
   */
  getIngested(hash: string): Promise<CacheEntry | null> {
    return lookup.getIngested(this.ix, hash)
  }

  getSaved(hash: string): Promise<CacheEntry | null> {
    return lookup.getSaved(this.ix, hash)
  }

  /**
   * Whether no lookup here can hit: no artifact, inline or file. Every
   * entry has one, and a row-less one is still a hit (`adopt`). The listing
   * is kept for `adopt`.
   */
  holdsNothing(): boolean {
    return lookup.holdsNothing(this.ix)
  }

  /**
   * `get` for many hashes at once: one `entries` query and one
   * `output_files` query per chunk instead of two per hash, with the
   * artifact-existence stats in flight together. Same answers as N calls
   * to `get` — a hash whose artifact is gone is simply absent from the map.
   * The up-front short-circuit probe is the caller; per-hit `get` stays for
   * the lazy path.
   */
  async getMany(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ): Promise<Map<string, CacheEntry>> {
    return lookup.getMany(this.ix, hashes, ctx)
  }

  // Existence probe: SQL row + where its artifact is (an inline one, or a
  // file on disk), no byte reads and no accessed_at bump (the plan path
  // must stay read-only).
  async has(hash: string): Promise<'local' | 'remote' | null> {
    return lookup.has(this.ix, hash)
  }

  /**
   * The subset of `hashes` this store holds, `has` for each: the prefetch
   * pass asks the remote only about the rest.
   */
  async localHasMany(hashes: readonly string[]): Promise<Set<string>> {
    return lookup.localHasMany(this.ix, hashes)
  }

  outputsPath(hash: string): string {
    return lookup.outputsPath(this.ix, hash)
  }

  outputBytes(hash: string): number | undefined {
    return lookup.outputBytes(this.ix, hash)
  }

  kept(hash: string): boolean {
    return lookup.kept(this.ix, hash)
  }

  artifactSize(hash: string): number | undefined {
    return lookup.artifactSize(this.ix, hash)
  }

  async restoreOutputs(
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
    outputs?: DeclaredOutputs,
  ): Promise<void> {
    return restoring.restoreOutputs(this.ix, hash, projectDir, workspaceRoot, outputs)
  }

  /**
   * A run writes here on every path — the run record at its end, an
   * entry's `accessed_at` on a hit, the artifact on a miss — so a cache
   * directory this user cannot write into fails the run before the graph
   * starts, once, with the directory named, rather than every task at
   * 0 ms (or the run at its very end) with SQLite's "attempt to write a
   * readonly database" as an internal error. The readers open the same
   * directory read-only and go on; a run refuses.
   */
  assertWritable(): void {
    saving.assertWritable(this.ix)
  }

  /**
   * A run over a cache directory it cannot write: one holding entries
   * serves its hits and saves nothing, and the line this
   * returns says so; an empty one has nothing to serve and refuses.
   */
  readOnlyNotice(): string | null {
    return saving.readOnlyNotice(this.ix)
  }

  async save(args: {
    hash: string
    /** See `CacheLayer.save` — `exitCode` is not a caller's to supply. */
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    outputDirs?: string[]
    workspaceOutputFiles?: string[]
    workspaceOutputDirs?: string[]
    workspaceRoot?: string
    inputComponents?: readonly TaskInputRow[]
    /** See `CacheLayer.save`. */
  }): Promise<void> {
    return saving.save(this.ix, args)
  }

  /**
   * Whether this local layer persists artifacts. The LayeredCache reads
   * it to decide between uploading the on-disk artifact (write enabled)
   * vs. packing bytes in memory (write disabled) for a remote upload.
   */
  get localWritesEnabled(): boolean {
    return saving.localWritesEnabled(this.ix)
  }

  /**
   * Pack the save args into tar.zst bytes WITHOUT touching disk or the
   * index. Used by the LayeredCache when local writes are disabled but
   * a remote upload still needs the artifact bytes.
   */
  packArtifactBytes(args: SaveArgs): Promise<Uint8Array> {
    return saving.packSavedBytes(this.ix, args)
  }

  /**
   * The artifact under a private second name, for a body read more than
   * once (a digest pass then an upload, a retry). The live name is not
   * stable: a re-save of the key renames other bytes over it, and a body
   * opened by path read those mid-upload (a digest of one artifact over
   * the bytes of another). A `Bun.file` over an fd is no answer — its
   * second read starts where the first ended. Throws when the artifact is
   * gone; `release` unlinks the name. An inline artifact is read once into
   * the body, which no re-save can change.
   */
  async pinArtifact(hash: string): Promise<{ body: Blob; release: () => Promise<void> }> {
    return saving.pinArtifact(this.ix, hash)
  }

  /**
   * The remote body goes to the temp by `Bun.write`, which streams a
   * `Response` and copies a file `Blob` without collecting either, so a
   * pull never holds the artifact. A body that fails mid-stream (a dropped
   * socket) leaves a partial temp behind it, removed here; validation
   * removes its own. A body of at most `cache.store.embeddings` bytes — by its size,
   * or counted as it streams — is read to memory and stored inline.
   */
  async ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> {
    return saving.ingest(this.ix, hash, body, meta)
  }

  /**
   * A run's saves from now on leave the WAL's checkpoints to a thread of
   * their own (checkpointer.ts), started by the first save's commit, so a
   * run that saves nothing starts none. `stopCheckpoints` ends it.
   */
  checkpointOffThread(): void {
    saving.checkpointOffThread(this.ix)
  }

  /** Ends the checkpoint thread before `close`, so this connection's close is the last. */
  async stopCheckpoints(): Promise<void> {
    return saving.stopCheckpoints(this.ix)
  }

  stats(opts: CacheStatsOptions = {}): CacheStats {
    return pruning.stats(this.ix, opts)
  }

  async prune(options: PruneOptions): Promise<PruneResult> {
    return pruning.prune(this.ix, options)
  }

  /** Row-less artifacts past the in-flight grace, for `vx info`: a prune reaps them by its policy. */
  async orphanStats(): Promise<{ orphans: number; orphanBytes: number }> {
    return pruning.orphanStats(this.ix)
  }

  close(): void {
    closeStore(this.ix)
  }
}

// The contract, the policy grammar and the zstd framing live beside this
// file; they are re-exported here so an importer of `./cache.js` — the
// module index, the sibling layers, the tests — keeps one path.
export * from './layer.js'
export * from './policy.js'
export { zstdContentSize } from './zstd.js'
export { DEFAULT_STORE, type SchemaReset, type StoreOptions } from './store-index.js'
export { holdCacheDir, holdStore, vxCacheEntries } from './cache-dir.js'
export { storedLog } from './store-index.js'
