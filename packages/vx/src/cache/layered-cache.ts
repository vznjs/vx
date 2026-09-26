// LayeredCache — composes the local cache with a remote HTTP cache.
//
// Read path:  try local. On miss, try remote; on remote hit, stream
// the artifact body into local so the next read is a local hit.
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
import { FULL_CACHE_POLICY, type OutputDirRow } from './cache.js'

/**
 * What a remote cache layer must provide — THE plugin seam for remote
 * caching. Core ships no wire client; a plugin's `cache` capability (or an
 * embedder via `RunOptions.remoteCache`) supplies an implementation speaking
 * whatever protocol it wants, and `LayeredCache` owns everything else:
 * policy gating, in-flight dedup, remote provenance, and the never-fail
 * contract (implementations THROW on failure; LayeredCache degrades every
 * throw to a cache miss via `onRemoteError`). The artifact bytes are the
 * local `<hash>.tar.zst` verbatim. The wires live in plugin packages
 * (`@vzn/vx-migrate`'s `turboCache()` and `nxCache()`, `@vzn/vx-reapi`); see
 * docs/modules/layered-cache.md.
 *
 * Core awaits every call and bounds none: a `get` that never settles
 * holds its task and a `put` the run's upload drain, so each request
 * carries the layer's own deadline (every first-party layer has one; the
 * plugin guide's example shows it).
 */
export interface RemoteCacheLayer {
  /**
   * Where the layer's artifacts live, named in every degrade warning
   * (`upload <hash> to <endpoint> failed: …`): a base URL or `host:port`.
   * Never a credential: a URL's `user:pass@`, query and fragment are
   * dropped before it is printed.
   */
  readonly endpoint?: string
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
  /**
   * Fetch an artifact; `null` = miss. `body` is read once, by core,
   * straight into the local cache — an HTTP wire returns its `fetch`
   * `Response`, a chunked wire `new Response(stream)`, bytes in hand
   * `new Blob([bytes])`. `durationMs` is the producing task's duration
   * when the wire carries it.
   */
  get(hash: string): Promise<{ body: Blob | Response; durationMs: number | undefined } | null>
  /**
   * Store an artifact (fire-and-forget from LayeredCache's perspective).
   * `body` is file-backed (`Bun.file`) when the local store holds the
   * artifact, so a plugin that streams it never holds it whole.
   */
  put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void>
}

/**
 * What a remote layer resolves is a plugin's, so its shape is a boundary
 * (item 252): a `get` that resolved `{ body: 'abc' }` was reported as
 * "corrupt artifact … not a readable archive" — the bytes blamed for the
 * plugin's shape — and a `hasMany` that resolved an array reached the
 * prefetch pass's `.has()`. Named here and degraded to a miss, like every
 * other remote failure.
 */
function invalidRemoteResult(what: string): Error {
  return new Error(
    `remote cache layer returned an invalid result: ${what} — a plugin bug, degraded to a miss`,
  )
}

function isBody(value: unknown): value is Blob | Response {
  return value instanceof Blob || value instanceof Response
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  // The pre-stream contract's shape, named so an unported layer reads its fix.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    return `a ${value.constructor.name}`
  return typeof value === 'object' ? 'an object' : typeof value
}

/**
 * Cap on concurrent background PUTs. Keeps a burst of cache misses from
 * opening one socket per task; excess uploads queue and drain FIFO.
 */
const UPLOAD_CONCURRENCY = 4

/** The seam call a failure happened in, as the warning names it. */
type RemoteOp = 'probe' | 'download' | 'upload'

const PREPOSITION: Record<RemoteOp, string> = { probe: 'at', download: 'from', upload: 'to' }

/** The layer's `endpoint` as it may be printed: no userinfo, query or fragment. */
function printableEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string' || endpoint === '') return undefined
  if (!URL.canParse(endpoint)) return endpoint
  const u = new URL(endpoint)
  if (u.username === '' && u.password === '' && u.search === '' && u.hash === '') return endpoint
  u.username = ''
  u.password = ''
  u.search = ''
  u.hash = ''
  return u.toString()
}

/**
 * What makes two failures "the same way": the error's `code` when it
 * carries one (a gRPC status, an errno, Bun's `ConnectionRefused`), because
 * gRPC writes the elapsed time into its message and no two deadline messages
 * match; else the message with the artifact's hash taken out, so a 500 on
 * one hash and a 500 on the next are one class. The operation is not part of
 * it: an unreachable server fails the probe, the download and the upload
 * alike, and that is one fact.
 */
function failureClass(err: Error, hash: string | undefined): string {
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' || typeof code === 'number') return `${err.name}\0${code}`
  return hash === undefined ? err.message : err.message.replaceAll(hash, '\0')
}

/** A batch probe names no one hash, so its line counts them. */
function batchOf(hashes: readonly string[]): { batch: string } {
  return { batch: `of ${hashes.length} artifact${hashes.length === 1 ? '' : 's'}` }
}

export interface LayeredCacheOptions {
  /**
   * Called for the remote failures the layer degrades to a miss, once per
   * failure class per layer (`upload <hash> to <endpoint> failed: <cause>`,
   * with the original error as `cause`); the repeats are counted and said
   * once more at `close()` (`<n> more requests failed the same way: <cause>`).
   */
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
  private readonly endpoint: string | undefined

  /**
   * One entry per failure class said: its first line went out, `repeats`
   * counts the ones held back. A run's requests are concurrent, so an
   * unreachable server otherwise printed its bare runtime message once per
   * request (three lines for one task over the Turbo wire, item 749).
   */
  private readonly reported = new Map<string, { cause: string; repeats: number }>()

  constructor(
    readonly local: Cache,
    private readonly remote: RemoteCacheLayer,
    private readonly options: LayeredCacheOptions = {},
  ) {
    this.policy = options.policy ?? FULL_CACHE_POLICY
    this.endpoint = printableEndpoint(remote.endpoint)
  }

  key(input: CacheKeyInput): Promise<string> {
    return this.local.key(input)
  }

  async prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    // No-op when remote reads are off — there's nothing to warm from.
    if (!this.policy.remoteRead) return false
    // The local-first skip lives in doPullFromRemote (the shared choke
    // point): pullFromRemote registers the `inflight` entry SYNCHRONOUSLY,
    // so a concurrent markRemoteAbsent can't clobber a pending pull — a
    // guard done here (behind an async local.has) would reopen that race.
    return this.pullFromRemote(hash, ctx)
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
      // `return await`, deliberately: the catch below is the never-fail
      // contract, and a returned promise's rejection would sail past it.
      const found: unknown = await this.remote.hasMany(hashes)
      if (found !== null && found !== undefined && !(found instanceof Set)) {
        this.reportRemoteError(
          'probe',
          batchOf(hashes),
          invalidRemoteResult(
            `hasMany() resolved ${describeValue(found)} (expected a Set of the hashes present, or null)`,
          ),
        )
        return null
      }
      return found ?? null
    } catch (err) {
      this.reportRemoteError('probe', batchOf(hashes), err)
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
      this.reportRemoteError('probe', hash, err)
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

    let remoteResult: unknown
    try {
      remoteResult = await this.remote.get(hash)
    } catch (err) {
      this.reportRemoteError('download', hash, err)
      return false
    }
    if (!remoteResult) return false
    if (typeof remoteResult !== 'object' || !isBody((remoteResult as { body?: unknown }).body)) {
      const shape =
        typeof remoteResult !== 'object'
          ? describeValue(remoteResult)
          : `body is ${describeValue((remoteResult as { body?: unknown }).body)}`
      this.reportRemoteError(
        'download',
        hash,
        invalidRemoteResult(
          `get() resolved ${shape} (expected { body: Blob | Response, durationMs } or null)`,
        ),
      )
      return false
    }
    const remoteBody = remoteResult as { body: Blob | Response; durationMs?: number }

    // Ingest the remote body into local using the caller-supplied
    // taskId/command plus the remote-reported durationMs. The remote
    // layer carries durationMs as an HTTP header (x-artifact-duration);
    // taskId + command come from the orchestrator's TaskNode in scope.
    // Without `ctx`, we can't populate a meaningful entries row, so
    // ingest with placeholders — caller-side typing nudges everyone
    // toward passing ctx.
    const meta: IngestMeta = {
      taskId: ctx?.taskId ?? `${hash}#unknown`,
      command: ctx?.command ?? '',
      durationMs: typeof remoteBody.durationMs === 'number' ? remoteBody.durationMs : 0,
    }
    try {
      await this.local.ingest(hash, remoteBody.body, meta)
    } catch (err) {
      // The bytes came off the network — a corrupt/truncated remote
      // artifact must degrade to a cache miss (task re-executes), not
      // crash the run. Local-layer reads outside this block still
      // propagate: local corruption is a real fault, not a network one.
      this.reportRemoteError('download', hash, err)
      return false
    }
    this.remoteSourced.add(hash)
    return true
  }

  outputsPath(hash: string): string {
    return this.local.outputsPath(hash)
  }

  hashFile(filePath: string): Promise<string> {
    return this.local.hashFile(filePath)
  }

  async restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void> {
    await this.local.restoreOutputs(hash, projectDir, workspaceRoot)
  }

  async save(args: SaveArgs): Promise<void> {
    // Local write honors its own gates inside Cache.save (no-op when local
    // writes are disabled, or when ChainedCache marked this a duplicate save
    // to a shared local handle — see `skipLocalWrite` on the contract).
    await this.local.save(args)
    if (!this.policy.remoteWrite) return
    // Write-through upload, OFF the task's critical path: the PUT runs in
    // the bounded background pool so the task's worker slot is released
    // immediately, and `run()` awaits `drainUploads()` before closing the
    // cache. Errors are logged, not propagated: the task already
    // succeeded; we don't fail it on cache-server issues.
    //
    // The job hands the plugin a file-backed Blob over the local artifact,
    // opened when the plugin reads it: a queued job holds a path, not a
    // buffer, and a plugin that streams the Blob never holds it whole. The
    // artifact is content-addressed and immutable, so a deferred read sees
    // the same bytes; if a concurrent `vx cache prune` removed it first the
    // plugin's read throws and this upload is skipped — the never-fail
    // contract.
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
        this.reportRemoteError('upload', hash, err)
        return
      }
    }
    this.enqueueUpload(async () => {
      try {
        const body =
          packed !== undefined ? new Blob([packed]) : Bun.file(this.local.outputsPath(hash))
        await this.remote.put(hash, body, { durationMs })
      } catch (err) {
        this.reportRemoteError('upload', hash, err)
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

  async ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> {
    await this.local.ingest(hash, body, meta)
  }

  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    // Output-file fingerprints live in the local SQLite layer only —
    // they describe the state on this machine's filesystem.
    return this.local.loadOutputFilesBatch(hashes)
  }

  async isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean> {
    return this.local.isOutputsCurrent(projectDir, expected)
  }

  recordOutputDirs(hash: string, projectDir: string, prefixes: readonly string[]): Promise<void> {
    return this.local.recordOutputDirs(hash, projectDir, prefixes)
  }

  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    return this.local.loadOutputDirsBatch(hashes)
  }

  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean> {
    return this.local.outputDirsCurrent(projectDir, rows)
  }

  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void {
    this.local.recordRunBundle(bundle)
  }

  stats(opts?: CacheStatsOptions): CacheStats {
    return this.local.stats(opts)
  }

  prune(options: PruneOptions): Promise<PruneResult> {
    return this.local.prune(options)
  }

  /** `run()` drains the uploads and prefetches first, so the repeat counts are final here. */
  close(): void {
    for (const { cause, repeats } of this.reported.values()) {
      if (repeats === 0) continue
      this.emit(
        new Error(
          `${repeats} more request${repeats === 1 ? '' : 's'} failed the same way: ${cause}`,
        ),
      )
    }
    this.reported.clear()
    this.local.close()
  }

  /**
   * `subject` is the artifact's hash, or the batch for a `hasMany`. The
   * wire's own message says what went wrong but not on what or where: an
   * upload deadline read `The operation timed out.` with no upload, hash or
   * server in it (item 749).
   */
  private reportRemoteError(op: RemoteOp, subject: string | { batch: string }, err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err))
    const hash = typeof subject === 'string' ? subject : undefined
    const cls = failureClass(e, hash)
    const seen = this.reported.get(cls)
    if (seen !== undefined) {
      seen.repeats++
      return
    }
    this.reported.set(cls, { cause: e.message, repeats: 0 })
    const what = typeof subject === 'string' ? subject : subject.batch
    const where = this.endpoint === undefined ? '' : ` ${PREPOSITION[op]} ${this.endpoint}`
    this.emit(new Error(`${op} ${what}${where} failed: ${e.message}`, { cause: e }))
  }

  private emit(e: Error): void {
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
