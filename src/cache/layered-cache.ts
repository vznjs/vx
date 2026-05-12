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
} from './cache.js'
import type { RemoteCache } from './remote-cache.js'

export interface LayeredCacheOptions {
  /** Called for remote-related errors that the layer suppresses. */
  onRemoteError?: (err: Error) => void
  /** Called when a remote miss → local materialization completes. */
  onRemoteHit?: (hash: string, bytes: number) => void
}

interface OnDiskMeta {
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
  storedAt: string
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

  async get(hash: string): Promise<CacheEntry | null> {
    const localHit = await this.local.get(hash)
    if (localHit) return localHit

    let remoteResult
    try {
      remoteResult = await this.remote.get(hash)
    } catch (err) {
      this.reportRemoteError(err)
      return null
    }
    if (!remoteResult) return null

    // Materialize the remote artifact into the local cache so future
    // lookups hit local. We unpack into a temp stage dir that mirrors
    // the pack layout ({meta.json, outputs/}), then call local.save()
    // with outputs/ as the "project dir".
    const stage = await mkdtemp(path.join(os.tmpdir(), 'vzn-remote-hit-'))
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

    return await this.local.get(hash)
  }

  async restoreOutputs(hash: string, projectDir: string): Promise<void> {
    await this.local.restoreOutputs(hash, projectDir)
  }

  async save(args: SaveArgs): Promise<void> {
    await this.local.save(args)
    // Stage + upload. Errors are logged, not propagated — the task
    // already succeeded; we don't want to fail it on cache-server issues.
    try {
      const bytes = await this.stageAndPack(args)
      await this.remote.put(args.hash, bytes, { durationMs: args.entry.durationMs })
    } catch (err) {
      this.reportRemoteError(err)
    }
  }

  recordRun(run: RunRecord): void {
    this.local.recordRun(run)
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

  private async stageAndPack(args: SaveArgs): Promise<Uint8Array> {
    const stage = await mkdtemp(path.join(os.tmpdir(), 'vzn-remote-put-'))
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
      process.stderr.write(`[vzn] remote cache: ${e.message}\n`)
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
