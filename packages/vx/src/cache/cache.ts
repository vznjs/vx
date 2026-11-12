// Content-addressed task cache: a SQLite index (`cache.db`) and one
// `<hash>.tar.zst` per entry holding only replayable bytes, the output log and
// the outputs. Entry metadata lives in the index; the same artifact bytes go to
// a remote unchanged, and `ingest` takes the metadata on a remote hit. Failed
// runs are never cached.
//
// With a shared store the entries and artifacts live in `<store>/`, attached to
// the workspace's own `cache.db`, which keeps the history and memos.
//
// This is core's floor: a remote is a `RemoteCacheLayer` that `LayeredCache`
// wraps around this handle. Every layer speaks `CacheLayer` (layer.ts).

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
 * `memo.hashFile(file)`, and `seen` told the ctime of the stat behind the
 * digest when the memo is core's own (the re-check's tie rule). Any other memo
 * tells nothing.
 */
export function hashFileSeen(
  memo: TaskMemo,
  file: string,
  seen: (ctimeMs: number) => void,
): Promise<string> {
  return ownHasher(memo) ? memo.hashFileSeen(file, seen) : memo.hashFile(file)
}

/**
 * Each of `files` by `memo.hashFile`, in one memo query when the memo is core's
 * own (a query per file took the lock each time). A file that cannot be hashed
 * is absent: the caller asks `hashFile`, and gets its error.
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
 * The hashes of every entry this machine holds for `taskId`: an additive task's
 * miss reads their rows to tell its own files from what it found. A layer with
 * no local index answers none.
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
 * The files a second connection writes a run's hits through; undefined when the
 * store keeps no history on disk.
 */
export function historyFiles(cache: Cache): { index: string; store?: string } | undefined {
  return historyFilesOf(storeIndexOf(cache))
}

/**
 * The cache's `bun:sqlite` handle, for core's readers (`vx last`, `vx why`,
 * history). A function, so plugins handed `Cache` never touch cache.db. Never
 * close it: `Cache.close()` does.
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
 * `err` as a reader of `indexDb(cache)` reports it: an unreadable page is
 * refused naming its file, not printed as a raw `SQLiteError`.
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
    // `accessed_at` is LRU bookkeeping, and throwing here would skip
    // `db.close()`. macOS answers SQLITE_IOERR_VNODE on a write to a removed
    // cache dir.
  }
  if (ix.checkpoints instanceof WalCheckpointer) ix.checkpoints.terminate()
  ix.checkpoints = undefined
  closeDb(ix.db)
}

const indexes = new WeakMap<Cache, StoreIndex>()

/** The store index behind `cache`, for the cache module and its tests only. */
export function storeIndexOf(cache: Cache): StoreIndex {
  return indexes.get(cache)!
}

export class Cache implements CacheLayer {
  /** This IS the local layer — there is nothing slower behind it. */
  readonly hasRemote = false
  /**
   * The run's uploads, tallied by a `LayeredCache` over this cache, so the run
   * reports them without a method on the layer seam.
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
     * The workspace root: where the file hasher asks git for the object format,
     * and whose output stamps this handle reads.
     */
    repoDir?: string,
    /**
     * The largest decoded artifact this cache saves, ingests or restores.
     * Lowered only by tests (`RunOptions.artifactCeiling`).
     */
    artifactCeiling: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
    /**
     * `'inspect'`: a reading verb, which never resets the index; an unreadable
     * schema is refused and left alone. `'preview'`: a dry prune or `--dry`
     * plan, which reads such an index as the reset would leave it.
     */
    mode: 'open' | 'inspect' | 'preview' = 'open',
    /**
     * The shared store's directory. Unversioned: keys are seeded with
     * `CACHE_VERSION`, and the store's schema is `store_meta.schema`. `null`
     * for an index holding its own entries; undefined follows what the index
     * records.
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
   * Set when THIS open found another `SCHEMA_VERSION` and dropped every table.
   * Never printed: the cache is vx's to keep.
   */
  get schemaReset(): SchemaReset | null {
    return this.ix.schemaReset
  }

  /**
   * Set when THIS open found the shared store under another `SCHEMA_VERSION`
   * and dropped its inventory; artifacts stay and are indexed again as they
   * hit.
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

  // Nothing slower to warm from; resolves false like every layer.
  async prefetch(_hash: string, _ctx?: CacheGetContext): Promise<boolean> {
    return false
  }
  // `ctx` is ignored: the local layer reads metadata from its row.
  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> {
    return lookup.get(this.ix, hash, ctx)
  }

  /**
   * Read an entry past the local read gate, which keeps the PRE-EXISTING local
   * cache from serving hits, not bytes this run just downloaded. `LayeredCache`
   * delivers an ingested remote artifact through it; through the gated `get`,
   * `local:,remote:rw` re-ran and re-uploaded every task each run.
   */
  getIngested(hash: string): Promise<CacheEntry | null> {
    return lookup.getIngested(this.ix, hash)
  }

  getSaved(hash: string): Promise<CacheEntry | null> {
    return lookup.getSaved(this.ix, hash)
  }

  /** Whether no lookup here can hit. The listing is kept for `adopt`. */
  holdsNothing(): boolean {
    return lookup.holdsNothing(this.ix)
  }

  /**
   * `get` for many hashes: one query per chunk instead of two per hash. Same
   * answers; a hash whose artifact is gone is absent.
   */
  async getMany(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ): Promise<Map<string, CacheEntry>> {
    return lookup.getMany(this.ix, hashes, ctx)
  }

  // Existence probe: no byte reads, no `accessed_at` bump (the plan path stays
  // read-only).
  async has(hash: string): Promise<'local' | 'remote' | null> {
    return lookup.has(this.ix, hash)
  }

  /** The subset of `hashes` this store holds. */
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
   * A run writes here on every path, so a cache directory this user cannot
   * write fails the run once, before the graph, naming the directory. Readers
   * open it read-only and go on.
   */
  assertWritable(): void {
    saving.assertWritable(this.ix)
  }

  /**
   * A run over a cache directory it cannot write: one holding entries serves
   * its hits, saves nothing and says so; an empty one refuses.
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
   * Whether this layer persists artifacts: `LayeredCache` uploads the file when
   * it does, else packs bytes in memory.
   */
  get localWritesEnabled(): boolean {
    return saving.localWritesEnabled(this.ix)
  }

  /**
   * Pack the save args into tar.zst bytes without touching disk or the index,
   * for a remote upload when local writes are off.
   */
  packArtifactBytes(args: SaveArgs): Promise<Uint8Array> {
    return saving.packSavedBytes(this.ix, args)
  }

  /**
   * The artifact under a private second name, for a body read more than once (a
   * digest then an upload, a retry): a re-save renames other bytes over the
   * live name. Throws when it is gone; `release` unlinks it. An inline artifact
   * is read once into the body.
   */
  async pinArtifact(hash: string): Promise<{ body: Blob; release: () => Promise<void> }> {
    return saving.pinArtifact(this.ix, hash)
  }

  /**
   * `Bun.write` streams the remote body to the temp without collecting it. A
   * body that fails mid-stream leaves a partial temp, removed here. A body of
   * at most `cache.store.embeddings` bytes is read to memory and stored inline.
   */
  async ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> {
    return saving.ingest(this.ix, hash, body, meta)
  }

  /**
   * From now on the WAL's checkpoints run on a thread of their own
   * (checkpointer.ts), started by the first save. `stopCheckpoints` ends it.
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

// Re-exported so an importer of `./cache.js` keeps one path.
export * from './layer.js'
export * from './policy.js'
export { zstdContentSize } from './zstd.js'
export { DEFAULT_STORE, type SchemaReset, type StoreOptions } from './store-index.js'
export { holdCacheDir, holdStore, vxCacheEntries } from './cache-dir.js'
export { storedLog } from './store-index.js'
