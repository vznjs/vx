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

import type {
  CacheEntry,
  CacheEntryMeta,
  CacheGetContext,
  CacheKeyInput,
  CacheLayer,
  CacheStats,
  IngestMeta,
  OutputFileRow,
  PruneOptions,
  PruneResult,
  RunRecord,
  SaveArgs,
  TaskHistoryMap,
} from './cache.js'
import type { RemoteCache } from './remote-cache.js'

export interface LayeredCacheOptions {
  /** Called for remote-related errors that the layer suppresses. */
  onRemoteError?: (err: Error) => void
  /** Called when a remote miss → local materialization completes. */
  onRemoteHit?: (hash: string, bytes: number) => void
  /**
   * Fired once per attempted remote HTTP request: `GET` (read),
   * `PUT` (write), `HEAD` (existence check; not yet emitted but
   * reserved for future use). The TUI consumes these via
   * `Observer.emit({ kind: 'remoteCache', ... })` to drive the
   * remote-cache stats panel.
   *
   * `ok=false` covers both transport errors (caught and reported via
   * `onRemoteError`) and HTTP non-2xx responses (the RemoteCache
   * client throws on those too).
   */
  onRemoteRequest?: (event: {
    op: 'GET' | 'PUT' | 'HEAD'
    hash: string
    bytes?: number
    latencyMs: number
    ok: boolean
  }) => void
}

export class LayeredCache implements CacheLayer {
  constructor(
    private readonly local: CacheLayer,
    private readonly remote: RemoteCache,
    private readonly options: LayeredCacheOptions = {},
  ) {}

  async key(input: CacheKeyInput): Promise<string> {
    return await this.local.key(input)
  }

  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> {
    const localHit = await this.local.get(hash, ctx)
    if (localHit) return localHit

    let remoteResult
    const t0 = performance.now()
    try {
      remoteResult = await this.remote.get(hash)
    } catch (err) {
      this.options.onRemoteRequest?.({
        op: 'GET',
        hash,
        latencyMs: performance.now() - t0,
        ok: false,
      })
      this.reportRemoteError(err)
      return null
    }
    this.options.onRemoteRequest?.({
      op: 'GET',
      hash,
      ...(remoteResult ? { bytes: remoteResult.body.byteLength } : {}),
      latencyMs: performance.now() - t0,
      ok: true,
    })
    if (!remoteResult) return null

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
    await this.local.ingest(hash, new Uint8Array(remoteResult.body), meta)
    this.options.onRemoteHit?.(hash, remoteResult.body.byteLength)

    // The artifact is now in local, but this *lookup* was a remote
    // hit — flip the source so callers can distinguish "saved work
    // via the remote cache" from "saved work via a prior local run".
    const materialized = await this.local.get(hash, ctx)
    return materialized ? { ...materialized, source: 'remote' } : null
  }

  outputsPath(hash: string): string {
    return this.local.outputsPath(hash)
  }

  async hashFile(filePath: string): Promise<string> {
    return await this.local.hashFile(filePath)
  }

  async restoreOutputs(hash: string, projectDir: string): Promise<void> {
    await this.local.restoreOutputs(hash, projectDir)
  }

  async save(args: SaveArgs): Promise<void> {
    await this.local.save(args)
    // Upload the bytes the local layer just wrote — same format on
    // both sides, no repacking. Errors are logged, not propagated:
    // the task already succeeded; we don't want to fail it on cache-
    // server issues.
    const t0 = performance.now()
    try {
      const bytes = await Bun.file(this.local.outputsPath(args.hash)).bytes()
      await this.remote.put(args.hash, bytes, { durationMs: args.entry.durationMs })
      this.options.onRemoteRequest?.({
        op: 'PUT',
        hash: args.hash,
        bytes: bytes.byteLength,
        latencyMs: performance.now() - t0,
        ok: true,
      })
    } catch (err) {
      this.options.onRemoteRequest?.({
        op: 'PUT',
        hash: args.hash,
        latencyMs: performance.now() - t0,
        ok: false,
      })
      this.reportRemoteError(err)
    }
  }

  async ingest(hash: string, compressed: Uint8Array, meta: IngestMeta): Promise<void> {
    await this.local.ingest(hash, compressed, meta)
  }

  async getMetaBatch(hashes: readonly string[]): Promise<Map<string, CacheEntryMeta>> {
    // Local-only batched metadata fetch. Remote-cache batching is
    // deferred — parallel single-hash fetches already saturate the
    // network path. Callers can fall through to per-hash `get()` for
    // any hash not in the returned map.
    return this.local.getMetaBatch(hashes)
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

  getTaskHistory(taskIds: readonly string[]): TaskHistoryMap {
    return this.local.getTaskHistory(taskIds)
  }

  async prune(options: PruneOptions): Promise<PruneResult> {
    return await this.local.prune(options)
  }

  close(): void {
    this.local.close()
  }

  private reportRemoteError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err))
    if (this.options.onRemoteError) {
      this.options.onRemoteError(e)
    } else {
      process.stderr.write(`[vx] remote cache: ${e.message}\n`)
    }
  }
}
