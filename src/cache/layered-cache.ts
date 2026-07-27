// LayeredCache — composes the local cache with a remote HTTP cache.
//
// Read path:  try local. On miss, try remote; on remote hit, ingest
// the artifact bytes into local so the next read is a local hit.
//
// Write path: write to local synchronously. Upload the local artifact
// to remote as a fire-and-forget background task; failures log a
// warning but never fail the user's run (the task already succeeded;
// the only loss is the remote cache entry).
//
// The local and remote layers share the SAME artifact format — the
// `<hash>.tar.zst` bytes ship across the wire verbatim. Metadata
// (taskId, command, durationMs) travels separately: the caller
// supplies it to `get()` via the `ctx` arg, and the remote layer
// surfaces `durationMs` from its response. No stage dirs, no
// meta.json, no tar.gz wrapping — the artifact is what it is.

import type { Cache } from './cache.js'
import type {
  CacheEntry,
  CacheGetContext,
  CacheKeyInput,
  CacheLayer,
  CachePolicy,
  CacheStats,
  CacheStatsOptions,
  IngestMeta,
  InvocationRecord,
  OutputFileRow,
  PruneOptions,
  PruneResult,
  RunRecord,
  SaveArgs,
} from './cache.js'
import { FULL_CACHE_POLICY } from './cache.js'

/**
 * What a remote cache layer must provide — THE plugin seam for remote
 * caching. Core ships no wire client; a plugin's `cache` capability (or an
 * embedder via `RunOptions.remoteCache`) supplies an implementation speaking
 * whatever protocol it wants, and `LayeredCache` owns everything else:
 * policy gating, in-flight dedup, remote provenance, and the never-fail
 * contract (implementations THROW on failure; LayeredCache degrades every
 * throw to a cache miss via `onRemoteError`). The artifact bytes are the
 * local `<hash>.tar.zst` verbatim. See
 * docs/design/native-cache-wire-2026-07.md.
 */
export interface RemoteCacheLayer {
  /** Existence probe (drives the plan path's `--dry` remote prediction). */
  has(hash: string): Promise<boolean>
  /**
   * Optional batch existence probe: given N hashes, return the subset stored
   * remotely in ONE round-trip. Lets the prefetch pass collapse N per-hash
   * network probes into one, then fetch only the hits. A remote that can't
   * batch omits this method (or returns `null`) and the layer falls back to
   * the per-hash path. Never throws for control flow — `null` means "no batch
   * info; use per-hash".
   */
  hasMany?(hashes: readonly string[]): Promise<Set<string> | null>
  /** Fetch an artifact's bytes; `null` = miss. `durationMs` is the
   *  producing task's duration when the wire carries it. */
  get(hash: string): Promise<{ body: ArrayBuffer; durationMs: number | undefined } | null>
  /** Store an artifact (fire-and-forget from LayeredCache's perspective). */
  put(hash: string, body: ArrayBuffer | Uint8Array, meta: { durationMs: number }): Promise<void>
}

/**
 * Cap on concurrent background PUTs. Keeps a burst of cache misses from
 * opening one socket per task; excess uploads queue and drain FIFO.
 */
const UPLOAD_CONCURRENCY = 4

export interface LayeredCacheOptions {
  /** Called for remote-related errors that the layer suppresses. */
  onRemoteError?: (err: Error) => void
  /**
   * The 4-axis read/write policy. The local slice (read/write) is
   * already applied to the inner `Cache` by the caller; this layer reads
   * `remoteRead` / `remoteWrite` to gate its OWN remote operations.
   * Default: everything on.
   */
  policy?: CachePolicy
}

export class LayeredCache implements CacheLayer {
  /** A remote layer is composed in by construction — see `CacheLayer.hasRemote`. */
  readonly hasRemote = true

  /**
   * In-flight remote pulls keyed by hash. `prefetch` and `get` both go
   * through here, so a key probed concurrently by both resolves a
   * SINGLE remote GET. Each promise resolves `true` iff the artifact
   * was successfully ingested into local. Entries are retained for the
   * run's lifetime: a settled `false` records "remote already had no
   * such artifact (or it was corrupt)", which lets `get` skip a second
   * lazy probe of the same dead hash. The map is bounded by the number
   * of distinct task keys in a run — negligible.
   */
  private readonly inflight = new Map<string, Promise<boolean>>()

  /**
   * Hashes whose local artifact was materialized FROM the remote layer
   * this run (by `prefetch` or `get`'s read-through). A later `get`
   * finds them as a local hit, but the work was still saved by the
   * remote cache — so we flip `source` to `'remote'` and the
   * orchestrator reports `cache-hit-remote`. Without this, a prefetch
   * followed by a `get` would mislabel a genuine remote hit as local.
   */
  private readonly remoteSourced = new Set<string>()

  /**
   * Background write-through uploads. `save()` returns after the local
   * write + byte capture; the PUT runs here so a cache-miss task never
   * holds its scheduler worker slot for the upload round-trip. Bounded
   * at UPLOAD_CONCURRENCY; `run()` awaits `drainUploads()` before
   * `cache.close()`.
   */
  private readonly uploadQueue: Array<() => Promise<void>> = []
  private activeUploads = 0
  private drainWaiters: Array<() => void> = []

  private readonly policy: CachePolicy

  constructor(
    private readonly local: Cache,
    private readonly remote: RemoteCacheLayer,
    private readonly options: LayeredCacheOptions = {},
  ) {
    this.policy = options.policy ?? FULL_CACHE_POLICY
  }

  async key(input: CacheKeyInput): Promise<string> {
    return await this.local.key(input)
  }

  async prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    // No-op when remote reads are off — there's nothing to warm from.
    if (!this.policy.remoteRead) return false
    // The local-first skip lives in doPullFromRemote (the shared choke
    // point): pullFromRemote registers the `inflight` entry SYNCHRONOUSLY,
    // so a concurrent markRemoteAbsent can't clobber a pending pull — a
    // guard done here (behind an async local.has) would reopen that race.
    return await this.pullFromRemote(hash, ctx)
  }

  /**
   * Batch existence probe over the remote layer — the subset of `hashes`
   * present remotely, in one round-trip, or `null` when the remote can't
   * batch (no `hasMany`, reads disabled, or an error). The prefetch pass uses
   * this to fetch only the hits and to pre-mark the misses (`markRemoteAbsent`)
   * so their lazy `get` skips the network. Never throws — a batch failure
   * degrades to "no batch info" and the caller falls back to per-hash.
   */
  async remoteHasMany(hashes: readonly string[]): Promise<Set<string> | null> {
    if (!this.policy.remoteRead || this.remote.hasMany === undefined) return null
    try {
      return await this.remote.hasMany(hashes)
    } catch (err) {
      this.reportRemoteError(err)
      return null
    }
  }

  /**
   * Record that the remote layer has NO artifact for each of `hashes` (from a
   * batch probe), so a later `get`/`prefetch` short-circuits to a miss WITHOUT
   * a network round-trip. Byte-for-byte equivalent to a background prefetch GET
   * having resolved `false` into `inflight` — same at-most-once semantics, same
   * point-in-time staleness window — but without spending the GET. Never
   * overwrites an entry already in flight.
   */
  markRemoteAbsent(hashes: Iterable<string>): void {
    for (const hash of hashes) {
      if (!this.inflight.has(hash)) this.inflight.set(hash, Promise.resolve(false))
    }
  }

  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> {
    const localHit = await this.local.get(hash, ctx)
    if (localHit) {
      // A prefetch this run may have materialized this entry FROM
      // remote; the local row exists now, but the work was saved by
      // the remote cache, so the provenance stays 'remote'.
      return this.remoteSourced.has(hash) ? { ...localHit, source: 'remote' } : localHit
    }

    // Remote reads disabled (e.g. `--cache=remote:`): a local miss is a
    // real miss; never touch the remote layer.
    if (!this.policy.remoteRead) return null

    // A prefetch may already have probed this hash (resolved) or be
    // mid-flight. Awaiting the shared promise guarantees AT MOST ONE
    // remote GET per key: a settled `false` means remote had nothing
    // (no second probe), and a settled/in-flight `true` means the
    // artifact was/will-be ingested locally — re-read below.
    const ingested = await this.pullFromRemote(hash, ctx)
    if (!ingested) return null

    // Read past the local READ gate: `ingest` is deliberately ungated, so
    // the artifact + index row this pull just wrote exist regardless of
    // policy, and the gate ("don't serve hits from the pre-existing local
    // cache") must not discard them. Going through the gated `get` here
    // made `--cache=local:,remote:rw` download the artifact, throw the hit
    // away, re-execute and re-upload — on every run, forever.
    const materialized = await this.local.getIngested(hash)
    if (!materialized) return null

    // `remoteSourced` — not merely "the pull returned true" — is what says
    // the remote cache saved this work. `doPullFromRemote` also returns true
    // for its local-first skip, which issues NO remote GET: when a run
    // sharing this cache dir ingests the artifact between the local read
    // above and that skip's `local.has`, stamping 'remote' here reported a
    // purely-local hit as `cache-hit-remote` and inflated the remote
    // hit-rate. Whatever provenance the entry has is the truth.
    return this.remoteSourced.has(hash) ? { ...materialized, source: 'remote' } : materialized
  }

  // Existence probe: local first, then a remote HEAD — no body
  // transfer, no ingest, so the plan path stays read-only even against
  // a remote cache. Remote errors degrade to a miss (never throw).
  async has(hash: string): Promise<'local' | 'remote' | null> {
    if ((await this.local.has(hash)) === 'local') return 'local'
    if (!this.policy.remoteRead) return null
    try {
      return (await this.remote.has(hash)) ? 'remote' : null
    } catch (err) {
      this.reportRemoteError(err)
      return null
    }
  }

  /**
   * Single implementation of the remote read-through, shared by
   * `prefetch` and `get`. Idempotent per hash via `inflight`: the first
   * caller starts the GET + validate + ingest; concurrent and later
   * callers await the same promise. Resolves `true` when the artifact
   * ends up in local, `false` on a remote miss / error / corruption
   * (degrades to a cache miss; the error is reported, never thrown).
   */
  private pullFromRemote(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    const existing = this.inflight.get(hash)
    if (existing) return existing
    const p = this.doPullFromRemote(hash, ctx)
    this.inflight.set(hash, p)
    return p
  }

  private async doPullFromRemote(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    // Local-first, mirroring get()/has(): if local ALREADY holds the artifact
    // there is nothing to pull — skip the remote GET (a warm-local run would
    // otherwise re-download every artifact it already has) and DON'T mark it
    // `remoteSourced` (that would mislabel a purely-local warm hit as
    // cache-hit-remote and inflate the remote hit-rate). Returning `true` is
    // correct for a get() read-through too: "the artifact is in local" — the
    // caller re-reads it, keeping whatever provenance it already had (local,
    // or remote if a concurrent prefetch set it).
    if ((await this.local.has(hash)) === 'local') return true

    let remoteResult
    try {
      remoteResult = await this.remote.get(hash)
    } catch (err) {
      this.reportRemoteError(err)
      return false
    }
    if (!remoteResult) return false

    // Ingest the remote bytes into local using the caller-supplied
    // taskId/command plus the remote-reported durationMs. The remote
    // layer carries durationMs as an HTTP header (x-artifact-duration);
    // taskId + command come from the orchestrator's TaskNode in scope.
    // Without `ctx`, we can't populate a meaningful entries row, so
    // ingest with placeholders — caller-side typing nudges everyone
    // toward passing ctx.
    const meta: IngestMeta = {
      taskId: ctx?.taskId ?? `${hash}#unknown`,
      command: ctx?.command ?? '',
      durationMs: remoteResult.durationMs ?? 0,
    }
    try {
      await this.local.ingest(hash, new Uint8Array(remoteResult.body), meta)
    } catch (err) {
      // The bytes came off the network — a corrupt/truncated remote
      // artifact must degrade to a cache miss (task re-executes), not
      // crash the run. Local-layer reads outside this block still
      // propagate: local corruption is a real fault, not a network one.
      this.reportRemoteError(err)
      return false
    }
    this.remoteSourced.add(hash)
    return true
  }

  outputsPath(hash: string): string {
    return this.local.outputsPath(hash)
  }

  async hashFile(filePath: string): Promise<string> {
    return await this.local.hashFile(filePath)
  }

  async restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void> {
    await this.local.restoreOutputs(hash, projectDir, workspaceRoot)
  }

  async save(args: SaveArgs): Promise<void> {
    // Local write honors its own gate inside Cache.save (no-op when
    // local writes are disabled).
    await this.local.save(args)
    if (!this.policy.remoteWrite) return
    // Write-through upload, OFF the task's critical path: the PUT runs in
    // the bounded background pool so the task's worker slot is released
    // immediately, and `run()` awaits `drainUploads()` before closing the
    // cache. Errors are logged, not propagated: the task already
    // succeeded; we don't fail it on cache-server issues.
    //
    // The artifact bytes are read INSIDE the job, not here.
    // UPLOAD_CONCURRENCY bounds sockets, not memory: a queued closure
    // holding its own artifact keeps the WHOLE backlog resident, so peak
    // RSS scaled with a run's total miss artifact bytes rather than with
    // the pool — any cold monorepo run whose remote uploads slower than the
    // build produces artifacts held every pending one at once. Reading in
    // the job caps resident artifact bytes at UPLOAD_CONCURRENCY. The
    // artifact is content-addressed and immutable, so a deferred read sees
    // the same bytes; if a concurrent `vx cache prune` removed it first the
    // read throws and this upload is skipped — the never-fail contract.
    const hash = args.hash
    const durationMs = args.entry.durationMs
    // Local writes disabled (`--cache=local:,remote:rw`): there is no
    // on-disk artifact to read later, so the bytes must be packed NOW,
    // while this task's output files are still on disk. Deferring THIS
    // read would pack whatever the tree happens to hold when the job
    // runs. Such a run keeps the old memory profile by necessity — the
    // bytes exist nowhere else.
    let packed: Uint8Array | undefined
    if (!this.local.localWritesEnabled) {
      try {
        packed = await this.local.packArtifactBytes(args)
      } catch (err) {
        this.reportRemoteError(err)
        return
      }
    }
    this.enqueueUpload(async () => {
      try {
        const bytes = packed ?? (await Bun.file(this.local.outputsPath(hash)).bytes())
        await this.remote.put(hash, bytes, { durationMs })
      } catch (err) {
        this.reportRemoteError(err)
      }
    })
  }

  /**
   * Resolves once every queued + in-flight background upload settles.
   * `run()` calls this next to the prefetch drain, before
   * `cache.close()` — an upload reading state after close would race.
   */
  async drainUploads(): Promise<void> {
    if (this.activeUploads === 0 && this.uploadQueue.length === 0) return
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
  }

  private enqueueUpload(job: () => Promise<void>): void {
    this.uploadQueue.push(job)
    this.pumpUploads()
  }

  private pumpUploads(): void {
    while (this.activeUploads < UPLOAD_CONCURRENCY && this.uploadQueue.length > 0) {
      const job = this.uploadQueue.shift()!
      this.activeUploads++
      // Jobs never reject (each wraps its PUT in the never-fail guard).
      void job().finally(() => {
        this.activeUploads--
        this.pumpUploads()
      })
    }
    if (this.activeUploads === 0 && this.uploadQueue.length === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters
      this.drainWaiters = []
      for (const w of waiters) w()
    }
  }

  async ingest(hash: string, compressed: Uint8Array, meta: IngestMeta): Promise<void> {
    await this.local.ingest(hash, compressed, meta)
  }

  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    // Output-file fingerprints live in the local SQLite layer only —
    // they describe the state on this machine's filesystem.
    return this.local.loadOutputFilesBatch(hashes)
  }

  async isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean> {
    return this.local.isOutputsCurrent(projectDir, expected)
  }

  recordRun(run: RunRecord): void {
    this.local.recordRun(run)
  }

  recordRuns(runs: readonly RunRecord[]): void {
    this.local.recordRuns(runs)
  }

  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void {
    this.local.recordRunBundle(bundle)
  }

  stats(opts?: CacheStatsOptions): CacheStats {
    return this.local.stats(opts)
  }

  async prune(options: PruneOptions): Promise<PruneResult> {
    return await this.local.prune(options)
  }

  close(): void {
    this.local.close()
  }

  private reportRemoteError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err))
    // The remote cache is fully optional: NO remote failure — a 500, a
    // network drop, a corrupt artifact, even a throwing onRemoteError
    // callback — may ever fail the run. We report and degrade to a
    // cache miss. The callback is guarded so a buggy reporter can't
    // turn an optional-cache hiccup into a run failure.
    try {
      if (this.options.onRemoteError) {
        this.options.onRemoteError(e)
      } else {
        process.stderr.write(`[vx] remote cache: ${e.message}\n`)
      }
    } catch {
      // swallow — reporting must never escalate
    }
  }
}
