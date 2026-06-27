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
  IngestMeta,
  OutputFileRow,
  PruneOptions,
  PruneResult,
  RunRecord,
  SaveArgs,
} from './cache.js'
import { FULL_CACHE_POLICY } from './cache.js'
import type { RemoteCache } from './remote-cache.js'

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

  private readonly policy: CachePolicy

  constructor(
    private readonly local: Cache,
    private readonly remote: RemoteCache,
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
    return await this.pullFromRemote(hash, ctx)
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

    // The artifact is now in local, but this *lookup* was a remote
    // hit — flip the source so callers can distinguish "saved work
    // via the remote cache" from "saved work via a prior local run".
    const materialized = await this.local.get(hash, ctx)
    return materialized ? { ...materialized, source: 'remote' } : null
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
    // Upload to remote. Normally we read the bytes the local layer just
    // wrote (same format on both sides, no repacking). But when local
    // writes are disabled (`--cache=local:,remote:rw`) there's no on-disk
    // artifact — pack the bytes in memory instead. Errors are logged, not
    // propagated: the task already succeeded; we don't fail it on cache-
    // server issues.
    try {
      const bytes = this.local.localWritesEnabled
        ? await Bun.file(this.local.outputsPath(args.hash)).bytes()
        : await this.local.packArtifactBytes(args)
      await this.remote.put(args.hash, bytes, { durationMs: args.entry.durationMs })
    } catch (err) {
      this.reportRemoteError(err)
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

  stats(): CacheStats {
    return this.local.stats()
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
