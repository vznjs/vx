// LayeredCache — the local cache with the declared remotes behind it.
//
// Read path:  try local. On miss, ask each readable remote in declared
// order; the first hit streams its body into local so the next read is a
// local hit.
//
// Write path: write to local synchronously. Upload the local artifact
// to every writable remote as a fire-and-forget background task; failures
// log a warning but never fail the user's run (the task already
// succeeded; the only loss is the remote cache entry). Each remote's
// boundary, upload pool and warnings are its `RemoteLane`.
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
  DeclaredOutputs,
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
  SaveArgs,
} from './cache.js'
import type { OutputDirRow } from './cache.js'
import { CorruptArtifactError } from './layer.js'
import { RemoteLane, type ResolvedRemote } from './remote-lane.js'
import type { PluginSecrets } from '../util/index.js'

const STOPPED: unique symbol = Symbol('stopped')

/**
 * A response body that errors once the run stops, so the ingest reading it
 * fails at once, removes its temp, and releases the connection; the cache
 * then closes under no write.
 */
function endsOnStop(
  body: Blob | Response,
  stopped: Promise<typeof STOPPED>,
  onChunk: (bytes: number) => void = () => {},
): Blob | Response {
  if (body instanceof Blob || body.body === null) return body
  const reader = body.body.getReader()
  let stop = false
  // Once, not raced per chunk: a cancel ends the pending read as `done`,
  // which the flag turns into an error rather than a short body.
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
 * The least a download is given against running its task. A stored
 * duration is the command's alone, in whole ms (Turbo's wire sends 0 for
 * a sub-ms task), and a budget under one weighing is none: a duration of
 * 0 gave up every body not in by the first, 99% in or not, and ran the
 * task beside the bytes already here.
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
 * What a remote knows of an artifact it holds, before it is downloaded:
 * the body's size in bytes and the producing task's duration, each when
 * the wire carries it (Turbo's batch query and `HEAD` do).
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
 * What a remote cache layer must provide — THE plugin seam for remote
 * caching. Core ships no wire client; a plugin's `cache` hook returns one
 * (or an embedder passes one as `RunOptions.remoteCache`), speaking
 * whatever protocol it wants, and `LayeredCache` owns everything else:
 * policy gating, in-flight dedup, remote provenance, and the never-fail
 * contract (implementations THROW on failure; every throw degrades to a
 * cache miss, reported to the remote's `onError`). The artifact bytes are the
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
  /**
   * Optional: make the layer ready (read a credential, ask for one).
   * Called once per run, in declared order, before the status line and the
   * first task, and only when the run's policy lets this remote read or
   * write: a `--cache-policy=remote:` run, `--no-cache` and a plan
   * (`--dry`, `vx show`) never call it, so the other methods may be asked
   * without it. A throw is a warning naming the plugin and turns the
   * remote off for the run; the run goes on. `ctx.secret` reads the
   * plugin's keychain and may ask on the terminal.
   */
  open?(ctx: RemoteOpenContext): Promise<void>
  /**
   * Optional: this run's access, for a machine that runs its tasks
   * elsewhere (`ExecutorContext.cacheFacts`); that machine's plugin reads
   * it as `CacheContext.lent`. Only access made for this run (an OIDC
   * exchange's), never a stored secret: the server's token decides what
   * it may write. Asked after `open`.
   */
  lend?(): Promise<LentAccess | undefined>
  /**
   * Existence probe: what the remote knows of the stored artifact, or null
   * when it holds none. `--dry` and `--force` ask it per key when the
   * remote cannot batch.
   */
  has(hash: string): Promise<ArtifactInfo | null>
  /**
   * Optional batch existence probe: given N hashes, the stored ones and what
   * the remote knows of each, in ONE round-trip. Its presence says the wire
   * can batch: a run asks it once for its keys, `--dry` before its per-key
   * answers, and `--force` in the background to skip uploads of held keys.
   * Without it a run GETs each key directly (no `has`). Never throws for
   * control flow: `null` means "no batch info; use per-hash".
   */
  hasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null>
  /**
   * Fetch an artifact; `null` = miss. `body` is read once, by core,
   * straight into the local cache — an HTTP wire returns its `fetch`
   * `Response`, a chunked wire `new Response(stream)`, bytes in hand
   * `new Blob([bytes])`. `durationMs` is the producing task's duration
   * when the wire carries it. A body that errors before its end stores
   * nothing and the read is a miss, so a layer can check bytes as they pass
   * (a digest, a signature) and refuse at the end.
   */
  get(hash: string): Promise<{ body: Blob | Response; durationMs: number | undefined } | null>
  /**
   * Store an artifact (fire-and-forget from LayeredCache's perspective).
   * `body` is file-backed (`Bun.file`) when the local store holds the
   * artifact, so a plugin that streams it never holds it whole, and every
   * read of it sees the same bytes. An entry is immutable: a `put` of a
   * key the remote holds keeps the stored bytes. Core never asks `has`
   * first; a wire that would overwrite checks inside, unless told `missing`.
   * `false`: nothing was sent and nothing failed (a layer that writes
   * nothing this run, such as one with no token), so no upload is counted.
   */
  put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void | false>
  /**
   * The run found `hash` in no remote, and a `put` of it follows: a wire
   * that checks before it overwrites can skip that request.
   */
  missing?(hash: string): void
}

export class LayeredCache implements CacheLayer {
  /** A remote layer is composed in by construction — see `CacheLayer.hasRemote`. */
  readonly hasRemote = true

  private readonly lanes: readonly RemoteLane[]
  /** Each key `save` uploaded: whether a remote took it (`uploaded`). */
  private readonly sent = new Map<string, Promise<boolean>>()

  /**
   * In-flight remote pulls keyed by hash. `prefetch` and `get` both go
   * through here, so a key probed concurrently by both resolves a
   * SINGLE walk of the remotes. Each promise resolves `true` iff the
   * artifact was successfully ingested into local. Entries are retained
   * for the run's lifetime: a settled `false` records "no remote had
   * such an artifact (or it was corrupt)", which lets `get` skip a
   * second lazy probe of the same dead hash. The map is bounded by the
   * number of distinct task keys in a run — negligible.
   */
  private readonly inflight = new Map<string, Promise<boolean>>()

  /**
   * Hashes whose local artifact was materialized FROM a remote this run
   * (by `prefetch` or `get`'s read-through). A later `get` finds them as
   * a local hit, but the work was still saved by the remote cache — so
   * we flip `source` to `'remote'` and the orchestrator reports
   * `cache-hit-remote`. Without this, a prefetch followed by a `get`
   * would mislabel a genuine remote hit as local. Each maps to how long
   * its download and ingest took.
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
    // The local-first skip lives in doPullFromRemote (the shared choke
    // point): pullFromRemote registers the `inflight` entry SYNCHRONOUSLY,
    // so a concurrent markRemoteAbsent can't clobber a pending pull — a
    // guard done here (behind an async local.has) would reopen that race.
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
   * Batch existence probe over the readable remotes — the subset of
   * `hashes` some remote holds, one round-trip each, or `null` when any
   * readable remote can't batch (no `hasMany`, or an error), or none may
   * be read. The prefetch pass treats a non-null answer as complete: it
   * fetches only the hits and pre-marks the rest (`markRemoteAbsent`) so
   * their lazy `get` skips the network, which is sound only when every
   * readable remote answered. Each answering remote keeps its own
   * absences either way, so a hash only a sibling holds costs it no GET.
   * Never throws.
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
   * Each readable remote asked key by key (`RemoteLane.hasEach`), a key
   * its batch answer already covered not asked again: a complete answer,
   * for a run that plans on it. Null when a probe failed or none may be read.
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
   * Record that no remote has an artifact for each of `hashes` (from a
   * batch probe), so a later `get`/`prefetch` short-circuits to a miss
   * WITHOUT a network round-trip. Byte-for-byte equivalent to a
   * background prefetch having resolved `false` into `inflight` — same
   * at-most-once semantics, same point-in-time staleness window — but
   * without spending the GET. Never overwrites an entry already in flight.
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
      // A prefetch this run may have materialized this entry FROM
      // remote; the local row exists now, but the work was saved by
      // the remote cache, so the provenance stays 'remote'. Its row lands
      // a tick before the pull settles and says so: wait for that.
      await this.inflight.get(hash)
      return this.asRemote(hash, localHit)
    }

    // Remote reads disabled (e.g. `--cache-policy=remote:`): a local miss is a
    // real miss; never touch a remote.
    if (this.readable.length === 0) return null

    // A prefetch may already have probed this hash (resolved) or be
    // mid-flight. Awaiting the shared promise guarantees AT MOST ONE
    // remote walk per key: a settled `false` means no remote had it
    // (no second probe), and a settled/in-flight `true` means the
    // artifact was/will-be ingested locally — re-read below.
    // A lookup never waits on the run's batch probe: a hit then paid two
    // round-trips before its first byte (the probe, then the GET), ~300 ms
    // an up-to-date task on CI. A GET answers a miss as fast as the probe.
    const ingested = await this.awaitOrRun(hash, this.pullFromRemote(hash, ctx))
    if (!ingested) return null

    // Read past the local READ gate: `ingest` is deliberately ungated, so
    // the artifact + index row this pull just wrote exist regardless of
    // policy, and the gate ("don't serve hits from the pre-existing local
    // cache") must not discard them. Going through the gated `get` here
    // made `--cache-policy=local:,remote:rw` download the artifact, throw the hit
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
   * A pull the task now waits on, given up when the rest of its body would
   * take longer than running the task (its stored duration, doubled for
   * the save a run adds): the task then runs here, a miss. Only a key the
   * batch probe sized and timed is judged, from its own body's pace so far.
   * The facts are read each tick: the probe can answer after the task asks.
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

  // Existence probe: local first, then each remote's HEAD — no body
  // transfer, no ingest, so the plan path stays read-only even against
  // a remote cache. Remote errors degrade to a miss (never throw).
  async has(hash: string): Promise<'local' | 'remote' | null> {
    if ((await this.local.has(hash)) === 'local') return 'local'
    for (const lane of this.readable) if ((await lane.has(hash)) !== null) return 'remote'
    return null
  }

  /**
   * Single implementation of the remote read-through, shared by
   * `prefetch` and `get`. Idempotent per hash via `inflight`: the first
   * caller starts the walk + validate + ingest; concurrent and later
   * callers await the same promise. Resolves `true` when the artifact
   * ends up in local, `false` on a miss in every remote / error /
   * corruption (degrades to a cache miss; the error is reported, never
   * thrown).
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
    // A stopped run waits on no read, as on no upload: a lookup or download
    // in flight held a Ctrl-C until its last byte (2026-10-17). The
    // plugin's request is left to the exit, and its body is cancelled.
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

    // Ingest the remote body into local using the caller-supplied
    // taskId/command plus the remote-reported durationMs, which `get`
    // returns beside the body (the layer decides where it reads it from);
    // taskId + command come from the orchestrator's TaskNode in scope.
    // Without `ctx`, we can't populate a meaningful entries row, so
    // ingest with placeholders — caller-side typing nudges everyone
    // toward passing ctx.
    const meta: IngestMeta = {
      taskId: ctx?.taskId ?? `${hash}#unknown`,
      command: ctx?.command ?? '',
      // A layer's number is taken only as a finite non-negative one: a NaN
      // failed the entry row's NOT NULL after the artifact was renamed into
      // place, which threw a valid hit away and orphaned its bytes, and a
      // negative or infinite one was stored and replayed (item 944).
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
      // The bytes came off the network — a corrupt/truncated remote
      // artifact must degrade to a cache miss (task re-executes), not
      // crash the run. A corrupt LOCAL artifact is a miss too, one level
      // down: `Cache.restoreOutputs` drops it (A-52).
      lane.report('download', hash, err)
      // Bad bytes there: the re-run's save sends good ones over them, or
      // every machine rebuilt the task and none repaired it (2026-10-24).
      if (err instanceof CorruptArtifactError) lane.distrust(hash)
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

  hashFile(filePath: string): Promise<string> {
    return this.local.hashFile(filePath)
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
    // Local write honors its own gates inside Cache.save (no-op when local
    // writes are disabled).
    await this.local.save(args)
    const writable = this.lanes.filter((l) => l.write)
    if (writable.length === 0) return
    // Write-through upload, OFF the task's critical path: each PUT runs in
    // its remote's bounded background pool so the task's worker slot is
    // released immediately, and `run()` awaits `drainUploads()` before
    // closing the cache. Errors are logged, not propagated: the task
    // already succeeded; we don't fail it on cache-server issues.
    //
    // Each job hands the plugin a file-backed Blob over the local artifact,
    // pinned under a private name when the job starts (`pinArtifact`): a
    // queued job holds a path, not a buffer, a plugin that streams the Blob
    // never holds it whole, and every read of it sees the same bytes though
    // a re-save of the key renames others over the live name. If a
    // concurrent `vx cache clean` removed the artifact first the pin throws
    // and this upload is skipped — the never-fail contract.
    const hash = args.hash
    const durationMs = args.entry.durationMs
    // Local writes disabled (`--cache-policy=local:,remote:rw`): there is no
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
   * True once a remote this run reads holds entry `hash`, uploading the
   * local entry to each one it also writes when none does. Another machine
   * of the run (a DTE worker) restores from the remotes alone: a hit only
   * this cache held, the remote having evicted it, failed its dependant
   * there.
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
   * Resolves once every remote's queued + in-flight background upload
   * settles. `run()` calls this next to the prefetch drain, before
   * `cache.close()` — an upload reading state after close would race.
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

  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    // Output-file fingerprints live in the local SQLite layer only —
    // they describe the state on this machine's filesystem.
    return this.local.loadOutputFilesBatch(hashes)
  }

  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): boolean {
    return this.local.isOutputsCurrent(projectDir, expected)
  }

  recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void> {
    return this.local.recordOutputDirs(hash, projectDir, prefixes, holds)
  }
  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void {
    this.local.recordOutputStamps(hash, projectDir, workspaceRoot)
  }

  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    return this.local.loadOutputDirsBatch(hashes)
  }

  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): boolean {
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
    for (const lane of this.lanes) lane.close()
    this.local.close()
  }
}

function durationOf(ms: unknown): number {
  return typeof ms === 'number' && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER ? Math.round(ms) : 0
}
