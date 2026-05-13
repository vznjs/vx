// LayeredCache — composes the local v10 cache with a remote HTTP cache.
//
// Read path:  try local. On miss, try remote; on remote hit, materialize
// the artifact into local so the next read is a local hit.
//
// Write path: write to local synchronously. Upload to remote as a
// fire-and-forget background task; failures log a warning but never fail
// the user's run (the task already succeeded; the only loss is the
// remote cache entry).
//
// Same `Cache` shape callers expect (key/get/save/restoreOutputs/recordRun/
// stats/prune/close) — orchestrator code doesn't change.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { packAndDiscard, unpackArchive } from './cache-archive.js'
import type {
  CacheEntry,
  CacheKeyInput,
  CacheLayer,
  CacheStats,
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

/**
 * Shape of `meta.json` inside a remote artifact tarball. Officially
 * derived from `CacheEntry` so the on-disk meta schema stays in sync
 * with the cache contract automatically — adding a field to
 * `CacheEntry` propagates here unless it's one of the three excluded
 * fields (`hash` is the artifact's own filename, `outputFiles` is
 * recovered by listing the unpacked `outputs/` tree, `source` is
 * set per-lookup by the layer that served the hit).
 */
type OnDiskMeta = Omit<CacheEntry, 'hash' | 'outputFiles' | 'source'>

export class LayeredCache implements CacheLayer {
  constructor(
    private readonly local: CacheLayer,
    private readonly remote: RemoteCache,
    private readonly options: LayeredCacheOptions = {},
  ) {}

  async key(input: CacheKeyInput): Promise<string> {
    return await this.local.key(input)
  }

  async get(hash: string): Promise<CacheEntry | null> {
    const localHit = await this.local.get(hash)
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

    // Materialize the remote artifact into the local cache so future
    // lookups hit local. We unpack into a temp stage dir that mirrors
    // the pack layout ({meta.json, outputs/}), then call local.save()
    // with outputs/ as the "project dir".
    const stage = await mkdtemp(path.join(os.tmpdir(), 'vx-remote-hit-'))
    try {
      await unpackArchive(remoteResult.body, stage)
      const meta = (await Bun.file(path.join(stage, 'meta.json')).json()) as OnDiskMeta
      const outputsDir = path.join(stage, 'outputs')
      const outputFiles = await listFilesRecursive(outputsDir)
      await this.local.save({
        hash,
        projectDir: outputsDir,
        outputFiles,
        entry: {
          taskId: meta.taskId,
          command: meta.command,
          exitCode: meta.exitCode,
          durationMs: meta.durationMs,
          stdout: meta.stdout,
          stderr: meta.stderr,
        },
      })
      this.options.onRemoteHit?.(hash, remoteResult.body.byteLength)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }

    // The artifact is now in local, but this *lookup* was a remote
    // hit — flip the source so callers can distinguish "saved work
    // via the remote cache" from "saved work via a prior local run".
    const materialized = await this.local.get(hash)
    return materialized ? { ...materialized, source: 'remote' } : null
  }

  async restoreOutputs(hash: string, projectDir: string): Promise<void> {
    await this.local.restoreOutputs(hash, projectDir)
  }

  async save(args: SaveArgs): Promise<void> {
    await this.local.save(args)
    // Stage + upload. Errors are logged, not propagated — the task
    // already succeeded; we don't want to fail it on cache-server issues.
    const t0 = performance.now()
    try {
      const bytes = await this.stageAndPack(args)
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

  recordRun(run: RunRecord): void {
    this.local.recordRun(run)
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

  private async stageAndPack(args: SaveArgs): Promise<Uint8Array> {
    const stage = await mkdtemp(path.join(os.tmpdir(), 'vx-remote-put-'))
    const outputsDir = path.join(stage, 'outputs')
    for (const f of args.outputFiles) {
      const rel = path.relative(args.projectDir, f)
      const dest = path.join(outputsDir, rel)
      // Bun.write auto-creates parent dirs.
      await Bun.write(dest, Bun.file(f))
    }
    const meta: OnDiskMeta = {
      taskId: args.entry.taskId,
      command: args.entry.command,
      exitCode: args.entry.exitCode,
      durationMs: args.entry.durationMs,
      stdout: args.entry.stdout,
      stderr: args.entry.stderr,
      storedAt: new Date().toISOString(),
    }
    await Bun.write(path.join(stage, 'meta.json'), JSON.stringify(meta))
    return await packAndDiscard(stage)
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

async function listFilesRecursive(root: string, sub = ''): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const here = sub === '' ? root : path.join(root, sub)
  const out: string[] = []
  const entries = await readdir(here, { withFileTypes: true })
  for (const e of entries) {
    const childRel = sub === '' ? e.name : `${sub}/${e.name}`
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(root, childRel)))
    } else if (e.isFile()) {
      out.push(path.join(root, childRel))
    }
  }
  return out
}
