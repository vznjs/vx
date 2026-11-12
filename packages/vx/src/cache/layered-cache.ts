// LayeredCache: the local cache with the declared remotes behind it.
//
// Read: local first; on a miss each readable remote in declared order, the
// first hit streamed into local. Write: local at once, then a background upload
// to every writable remote; an upload failure warns and never fails the run.
// Each remote's boundary, pool and warnings are its `RemoteLane`. Local and
// remote share the same `<hash>.tar.zst` bytes; metadata travels apart (`ctx`,
// the remote's `durationMs`).

import {
  type Cache,
  type CacheEntry,
  type CacheGetContext,
  type DeclaredOutputs,
  type CacheKeyInput,
  type CacheLayer,
  type CacheStats,
  type CacheStatsOptions,
  type IngestMeta,
  type PruneOptions,
  type PruneResult,
  type SaveArgs,
} from './cache.js'
import { isCorruptArtifact, type TaskMemo } from './layer.js'
import { RemoteLane, type ResolvedRemote } from './remote-lane.js'
import type { PluginSecrets } from '../util/index.js'

const STOPPED: unique symbol = Symbol('stopped')

/**
 * A body that errors once the run stops, so the ingest reading it fails at
 * once, removes its temp and releases the connection.
 */
function endsOnStop(
  body: Blob | Response,
  stopped: Promise<typeof STOPPED>,
  onChunk: (bytes: number) => void = () => {},
): Blob | Response {
  if (body instanceof Blob || body.body === null) return body
  const reader = body.body.getReader()
  let stop = false
  // Once, not raced per chunk: a cancel ends the pending read as `done`, which
  // the flag turns into an error, not a short body.
  void stopped.then(() => {
    stop = true
    // quiet: stopping: a reader already done has nothing to cancel
    void reader.cancel().catch(() => undefined)
  })
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (stop) controller.error(new Error('the run was stopped'))
      else if (next.done) controller.close()
      else {
        onChunk(next.value.byteLength)
        controller.enqueue(next.value)
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return new Response(stream, { headers: body.headers })
}

const judged = (i: ArtifactInfo): i is { size: number; durationMs: number } =>
  i.size !== undefined && i.durationMs !== undefined

/** How often a task waiting on its download weighs running instead. */
const JUDGE_EVERY_MS = 25

/**
 * The least a download is given against running its task. A stored duration may
 * be 0 (Turbo's wire sends 0 for a sub-ms task), and that budget gave up every
 * body not in by the first weighing.
 */
const LEAST_BUDGET_MS = JUDGE_EVERY_MS

interface Download {
  readonly start: number
  received: number
  abandon(): void
}

/** What a remote's `open` is handed: the run's CI verdict and its plugin's keychain. */
export interface RemoteOpenContext extends PluginSecrets {
  /** The run is on CI: nobody may be asked. */
  readonly ci: boolean
  /** One line naming the plugin, for a fact that leaves the remote on. */
  warn(message: string): void
}

/**
 * What a remote knows of an artifact before download: its size and the
 * producing task's duration, when the wire carries them.
 */
export interface ArtifactInfo {
  readonly size?: number
  readonly durationMs?: number
}

/** A run's access to a remote, lent to a machine that runs its tasks (`RemoteCacheLayer.lend`). */
export interface LentAccess {
  readonly token: string
  /** Epoch ms; asked again before it. */
  readonly expiresAt?: number
}

/**
 * What a remote cache layer provides: the plugin seam for remote caching. Core
 * ships no wire; a plugin's `cache` hook returns one (or
 * `RunOptions.remoteCache`), and `LayeredCache` owns policy, in-flight dedup,
 * provenance and the never-fail contract: a layer THROWS on failure, and every
 * throw is a miss reported to `onError`. The bytes are the local
 * `<hash>.tar.zst` verbatim. See docs/modules/cache.md.
 *
 * Core bounds no call, so each request carries the layer's own deadline.
 */
export interface RemoteCacheLayer {
  /**
   * Where the artifacts live, named in degrade warnings: a base URL or
   * `host:port`, with any `user:pass@`, query and fragment dropped before
   * printing.
   */
  readonly endpoint?: string
  /**
   * Optional: true once a failure turned the layer off for the run. That
   * failure is the run's, said once, never charged to whichever task asked
   * first.
   */
  readonly off?: boolean
  /**
   * Optional: make the layer ready (read or ask for a credential). Called once
   * per run, in declared order, before the first task, and only when the policy
   * lets this remote read or write; `--dry` and `vx show` never call it. A
   * throw warns, naming the plugin, and turns the remote off for the run.
   * `ctx.secret` reads the plugin's keychain.
   */
  open?(ctx: RemoteOpenContext): Promise<void>
  /**
   * Optional: this run's access, for a machine that runs its tasks elsewhere
   * (`ExecutorContext.cacheFacts`); that machine's plugin reads it as
   * `CacheContext.lent`. Only access made for this run, never a stored secret.
   * Asked after `open`.
   */
  lend?(): Promise<LentAccess | undefined>
  /**
   * Existence probe: what the remote knows of the artifact, or null. `--dry`
   * and `--force` ask it per key when the remote cannot batch.
   */
  has(hash: string): Promise<ArtifactInfo | null>
  /**
   * Optional batch existence probe: the stored hashes of N and what the remote
   * knows of each, in one round trip. A run asks it once for its keys; without
   * it a run GETs each key. `null` means use per-hash.
   */
  hasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null>
  /**
   * Fetch an artifact: `null` a miss, `undefined` no answer (the layer is off,
   * its refusal already said). Core reads `body` once, into the local cache: a
   * `fetch` Response, `new Response(stream)` or `new Blob([bytes])`. A body
   * that errors before its end stores nothing, so a layer can check bytes as
   * they pass and refuse at the end.
   */
  get(
    hash: string,
  ): Promise<{ body: Blob | Response; durationMs: number | undefined } | null | undefined>
  /**
   * Store an artifact. `body` is file-backed when the local store holds it, so
   * a streaming plugin never holds it whole. An entry is immutable: a `put` of
   * a held key keeps the stored bytes. Core never asks `has` first.
   *
   * `replace`: the remote's copy did not read back, so these bytes go over it;
   * a wire that cannot overwrite returns `false`. `false`: nothing was sent and
   * nothing failed, so no upload is counted.
   */
  put(hash: string, body: Blob, meta: { durationMs: number; replace?: true }): Promise<void | false>
  /**
   * The run found `hash` in no remote and a `put` follows: a wire that checks
   * before writing may skip that request.
   */
  missing?(hash: string): void
}

export class LayeredCache implements CacheLayer {
  /** A remote layer is composed in by construction — see `CacheLayer.hasRemote`. */
  readonly hasRemote = true

  private readonly lanes: readonly RemoteLane[]
  /** Each key `save` uploaded: whether a remote took it (`uploaded`). */
  private readonly sent = new Map<string, Promise<boolean>>()
  /** Each key whose stored entry `save` kept, until `kept` answers for it. */
  private readonly keptHere = new Set<string>()

  /**
   * In-flight remote pulls by hash, shared by `prefetch` and `get` so
   * concurrent asks make one walk. Each resolves true iff the artifact was
   * ingested. Kept for the run: a settled false spares `get` a second probe of
   * a dead hash.
   */
  private readonly inflight = new Map<string, Promise<boolean>>()

  /**
   * Hashes whose local artifact came FROM a remote this run, mapped to how long
   * the pull took. A later local `get` then reports `cache-hit-remote`, not
   * local.
   */
  private readonly remoteSourced = new Map<string, number>()
  /** What the batch probe said of each held key: its size and stored duration. */
  private readonly infos = new Map<string, ArtifactInfo>()
  /** Bodies being read now, by key: how far along, and how to give one up. */
  private readonly downloads = new Map<string, Download>()

  /** Remotes in declared order: the first readable one holding a hash answers it. */
  constructor(
    readonly local: Cache,
    remotes: readonly ResolvedRemote[],
    uploadConcurrency?: number,
  ) {
    this.lanes = remotes.map((r) => new RemoteLane(r, local.traffic, uploadConcurrency))
  }

  get memo(): TaskMemo {
    return this.local.memo
  }

  // Asked, not kept: a remote whose `open` failed leaves the run after this is built.
  private get readable(): RemoteLane[] {
    return this.lanes.filter((l) => l.read)
  }

  key(input: CacheKeyInput): Promise<string> {
    return this.local.key(input)
  }

  async prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    // No-op when no remote may be read — there's nothing to warm from.
    if (this.readable.length === 0) return false
    // The local-first skip lives in doPullFromRemote: pullFromRemote registers
    // `inflight` synchronously, so a concurrent markRemoteAbsent cannot clobber
    // a pending pull.
    return this.pullFromRemote(hash, ctx)
  }

  localHasMany(hashes: readonly string[]): Promise<Set<string>> {
    return this.local.localHasMany(hashes)
  }

  remoteKnown(hashes: readonly string[]): Map<string, ArtifactInfo> {
    if (this.readable.length === 0) return new Map()
    const known = this.local.remoteHits.get(hashes)
    for (const [h, info] of known) if (!this.infos.has(h)) this.infos.set(h, info)
    return known
  }

  /**
   * Batch existence probe over the readable remotes: the hashes some remote
   * holds, or `null` when any cannot batch or none may be read. A non-null
   * answer is complete, so the prefetch fetches only hits and marks the rest
   * absent. Each remote keeps its own absences. Never throws.
   */
  async remoteHasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> {
    if (this.readable.length === 0) return null
    const found = await this.probeMany(hashes)
    if (found !== null) {
      for (const [h, info] of found) this.infos.set(h, info)
      // The whole answer, kept for the next run and the next process.
      this.local.remoteHits.record(hashes, found)
    }
    return found
  }

  /**
   * Each readable remote asked key by key, skipping keys its batch answer
   * covered: a complete answer, for a run that plans on it. Null when a probe
   * failed or none may be read.
   */
  async remoteHasEach(
    hashes: readonly string[],
    concurrency: number,
  ): Promise<Map<string, ArtifactInfo> | null> {
    if (this.readable.length === 0) return null
    const out = new Map<string, ArtifactInfo>()
    for (const lane of this.readable) {
      const found = await lane.hasEach(hashes, concurrency)
      if (found === null) return null
      for (const [h, info] of found) if (!out.has(h)) out.set(h, info)
    }
    for (const [h, info] of out) this.infos.set(h, info)
    this.local.remoteHits.record(hashes, out)
    return out
  }

  private async probeMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> {
    let out: Map<string, ArtifactInfo> | null = new Map()
    for (const lane of this.readable) {
      const found = await lane.hasMany(hashes)
      if (found === null) out = null
      else if (out !== null) for (const [h, info] of found) if (!out.has(h)) out.set(h, info)
    }
    return out
  }

  /**
   * Record that no remote has each of `hashes`, so a later `get` misses with no
   * round trip: as if a prefetch had settled false. Never overwrites an entry
   * in flight.
   */
  markRemoteAbsent(hashes: Iterable<string>): void {
    for (const hash of hashes) {
      if (!this.inflight.has(hash)) this.inflight.set(hash, Promise.resolve(false))
    }
  }

  probeBeforeUpload(hashes: Promise<readonly string[]>): void {
    for (const lane of this.lanes) lane.probeBeforeUpload(hashes)
  }

  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> {
    const localHit = await this.local.get(hash, ctx)
    if (localHit) {
      // A prefetch may have pulled this entry from a remote: provenance stays
      // 'remote'. Its row lands a tick before the pull settles; wait for that.
      await this.inflight.get(hash)
      return this.asRemote(hash, localHit)
    }

    // Remote reads off: a local miss is a miss.
    if (this.readable.length === 0) return null

    // Await the shared pull: at most one remote walk per key. A lookup never
    // waits on the run's batch probe: a hit would pay two round trips before
    // its first byte.
    const ingested = await this.awaitOrRun(hash, this.pullFromRemote(hash, ctx))
    if (!ingested) return null

    // Read past the local READ gate: the gate keeps PRE-EXISTING local entries
    // from serving hits, not what this pull just wrote. Through the gated
    // `get`, `local:,remote:rw` re-ran and re-uploaded every task each run.
    const materialized = await this.local.getIngested(hash)
    if (!materialized) return null

    // `remoteSourced`, not the pull's true, says the remote saved this work:
    // the local-first skip also returns true with no GET.
    return this.asRemote(hash, materialized)
  }

  async getSaved(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> {
    const here = await this.local.getIngested(hash)
    if (here) return here
    // Every remote, read or not, and past a probe's absence: the probe ran
    // before the agent saved it.
    for (const lane of this.lanes)
      if (await this.pullFrom(lane, hash, ctx, true)) return this.local.getIngested(hash)
    return null
  }

  /**
   * A pull the task waits on is given up when the rest of its body would take
   * longer than running the task (its stored duration, doubled for the save).
   * Only a key the batch probe sized and timed is judged, from its own pace so
   * far.
   */
  private async awaitOrRun(hash: string, pull: Promise<boolean>): Promise<boolean> {
    if (this.infos.has(hash) && !judged(this.infos.get(hash)!)) return pull
    for (;;) {
      const done = await Promise.race([pull, Bun.sleep(JUDGE_EVERY_MS).then(() => undefined)])
      if (done !== undefined) return done
      const info = this.infos.get(hash)
      if (info === undefined) continue
      if (!judged(info)) return pull
      const budget = Math.max(info.durationMs * 2, LEAST_BUDGET_MS)
      const dl = this.downloads.get(hash)
      if (dl === undefined) continue
      const elapsed = performance.now() - dl.start
      const left =
        dl.received === 0
          ? elapsed > budget
            ? Infinity
            : 0
          : ((info.size - dl.received) * elapsed) / dl.received
      if (left > budget) {
        dl.abandon()
        await pull
        return false
      }
    }
  }

  private asRemote(hash: string, entry: CacheEntry): CacheEntry {
    const fetchMs = this.remoteSourced.get(hash)
    return fetchMs === undefined ? entry : { ...entry, source: 'remote', fetchMs }
  }

  // Existence probe: local first, then each remote's HEAD. No transfer, so
  // planning stays read-only. Remote errors read as a miss.
  async has(hash: string): Promise<'local' | 'remote' | null> {
    if ((await this.local.has(hash)) === 'local') return 'local'
    for (const lane of this.readable) if ((await lane.has(hash)) !== null) return 'remote'
    return null
  }

  /**
   * The one remote read-through, shared by `prefetch` and `get` and idempotent
   * per hash via `inflight`. Resolves true when the artifact is in local, false
   * on a miss, an error or corruption (reported, never thrown).
   */
  private pullFromRemote(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    const existing = this.inflight.get(hash)
    if (existing) return existing
    const p = this.doPullFromRemote(hash, ctx)
    this.inflight.set(hash, p)
    return p
  }

  private async doPullFromRemote(hash: string, ctx?: CacheGetContext): Promise<boolean> {
    // Local first: if local already holds it, skip the GET and do not mark it
    // `remoteSourced`. True still means the artifact is in local.
    if ((await this.local.has(hash)) === 'local') return true
    let absent = true
    for (const lane of this.readable) {
      const got = await this.pullFrom(lane, hash, ctx)
      if (got === true) return true
      if (got === false) absent = false
    }
    // Every remote answered it holds none: a hit the index kept is gone.
    if (absent) this.local.remoteHits.forget(hash)
    return false
  }

  private async pullFrom(
    lane: RemoteLane,
    hash: string,
    ctx?: CacheGetContext,
    fresh = false,
  ): Promise<boolean | null> {
    const fetchStart = performance.now()
    // A stopped run waits on no read: a download in flight held Ctrl-C until
    // its last byte. The body is cancelled.
    const stopped = lane.whenStopped.then((): typeof STOPPED => STOPPED)
    const pending = lane.get(hash, fresh)
    const remoteBody = await Promise.race([pending, stopped])
    if (remoteBody === STOPPED) {
      // A late answer's body would hold its connection to the exit.
      void pending.then((r) => (r?.body instanceof Response ? r.body.body?.cancel() : undefined))
      return false
    }
    // The remote holds none: the one answer that says the key is gone.
    if (remoteBody === null) return null
    if (remoteBody === undefined) return false

    // Ingest the remote body with the caller's taskId and command and the
    // remote's durationMs. Without `ctx`, placeholders.
    const meta: IngestMeta = {
      taskId: ctx?.taskId ?? `${hash}#unknown`,
      command: ctx?.command ?? '',
      // Only a finite non-negative number is taken: a NaN failed the row's NOT
      // NULL after the rename and orphaned a valid hit's bytes.
      durationMs: durationOf(remoteBody.durationMs),
      ...(ctx?.outputs !== undefined ? { outputs: ctx.outputs } : {}),
    }
    let abandon = (): void => {}
    const abandoned = new Promise<typeof STOPPED>((resolve) => (abandon = () => resolve(STOPPED)))
    const dl: Download = { start: performance.now(), received: 0, abandon }
    this.downloads.set(hash, dl)
    const ends = Promise.race([stopped, abandoned])
    try {
      const ingest = this.local.ingest(
        hash,
        endsOnStop(remoteBody.body, ends, (n) => (dl.received += n)),
        meta,
      )
      // quiet: raced and awaited below, where its error is reported
      ingest.catch(() => undefined)
      if ((await Promise.race([ingest, ends])) === STOPPED) return false
    } catch (err) {
      // Network bytes: a corrupt or truncated artifact is a miss, never a
      // crash. A corrupt local one is too (`Cache.restoreOutputs` drops it).
      lane.report('download', hash, err)
      // Bad bytes there: the re-run's save sends good ones over them.
      if (isCorruptArtifact(err)) lane.distrust(hash)
      return false
    } finally {
      this.downloads.delete(hash)
    }
    this.remoteSourced.set(hash, Math.round(performance.now() - fetchStart))
    this.local.downloads.count++
    this.local.downloads.bytes +=
      remoteBody.body instanceof Blob ? remoteBody.body.size : dl.received
    return true
  }

  outputsPath(hash: string): string {
    return this.local.outputsPath(hash)
  }

  artifactSize(hash: string): number | undefined {
    return this.local.artifactSize(hash)
  }

  outputBytes(hash: string): number | undefined {
    return this.local.outputBytes(hash)
  }

  kept(hash: string): boolean {
    return this.keptHere.delete(hash) || this.local.kept(hash)
  }

  async restoreOutputs(
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
    outputs?: DeclaredOutputs,
  ): Promise<void> {
    await this.local.restoreOutputs(hash, projectDir, workspaceRoot, outputs)
  }

  async save(args: SaveArgs): Promise<void> {
    // Cache.save honours the local write gate.
    await this.local.save(args)
    const kept = this.local.kept(args.hash)
    if (kept) this.keptHere.add(args.hash)
    const writable = this.lanes.filter((l) => l.write)
    if (writable.length === 0) return
    // Upload off the task's critical path, in each remote's bounded pool;
    // `run()` awaits `drainUploads()` before closing the cache. Errors warn and
    // never fail the task.
    //
    // Each job hands the plugin a file-backed Blob pinned under a private name
    // when it starts (`pinArtifact`): a queued job holds a path, not a buffer,
    // and every read sees the same bytes. If `vx cache clean` removed the
    // artifact first, the upload is skipped.
    const hash = args.hash
    const durationMs = args.entry.durationMs
    // Local writes off: no artifact on disk to read later, so pack the bytes
    // NOW, while the outputs are on disk. The same with an entry the save kept
    // (`--force`): its artifact is an older run's, maybe the corrupt one
    // `--force` replaces.
    let packed: Uint8Array | undefined
    if (!this.local.localWritesEnabled || kept) {
      try {
        packed = await this.local.packArtifactBytes(args)
      } catch (err) {
        for (const lane of writable) lane.report('upload', hash, err)
        this.sent.set(hash, Promise.resolve(false))
        return
      }
    }
    const body = (): Promise<{ body: Blob; release?: () => Promise<void> }> =>
      packed !== undefined
        ? Promise.resolve({ body: new Blob([packed]) })
        : this.local.pinArtifact(hash)
    const sent = writable.map((lane) =>
      lane.upload(hash, durationMs, body, this.local.uploads, args.absent === true),
    )
    this.sent.set(
      hash,
      Promise.all(sent).then((held) => held.includes(true)),
    )
  }

  uploaded(hash: string): Promise<boolean | undefined> {
    return this.sent.get(hash) ?? Promise.resolve(undefined)
  }

  /**
   * True once a remote the run reads holds `hash`, uploading the local entry
   * where none does. A DTE worker restores from remotes alone, so a hit only
   * this cache held would fail its dependant there.
   */
  async share(hash: string): Promise<boolean> {
    for (const lane of this.readable) if ((await lane.has(hash)) !== null) return true
    return this.upload(hash, false)
  }

  /** `share`, over a remote copy another machine of the run found corrupt. */
  resend(hash: string): Promise<boolean> {
    return this.upload(hash, true)
  }

  private async upload(hash: string, over: boolean): Promise<boolean> {
    const lanes = this.readable.filter((l) => l.write)
    if (lanes.length === 0) return false
    const entry = await this.local.getIngested(hash)
    if (entry === null) return false
    if (over) for (const lane of lanes) lane.distrust(hash)
    const held = await Promise.all(
      lanes.map((l) =>
        l.upload(hash, entry.durationMs, () => this.local.pinArtifact(hash), this.local.uploads),
      ),
    )
    return held.includes(true)
  }

  /**
   * Resolves once every queued and in-flight upload settles; awaited before
   * `cache.close()`.
   */
  async drainUploads(): Promise<void> {
    await Promise.all(this.lanes.map((l) => l.drain()))
  }

  /** A stopped run starts no more uploads and stops waiting on those in flight. */
  stopUploads(): void {
    for (const lane of this.lanes) lane.stop()
  }

  async ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> {
    await this.local.ingest(hash, body, meta)
  }

  stats(opts?: CacheStatsOptions): CacheStats {
    return this.local.stats(opts)
  }

  prune(options: PruneOptions): Promise<PruneResult> {
    return this.local.prune(options)
  }

  /** `run()` drains the uploads and prefetches first, so the repeat counts are final here. */
  close(): void {
    for (const lane of this.lanes) lane.close()
    this.local.close()
  }
}

function durationOf(ms: unknown): number {
  return typeof ms === 'number' && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER ? Math.round(ms) : 0
}
