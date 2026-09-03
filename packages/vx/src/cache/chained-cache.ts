// Several declared cache layers, consulted in declaration order. Lookup
// walks the layers until one answers; a save reaches every layer; the FIRST
// layer owns the run index (history, stats, prune) so a run is recorded
// once. Restore goes to the layer that produced the hit — remembered per
// hash — because an entry's artifact lives wherever it was found.

import type {
  Cache,
  CacheEntry,
  CacheGetContext,
  CacheKeyInput,
  CacheLayer,
  CacheStats,
  CacheStatsOptions,
  IngestMeta,
  InvocationRecord,
  OutputDirRow,
  OutputFileRow,
  PruneOptions,
  PruneResult,
  RunRecord,
} from './cache.js'

export class ChainedCache implements CacheLayer {
  readonly hasRemote: boolean
  private readonly hitLayer = new Map<string, CacheLayer>()

  constructor(readonly layers: readonly CacheLayer[]) {
    if (layers.length < 2) throw new Error('ChainedCache needs at least two layers')
    this.hasRemote = layers.some((l) => l.hasRemote === true)
  }

  get local(): Cache | undefined {
    return this.layers[0]!.local
  }

  private owner(hash: string): CacheLayer {
    return this.hitLayer.get(hash) ?? this.layers[0]!
  }

  key(input: CacheKeyInput): Promise<string> {
    return this.layers[0]!.key(input)
  }

  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> {
    for (const layer of this.layers) {
      const entry = await layer.get(hash, ctx)
      if (entry !== null) {
        this.hitLayer.set(hash, layer)
        return entry
      }
    }
    return null
  }

  async has(hash: string): Promise<'local' | 'remote' | null> {
    for (const layer of this.layers) {
      const where = await layer.has(hash)
      if (where !== null) {
        this.hitLayer.set(hash, layer)
        return where
      }
    }
    return null
  }

  async prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    for (const layer of this.layers) {
      if (await layer.prefetch(hash, ctx)) {
        this.hitLayer.set(hash, layer)
        return true
      }
    }
    return false
  }

  async remoteHasMany(hashes: readonly string[]): Promise<Set<string> | null> {
    // The caller (remote-prefetch) treats a non-null answer as authoritative
    // for the WHOLE chain: complement = absent, broadcast. That is sound only
    // if EVERY remote layer answered — a partial union would poison a layer
    // that cannot batch with another layer's negatives, and its later lazy
    // get() would skip a real remote hit. So: each answering layer gets its
    // OWN complement marked here (its own truth — this also spares it the
    // per-hash GETs for hashes only a sibling holds), and the merged answer
    // is returned only when no remote layer was left unanswered.
    let out: Set<string> | null = null
    let complete = true
    for (const layer of this.layers) {
      if (layer.hasRemote !== true) continue
      const found = (await layer.remoteHasMany?.(hashes)) ?? null
      if (found === null) {
        complete = false
        continue
      }
      layer.markRemoteAbsent?.(hashes.filter((h) => !found.has(h)))
      out ??= new Set()
      for (const h of found) out.add(h)
    }
    return complete ? out : null
  }

  markRemoteAbsent(hashes: Iterable<string>): void {
    const list = [...hashes]
    for (const layer of this.layers) layer.markRemoteAbsent?.(list)
  }

  async drainUploads(): Promise<void> {
    await Promise.all(this.layers.map((l) => l.drainUploads?.()))
  }

  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    const out = new Map<string, OutputFileRow[]>()
    for (const layer of this.layers) {
      for (const [h, rows] of layer.loadOutputFilesBatch(hashes)) {
        if (!out.has(h)) out.set(h, rows)
      }
    }
    return out
  }

  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean> {
    return this.layers[0]!.isOutputsCurrent(projectDir, expected)
  }

  // The directory short-circuit lives with the layer that owns the local
  // rows — the first, like the file check.
  recordOutputDirs(hash: string, projectDir: string, prefixes: readonly string[]): Promise<void> {
    return this.layers[0]!.recordOutputDirs?.(hash, projectDir, prefixes) ?? Promise.resolve()
  }

  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    return this.layers[0]!.loadOutputDirsBatch?.(hashes) ?? new Map()
  }

  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean> {
    return this.layers[0]!.outputDirsCurrent?.(projectDir, rows) ?? Promise.resolve(false)
  }

  restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void> {
    return this.owner(hash).restoreOutputs(hash, projectDir, workspaceRoot)
  }

  async save(args: Parameters<CacheLayer['save']>[0]): Promise<void> {
    // Layers wrapping the SAME local handle (two remote plugins over
    // ctx.localCache) would each pack + write the identical artifact; the
    // first write is the only one that matters, so later layers get
    // `skipLocalWrite` and go straight to their remote upload (which reads
    // the artifact the first layer just wrote — same handle, same path).
    const seenLocals = new Set<NonNullable<CacheLayer['local']>>()
    for (const layer of this.layers) {
      const local = layer.local
      const skip = local !== undefined && seenLocals.has(local)
      await layer.save(skip ? { ...args, skipLocalWrite: true } : args)
      if (local !== undefined) seenLocals.add(local)
    }
  }

  ingest(hash: string, compressed: Uint8Array, meta: IngestMeta): Promise<void> {
    return this.layers[0]!.ingest(hash, compressed, meta)
  }

  recordRun(run: RunRecord): void {
    this.layers[0]!.recordRun(run)
  }

  recordRuns(runs: readonly RunRecord[]): void {
    this.layers[0]!.recordRuns(runs)
  }

  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void {
    this.layers[0]!.recordRunBundle(bundle)
  }

  stats(opts?: CacheStatsOptions): CacheStats {
    return this.layers[0]!.stats(opts)
  }

  hashFile(filePath: string): Promise<string> {
    return this.layers[0]!.hashFile(filePath)
  }

  outputsPath(hash: string): string {
    return this.owner(hash).outputsPath(hash)
  }

  prune(options: PruneOptions): Promise<PruneResult> {
    return this.layers[0]!.prune(options)
  }

  close(): void {
    // Every layer closes even if an earlier one throws; the first error wins.
    let failure: unknown
    for (const layer of this.layers) {
      try {
        layer.close()
      } catch (err) {
        failure ??= err
      }
    }
    if (failure !== undefined) throw failure
  }
}
