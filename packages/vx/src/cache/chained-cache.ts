// Several declared cache layers, consulted in declaration order. Lookup
// walks the layers until one answers; a save reaches every layer; the FIRST
// layer owns the run index (history, stats, prune) so a run is recorded
// once. Restore goes to the layer that produced the hit — remembered per
// hash — because an entry's artifact lives wherever it was found.
//
// A layer that throws in a lookup is a miss there and the walk goes on; one
// that throws in a save is skipped and the rest still save. Unisolated, a
// plugin layer's throw ended the walk before the local floor under it: its
// `get` failed the task, its `save` kept the entry from every later layer
// (item 1020). A save that fails in EVERY layer still throws, so the
// caller's own "cache save failed" line stays the one word on it.

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

/** Told of a layer's failure the chain went past: its index, the method, the error. */
export type LayerErrorReport = (layer: number, method: string, err: unknown) => void

export class ChainedCache implements CacheLayer {
  readonly hasRemote: boolean
  private readonly hitLayer = new Map<string, CacheLayer>()

  constructor(
    readonly layers: readonly CacheLayer[],
    private readonly onLayerError: LayerErrorReport = () => undefined,
  ) {
    if (layers.length < 2) throw new Error('ChainedCache needs at least two layers')
    this.hasRemote = layers.some((l) => l.hasRemote === true)
  }

  /** `layer`'s answer, or `fallback` once its failure is reported. */
  private async ask<T>(layer: CacheLayer, method: string, call: () => Promise<T>, fallback: T) {
    try {
      return await call()
    } catch (err) {
      this.onLayerError(this.layers.indexOf(layer), method, err)
      return fallback
    }
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
    // The layer that pulled this hash in a prefetch answers first. Layers
    // may share one local store, and an earlier layer found the pulled copy
    // there and called it a local hit: a second remote's hit was counted as
    // saved locally, in the outcome, the summary and telemetry (item 889).
    const owner = this.hitLayer.get(hash)
    if (owner !== undefined) {
      const entry = await this.ask(owner, 'get', () => owner.get(hash, ctx), null)
      if (entry !== null) return entry
    }
    for (const layer of this.layers) {
      const entry = await this.ask(layer, 'get', () => layer.get(hash, ctx), null)
      if (entry !== null) {
        this.hitLayer.set(hash, layer)
        return entry
      }
    }
    return null
  }

  async has(hash: string): Promise<'local' | 'remote' | null> {
    for (const layer of this.layers) {
      const where = await this.ask(layer, 'has', () => layer.has(hash), null)
      if (where !== null) {
        this.hitLayer.set(hash, layer)
        return where
      }
    }
    return null
  }

  async prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    for (const layer of this.layers) {
      if (await this.ask(layer, 'prefetch', () => layer.prefetch(hash, ctx), false)) {
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
      const found = await this.ask(
        layer,
        'remoteHasMany',
        async () => (await layer.remoteHasMany?.(hashes)) ?? null,
        null,
      )
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
  recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void> {
    return (
      this.layers[0]!.recordOutputDirs?.(hash, projectDir, prefixes, holds) ?? Promise.resolve()
    )
  }
  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void {
    this.layers[0]!.recordOutputStamps?.(hash, projectDir, workspaceRoot)
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
    const failures: Array<[layer: number, err: unknown]> = []
    for (const [i, layer] of this.layers.entries()) {
      const local = layer.local
      const skip = local !== undefined && seenLocals.has(local)
      try {
        await layer.save(skip ? { ...args, skipLocalWrite: true } : args)
      } catch (err) {
        failures.push([i, err])
        continue
      }
      if (local !== undefined) seenLocals.add(local)
    }
    if (failures.length === this.layers.length) throw failures[0]![1]
    for (const [i, err] of failures) this.onLayerError(i, 'save', err)
  }

  ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> {
    return this.layers[0]!.ingest(hash, body, meta)
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
