// One declared remote as `LayeredCache` reaches it: what the run lets it
// do, the boundary its answers cross (a plugin's shape is checked, its throw
// becomes a miss), its own upload pool, and its failures said once per
// class with the endpoint named. The order across remotes, the local store
// and provenance are `LayeredCache`'s; nothing here knows another remote.

import { machineParallelism, thrownMessage } from '../util/index.js'
import type { RemoteKeyTraffic, RemoteTraffic } from './cache.js'
import type { ArtifactInfo, RemoteCacheLayer } from './layered-cache.js'

/** One remote, resolved: its wire and what the run's policy and its `access` let it do. */
export interface ResolvedRemote {
  readonly remote: RemoteCacheLayer
  /** The plugin that supplied it, whose keychain its `open` reads; none for an injected layer. */
  readonly plugin?: string
  /** Cleared, with `write`, when the remote's `open` fails: off for the rest of the run. */
  read: boolean
  write: boolean
  /** Told of each failure this remote degrades to a miss; the default writes stderr. */
  readonly onError?: (err: Error) => void
}

/**
 * A fault of `r` that a caller outside its lane degrades to a miss, said as
 * the lane says its own: to its `onError`, else stderr. Reporting never
 * escalates.
 */
export function sayRemoteFault(r: ResolvedRemote, e: Error): void {
  try {
    if (r.onError) r.onError(e)
    else process.stderr.write(`[vx] remote cache: ${e.message}\n`)
    // quiet: a throwing reporter must never fail the run
  } catch {}
}

/**
 * Requests at once to a remote, by default: pnpm's network concurrency
 * (Bun's is a fixed 64). A request waits on the network, not a core, so
 * the cap follows cores only past 21 of them.
 */
export function networkConcurrency(): number {
  return Math.min(96, Math.max(machineParallelism() * 3, 64))
}

/** The seam call a failure happened in, as the warning names it. */
export type RemoteOp = 'probe' | 'download' | 'upload'

const PREPOSITION: Record<RemoteOp, string> = { probe: 'at', download: 'from', upload: 'to' }

/**
 * What a remote layer resolves is a plugin's, so its shape is a boundary
 * (item 252): a `get` that resolved `{ body: 'abc' }` was reported as
 * "corrupt artifact … not a readable archive" — the bytes blamed for the
 * plugin's shape — and a `hasMany` that resolved an array reached the
 * prefetch pass's `.has()`. Named here and degraded to a miss, like every
 * other remote failure.
 */
function invalidRemoteResult(what: string): Error {
  return new Error(
    `remote cache layer returned an invalid result: ${what} — a plugin bug, degraded to a miss`,
  )
}

/** A plugin's `ArtifactInfo`, keeping only the fields that are finite, non-negative numbers; null when it is no object. */
function artifactInfo(value: unknown): ArtifactInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { size, durationMs } = value as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  return { ...(ok(size) ? { size } : {}), ...(ok(durationMs) ? { durationMs } : {}) }
}

function isBody(value: unknown): value is Blob | Response {
  return value instanceof Blob || value instanceof Response
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  // The pre-stream contract's shape, named so an unported layer reads its fix.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    return `a ${value.constructor.name}`
  return typeof value === 'object' ? 'an object' : typeof value
}

/** The layer's `endpoint` as it may be printed: no userinfo, query or fragment. */
function printableEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string' || endpoint === '') return undefined
  if (!URL.canParse(endpoint)) return endpoint
  const u = new URL(endpoint)
  if (u.username === '' && u.password === '' && u.search === '' && u.hash === '') return endpoint
  u.username = ''
  u.password = ''
  u.search = ''
  u.hash = ''
  return u.toString()
}

/**
 * What makes two failures "the same way": the error's `code` when it
 * carries one (a gRPC status, an errno, Bun's `ECONNREFUSED`), because
 * gRPC writes the elapsed time into its message and no two deadline messages
 * match; else the message with the artifact's hash taken out, so a 500 on
 * one hash and a 500 on the next are one class. The operation is not part of
 * it: an unreachable server fails the probe, the download and the upload
 * alike, and that is one fact.
 */
function failureClass(err: Error, hash: string | undefined): string {
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' || typeof code === 'number') return `${err.name}\0${code}`
  return hash === undefined ? err.message : err.message.replaceAll(hash, '\0')
}

/** A batch probe names no one hash, so its line counts them. */
function batchOf(hashes: readonly string[]): { batch: string } {
  return { batch: `of ${hashes.length} artifact${hashes.length === 1 ? '' : 's'}` }
}

export class RemoteLane {
  private readonly resolved: ResolvedRemote
  private readonly remote: RemoteCacheLayer
  private readonly endpoint: string | undefined
  private readonly onError: ((err: Error) => void) | undefined

  /**
   * Hashes a batch probe found absent here, so a later fetch skips this
   * remote without a round-trip. Same point-in-time staleness as the probe.
   */
  private readonly absent = new Set<string>()
  /** What a `hasMany` said this remote holds, as `absent` records the rest. */
  private readonly held = new Map<string, ArtifactInfo>()
  /** Keys whose bytes here did not read back (`distrust`). */
  private readonly distrusted = new Set<string>()

  /**
   * A remote the run writes but does not read (`--force`): which of the
   * run's up-front keys it already holds, from one `hasMany`. `found` is
   * null when the probe failed.
   */
  private presence:
    | Promise<{ asked: Set<string>; found: Map<string, ArtifactInfo> | null } | null>
    | undefined

  private readonly uploadQueue: Array<() => Promise<void>> = []
  private activeUploads = 0
  private drainWaiters: Array<() => void> = []
  /** Set by `stop()`: the run was stopped, so no upload starts and the drain waits on none. */
  private stopped = false
  private onStop: () => void = () => {}
  private readonly stopping = new Promise<void>((resolve) => {
    this.onStop = resolve
  })

  /**
   * One entry per failure class said: its first line went out, `repeats`
   * counts the ones held back. A run's requests are concurrent, so an
   * unreachable server otherwise printed its bare runtime message once per
   * request (three lines for one task over the Turbo wire, item 749).
   */
  private readonly reported = new Map<string, { cause: string; repeats: number }>()

  constructor(
    resolved: ResolvedRemote,
    private readonly traffic: RemoteTraffic,
    /** Background PUTs at once; excess uploads queue and drain FIFO. */
    private readonly uploadConcurrency: number = networkConcurrency(),
  ) {
    this.resolved = resolved
    this.remote = resolved.remote
    this.onError = resolved.onError
    this.endpoint = printableEndpoint(resolved.remote.endpoint)
  }

  get read(): boolean {
    return this.resolved.read
  }

  get write(): boolean {
    return this.resolved.write
  }

  /**
   * Existence probe; a failure is a miss. A key a `hasMany` this run
   * answered for is not asked again: `--dry` batches its keys first.
   */
  async has(hash: string): Promise<ArtifactInfo | null> {
    const held = this.held.get(hash)
    if (held !== undefined) return held
    if (this.absent.has(hash)) return null
    let found: unknown
    try {
      found = await this.remote.has(hash)
    } catch (err) {
      this.report('probe', hash, err)
      return null
    }
    if (found === null || found === undefined) return null
    const info = artifactInfo(found)
    if (info === null)
      this.report(
        'probe',
        hash,
        invalidRemoteResult(
          `has() resolved ${describeValue(found)} (expected { size, durationMs } or null)`,
        ),
      )
    return info
  }

  /**
   * The subset of `hashes` stored here in one round-trip, recording the
   * rest as absent; `null` when this remote cannot batch or the probe
   * failed, which the caller reads as "no batch info".
   */
  async hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> {
    if (this.remote.hasMany === undefined) return null
    let found: unknown
    try {
      found = await this.remote.hasMany(hashes)
    } catch (err) {
      this.report('probe', batchOf(hashes), err)
      return null
    }
    if (found === null || found === undefined) return null
    if (!(found instanceof Map)) {
      this.report(
        'probe',
        batchOf(hashes),
        invalidRemoteResult(
          `hasMany() resolved ${describeValue(found)} (expected a Map of the hashes present, or null)`,
        ),
      )
      return null
    }
    const out = new Map<string, ArtifactInfo>()
    for (const h of hashes) {
      const info = found.has(h) ? (artifactInfo(found.get(h)) ?? {}) : undefined
      if (info === undefined) this.absent.add(h)
      else {
        this.held.set(h, info)
        out.set(h, info)
      }
    }
    return out
  }

  /**
   * `hashes` asked one by one (`has`), `concurrency` at a time: what a
   * remote that answered no batch query holds, recording the rest as
   * absent. Null when any probe failed: then the answer is not complete.
   */
  async hasEach(
    hashes: readonly string[],
    concurrency: number,
  ): Promise<Map<string, ArtifactInfo> | null> {
    const out = new Map<string, ArtifactInfo>()
    const absent: string[] = []
    let failed = false
    let next = 0
    const one = async (): Promise<void> => {
      while (!failed && next < hashes.length) {
        const h = hashes[next++]!
        let found: unknown
        try {
          found = this.held.get(h) ?? (this.absent.has(h) ? null : await this.remote.has(h))
        } catch (err) {
          this.report('probe', h, err)
          failed = true
          return
        }
        if (found === null || found === undefined) absent.push(h)
        else out.set(h, artifactInfo(found) ?? {})
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, one))
    if (failed) return null
    for (const h of absent) this.absent.add(h)
    for (const [h, info] of out) this.held.set(h, info)
    return out
  }

  /**
   * The artifact's body, null on a miss or a known absence (unless
   * `fresh`: saved since the probe), undefined on a failure or a
   * malformed answer: the key may still be there.
   */
  async get(
    hash: string,
    fresh = false,
  ): Promise<{ body: Blob | Response; durationMs?: number } | null | undefined> {
    if (!fresh && this.absent.has(hash)) return null
    let result: unknown
    try {
      result = await this.remote.get(hash)
    } catch (err) {
      this.report('download', hash, err)
      return undefined
    }
    if (!result) {
      // Gone, whatever a probe said: the re-run's save uploads it.
      this.held.delete(hash)
      return null
    }
    if (typeof result !== 'object' || !isBody((result as { body?: unknown }).body)) {
      const shape =
        typeof result !== 'object'
          ? describeValue(result)
          : `body is ${describeValue((result as { body?: unknown }).body)}`
      this.report(
        'download',
        hash,
        invalidRemoteResult(
          `get() resolved ${shape} (expected { body: Blob | Response, durationMs } or null)`,
        ),
      )
      return undefined
    }
    // It holds the key: a save of it after this restore uploads nothing.
    const got = result as { body: Blob | Response; durationMs?: number }
    this.held.set(hash, got.durationMs === undefined ? {} : { durationMs: got.durationMs })
    return got
  }

  /** `hash`'s bytes here are unreadable: a save of it uploads, held or not. */
  distrust(hash: string): void {
    this.distrusted.add(hash)
  }

  /**
   * Start the batch probe `presence` reads. A lane that reads, never
   * writes, or cannot batch (no `hasMany`) ignores it: each upload then
   * asks `has` for its own key.
   */
  probeBeforeUpload(hashes: Promise<readonly string[]>): void {
    if (this.read || !this.write || this.remote.hasMany === undefined) return
    this.presence = hashes.then(
      async (asked) =>
        asked.length === 0 ? null : { asked: new Set(asked), found: await this.hasMany(asked) },
      () => null,
    )
  }

  /**
   * Whether this remote already holds `hash`, asked only by a lane the run
   * does not read: an entry is immutable, so a key it holds is the same
   * bytes and is not sent again. Answered from the batch probe when it
   * covered the key, else by one `has`; a failure reads as absent, and the
   * upload goes as before.
   */
  private async holds(hash: string): Promise<boolean> {
    const probed = await this.presence
    if (probed !== undefined && probed !== null && probed.found !== null && probed.asked.has(hash))
      return probed.found.has(hash)
    return (await this.has(hash)) !== null
  }

  /**
   * Queue a PUT in this remote's bounded pool; `body` is asked for when the
   * job starts. Resolves true once this remote holds `hash`: put now, or held already.
   * `absent`: no remote held it when the run asked, so none is asked again.
   */
  upload(
    hash: string,
    durationMs: number,
    body: () => Promise<{ body: Blob; release?: () => Promise<void> }>,
    tally: { count: number; bytes: number; ms: number; failed: number },
    absent = false,
  ): Promise<boolean> {
    const key = this.trafficOf(hash)
    key.uploading++
    this.traffic.inFlight++
    const { promise, resolve } = Promise.withResolvers<boolean>()
    this.uploadQueue.push(async () => {
      let release: (() => Promise<void>) | undefined
      let holds = false
      try {
        if (this.stopped) return
        // A key whose bytes here did not read back is sent over them.
        const distrusted = this.distrusted.has(hash)
        const known = !distrusted && (absent || this.absent.has(hash))
        if (!distrusted) {
          if (this.held.has(hash)) return void (holds = true)
          if (!known && !this.read && (await this.holds(hash))) return void (holds = true)
        }
        if (this.stopped) return
        const start = performance.now()
        const got = await body()
        release = got.release
        if (known) this.remote.missing?.(hash)
        if ((await this.remote.put(hash, got.body, { durationMs })) === false) return
        holds = true
        tally.count++
        tally.bytes += got.body.size
        tally.ms += Math.round(performance.now() - start)
        key.landed = true
      } catch (err) {
        tally.failed++
        this.report('upload', hash, err)
      } finally {
        await release?.()
        key.uploading--
        this.traffic.inFlight--
        // Nothing sent and nothing failed (the remote held it, or the run
        // stopped first): no traffic, so the footer counts no upload.
        if (key.uploading === 0 && !key.landed && key.failures.length === 0)
          this.traffic.keys.delete(hash)
        resolve(holds)
      }
    })
    this.pump()
    return promise
  }

  /** Settles when the run is stopped. */
  get whenStopped(): Promise<void> {
    return this.stopping
  }

  /** Resolves once every queued and in-flight upload has settled, or the run was stopped. */
  async drain(): Promise<void> {
    // A probe no upload waited on still runs: settled before the run tears
    // the plugin down.
    await Promise.race([this.presence, this.stopping])
    if (this.stopped || (this.activeUploads === 0 && this.uploadQueue.length === 0)) return
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
  }

  /**
   * The run was stopped (Ctrl-C, SIGTERM, an embedder's abort): queued
   * uploads never start and the drain stops waiting on the ones in flight,
   * which a plugin cannot be asked to cancel. Reads in flight are given up
   * the same way (`LayeredCache.pullFrom`). A slow remote held a stopped
   * run past the signal's exit bound, which then exited with no footer.
   */
  stop(): void {
    this.stopped = true
    this.onStop()
    for (const resolve of this.drainWaiters.splice(0)) resolve()
  }

  /** Say the held-back repeats; the run drained first, so the counts are final. */
  close(): void {
    for (const { cause, repeats } of this.reported.values()) {
      if (repeats === 0) continue
      this.emit(
        new Error(
          `${repeats} more request${repeats === 1 ? '' : 's'} failed the same way: ${cause}`,
        ),
      )
    }
    this.reported.clear()
  }

  /**
   * `subject` is the artifact's hash, or the batch for a `hasMany`. The
   * wire's own message says what went wrong but not on what or where: an
   * upload deadline read `The operation timed out.` with no upload, hash or
   * server in it (item 749).
   */
  report(op: RemoteOp, subject: string | { batch: string }, err: unknown): void {
    const e = err instanceof Error ? err : new Error(thrownMessage(err))
    const hash = typeof subject === 'string' ? subject : undefined
    // A batch probe's failure is no one task's: each of its hashes is asked
    // again on its own, and that ask is the one counted.
    if (hash !== undefined) {
      const failures = this.trafficOf(hash).failures
      const said = `${op}: ${e.message}`
      if (!failures.includes(said)) failures.push(said)
    }
    const cls = failureClass(e, hash)
    const seen = this.reported.get(cls)
    if (seen !== undefined) {
      seen.repeats++
      return
    }
    this.reported.set(cls, { cause: e.message, repeats: 0 })
    const what = typeof subject === 'string' ? subject : subject.batch
    const where = this.endpoint === undefined ? '' : ` ${PREPOSITION[op]} ${this.endpoint}`
    this.emit(new Error(`${op} ${what}${where} failed: ${e.message}`, { cause: e }))
  }

  private trafficOf(hash: string): RemoteKeyTraffic {
    let key = this.traffic.keys.get(hash)
    if (key === undefined) {
      key = { uploading: 0, landed: false, failures: [] }
      this.traffic.keys.set(hash, key)
    }
    return key
  }

  private pump(): void {
    while (this.activeUploads < this.uploadConcurrency && this.uploadQueue.length > 0) {
      const job = this.uploadQueue.shift()!
      this.activeUploads++
      // Jobs never reject (each wraps its PUT in the never-fail guard).
      void job().finally(() => {
        this.activeUploads--
        this.pump()
      })
    }
    if (this.activeUploads === 0 && this.uploadQueue.length === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters
      this.drainWaiters = []
      for (const w of waiters) w()
    }
  }

  private emit(e: Error): void {
    // The remote cache is fully optional: NO remote failure — a 500, a
    // network drop, a corrupt artifact, even a throwing reporter — may
    // ever fail the run. A buggy reporter can't turn an optional-cache
    // hiccup into a run failure.
    try {
      if (this.onError) this.onError(e)
      else process.stderr.write(`[vx] remote cache: ${e.message}\n`)
    } catch {
      // swallow — reporting must never escalate
    }
  }
}
