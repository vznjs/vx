// The run's `cache.scope` over every layer at once (owner, 2026-10-14): a
// scoped run reads the default key, then the scope's, and writes only the
// scope's, in the local store and every remote alike. Below this wrapper no
// layer knows a scope exists: the scope's key is a key like any other.

import { xxh3hex } from '../util/index.js'
import type {
  CacheEntry,
  CacheGetContext,
  CacheLayer,
  DeclaredOutputs,
  IngestMeta,
  InvocationRecord,
  OutputDirRow,
  RunRecord,
  SaveArgs,
} from './layer.js'

/** The key a scope stores `hash` under: task-key shaped, 16 hex, so every wire stores it unchanged. */
export function scopedKey(scope: string, hash: string): string {
  return xxh3hex(`vx-cache-scope\0${scope}\0${hash}`)
}

/**
 * A layer as a scoped run sees it. Callers speak task keys; each answer is
 * remembered under the key that served it (the default key on a default hit,
 * the scope's on a scope hit or a save), so the restore, the output index and
 * the run's history all reach the entry that answered. An artifact records
 * the key it was packed under and ingest refuses another, so a derived-key
 * collision degrades to a miss. A default artifact a remote ingest refuses is
 * a miss there, and the scope's key is asked next (Security F6).
 */
export class ScopedCache implements CacheLayer {
  readonly local?: CacheLayer['local']
  readonly hasRemote?: boolean
  readonly drainUploads?: () => Promise<void>
  readonly stopUploads?: () => void
  readonly remoteHasMany?: (hashes: readonly string[]) => Promise<Set<string> | null>
  /** A scoped run saves under the scope's key, so that is the key asked. */
  readonly probeBeforeUpload?: (hashes: Promise<readonly string[]>) => void
  readonly getMany?: (
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ) => Promise<Map<string, CacheEntry>>
  /** Task key → the key that answers for it this run. */
  private readonly served = new Map<string, string>()

  constructor(
    private readonly inner: CacheLayer,
    private readonly scope: string,
  ) {
    if (inner.local !== undefined) this.local = inner.local
    if (inner.hasRemote !== undefined) this.hasRemote = inner.hasRemote
    if (inner.drainUploads !== undefined) this.drainUploads = () => inner.drainUploads!()
    if (inner.stopUploads !== undefined) this.stopUploads = () => inner.stopUploads!()
    if (inner.remoteHasMany !== undefined) this.remoteHasMany = (h) => this.scopedHasMany(h)
    if (inner.probeBeforeUpload !== undefined)
      this.probeBeforeUpload = (h) =>
        inner.probeBeforeUpload!(h.then((keys) => keys.map((k) => this.own(k))))
    if (inner.getMany !== undefined) this.getMany = (h, ctx) => this.scopedGetMany(h, ctx)
  }

  private own(hash: string): string {
    const key = scopedKey(this.scope, hash)
    this.local?.traffic.aliases.set(key, hash)
    return key
  }

  private keyOf(hash: string): string {
    return this.served.get(hash) ?? hash
  }

  /** A batch keyed by served keys, keyed back by task key. */
  private batch<T>(
    hashes: readonly string[],
    read: (keys: string[]) => Map<string, T>,
  ): Map<string, T> {
    const keys = hashes.map((h) => this.keyOf(h))
    const found = read(keys)
    const out = new Map<string, T>()
    for (let i = 0; i < hashes.length; i++) {
      const v = found.get(keys[i]!)
      if (v !== undefined) out.set(hashes[i]!, v)
    }
    return out
  }

  /** A task key the store holds under the default key or the scope's. */
  async localHasMany(hashes: readonly string[]): Promise<Set<string>> {
    const held = await this.inner.localHasMany?.([...hashes, ...hashes.map((h) => this.own(h))])
    if (held === undefined) return new Set()
    return new Set(hashes.filter((h) => held.has(h) || held.has(this.own(h))))
  }

  private async scopedHasMany(hashes: readonly string[]): Promise<Set<string> | null> {
    const scoped = hashes.map((h) => this.own(h))
    const [plain, own] = await Promise.all([
      this.inner.remoteHasMany!(hashes),
      this.inner.remoteHasMany!(scoped),
    ])
    if (plain == null || own == null) return null
    const found = new Set(plain)
    const scopeOnly: string[] = []
    for (let i = 0; i < hashes.length; i++) {
      if (plain.has(hashes[i]!) || !own.has(scoped[i]!)) continue
      found.add(hashes[i]!)
      scopeOnly.push(hashes[i]!)
    }
    // Their default key is known absent: its GET is skipped.
    this.inner.markRemoteAbsent?.(scopeOnly)
    return found
  }

  markRemoteAbsent(hashes: Iterable<string>): void {
    const all: string[] = []
    for (const h of hashes) all.push(h, this.own(h))
    this.inner.markRemoteAbsent?.(all)
  }

  key(input: Parameters<CacheLayer['key']>[0]): Promise<string> {
    return this.inner.key(input)
  }

  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> {
    // The scope's key first when only it is local: the default key's
    // remote GET would cost a round-trip for the same inputs.
    const own = this.own(hash)
    const keys = (await this.inner.localHasMany?.([hash, own]))?.has(own)
      ? [own, hash]
      : [hash, own]
    for (const key of keys) {
      const entry = await this.inner.get(key, ctx)
      if (entry === null) continue
      this.served.set(hash, key)
      return key === hash ? entry : { ...entry, hash }
    }
    return null
  }

  private async scopedGetMany(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ): Promise<Map<string, CacheEntry>> {
    const out = await this.inner.getMany!(hashes, ctx)
    for (const h of out.keys()) this.served.set(h, h)
    const rest = hashes.filter((h) => !out.has(h))
    if (rest.length === 0) return out
    const byOwn = new Map(rest.map((h) => [this.own(h), h]))
    const scoped = await this.inner.getMany!(
      [...byOwn.keys()],
      ctx === undefined ? undefined : (key) => ctx(byOwn.get(key)!),
    )
    for (const [key, entry] of scoped) {
      const hash = byOwn.get(key)!
      this.served.set(hash, key)
      out.set(hash, { ...entry, hash })
    }
    return out
  }

  async has(hash: string): Promise<'local' | 'remote' | null> {
    return (await this.inner.has(hash)) ?? (await this.inner.has(this.own(hash)))
  }

  async prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    return (await this.inner.prefetch(hash, ctx)) || this.inner.prefetch(this.own(hash), ctx)
  }

  loadOutputFilesBatch(hashes: readonly string[]): ReturnType<CacheLayer['loadOutputFilesBatch']> {
    return this.batch(hashes, (keys) => this.inner.loadOutputFilesBatch(keys))
  }

  isOutputsCurrent(
    ...args: Parameters<CacheLayer['isOutputsCurrent']>
  ): ReturnType<CacheLayer['isOutputsCurrent']> {
    return this.inner.isOutputsCurrent(...args)
  }

  async recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void> {
    await this.inner.recordOutputDirs?.(this.keyOf(hash), projectDir, prefixes, holds)
  }

  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void {
    this.inner.recordOutputStamps?.(this.keyOf(hash), projectDir, workspaceRoot)
  }

  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    return this.batch(hashes, (keys) => this.inner.loadOutputDirsBatch?.(keys) ?? new Map())
  }

  async outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean> {
    return (await this.inner.outputDirsCurrent?.(projectDir, rows)) ?? false
  }

  restoreOutputs(
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
    outputs?: DeclaredOutputs,
  ): Promise<void> {
    return this.inner.restoreOutputs(this.keyOf(hash), projectDir, workspaceRoot, outputs)
  }

  save(args: SaveArgs): Promise<void> {
    const key = this.own(args.hash)
    this.served.set(args.hash, key)
    return this.inner.save({ ...args, hash: key })
  }

  ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> {
    const key = this.own(hash)
    this.served.set(hash, key)
    return this.inner.ingest(key, body, meta)
  }

  /** History names the key that answered, so `vx why` reads that entry's components. */
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void {
    this.inner.recordRunBundle({
      ...bundle,
      runs: bundle.runs.map((r) => (r.hash === undefined ? r : { ...r, hash: this.keyOf(r.hash) })),
    })
  }

  stats(...args: Parameters<CacheLayer['stats']>): ReturnType<CacheLayer['stats']> {
    return this.inner.stats(...args)
  }

  hashFile(filePath: string): Promise<string> {
    return this.inner.hashFile(filePath)
  }

  outputsPath(hash: string): string {
    return this.inner.outputsPath(this.keyOf(hash))
  }

  artifactSize(hash: string): number | undefined {
    return this.inner.artifactSize?.(this.keyOf(hash))
  }

  prune(...args: Parameters<CacheLayer['prune']>): ReturnType<CacheLayer['prune']> {
    return this.inner.prune(...args)
  }

  close(): void {
    this.inner.close()
  }
}
