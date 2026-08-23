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
    let out: Set<string> | null = null
    for (const layer of this.layers) {
      if (layer.remoteHasMany === undefined) continue
      const found = await layer.remoteHasMany(hashes)
      if (found === null) continue
      out ??= new Set()
      for (const h of found) out.add(h)
    }
    return out
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

  restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void> {
    return this.owner(hash).restoreOutputs(hash, projectDir, workspaceRoot)
  }

  async save(args: Parameters<CacheLayer['save']>[0]): Promise<void> {
    for (const layer of this.layers) await layer.save(args)
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
