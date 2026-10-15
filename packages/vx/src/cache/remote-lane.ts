// One declared remote as `LayeredCache` reaches it: what the run lets it
// do, the boundary its answers cross (a plugin's shape is checked, its throw
// becomes a miss), its own upload pool, and its failures said once per
// class with the endpoint named. The order across remotes, the local store
// and provenance are `LayeredCache`'s; nothing here knows another remote.

import type { RemoteKeyTraffic, RemoteTraffic } from './cache.js'
import type { RemoteCacheLayer } from './layered-cache.js'

/** One remote, resolved: its wire and what the run's policy and its `access` let it do. */
export interface ResolvedRemote {
  readonly remote: RemoteCacheLayer
  readonly read: boolean
  readonly write: boolean
  /** Told of each failure this remote degrades to a miss; the default writes stderr. */
  readonly onError?: (err: Error) => void
}

/**
 * Cap on concurrent background PUTs per remote. Keeps a burst of cache
 * misses from opening one socket per task; excess uploads queue and drain
 * FIFO.
 */
const UPLOAD_CONCURRENCY = 4

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
 * carries one (a gRPC status, an errno, Bun's `ConnectionRefused`), because
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
  readonly read: boolean
  readonly write: boolean
  private readonly remote: RemoteCacheLayer
  private readonly endpoint: string | undefined
  private readonly onError: ((err: Error) => void) | undefined

  /**
   * Hashes a batch probe found absent here, so a later fetch skips this
   * remote without a round-trip. Same point-in-time staleness as the probe.
   */
  private readonly absent = new Set<string>()

  private readonly uploadQueue: Array<() => Promise<void>> = []
  private activeUploads = 0
  private drainWaiters: Array<() => void> = []

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
  ) {
    this.remote = resolved.remote
    this.read = resolved.read
    this.write = resolved.write
    this.onError = resolved.onError
    this.endpoint = printableEndpoint(resolved.remote.endpoint)
  }

  /** Existence probe; a failure is a miss. */
  async has(hash: string): Promise<boolean> {
    try {
      return Boolean(await this.remote.has(hash))
    } catch (err) {
      this.report('probe', hash, err)
      return false
    }
  }

  /**
   * The subset of `hashes` stored here in one round-trip, recording the
   * rest as absent; `null` when this remote cannot batch or the probe
   * failed, which the caller reads as "no batch info".
   */
  async hasMany(hashes: readonly string[]): Promise<Set<string> | null> {
    if (this.remote.hasMany === undefined) return null
    let found: unknown
    try {
      found = await this.remote.hasMany(hashes)
    } catch (err) {
      this.report('probe', batchOf(hashes), err)
      return null
    }
    if (found === null || found === undefined) return null
    if (!(found instanceof Set)) {
      this.report(
        'probe',
        batchOf(hashes),
        invalidRemoteResult(
          `hasMany() resolved ${describeValue(found)} (expected a Set of the hashes present, or null)`,
        ),
      )
      return null
    }
    const set = found as Set<string>
    for (const h of hashes) if (!set.has(h)) this.absent.add(h)
    return set
  }

  /** The artifact's body, or null on a miss, a known absence, a failure or a malformed answer. */
  async get(hash: string): Promise<{ body: Blob | Response; durationMs?: number } | null> {
    if (this.absent.has(hash)) return null
    let result: unknown
    try {
      result = await this.remote.get(hash)
    } catch (err) {
      this.report('download', hash, err)
      return null
    }
    if (!result) return null
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
      return null
    }
    return result as { body: Blob | Response; durationMs?: number }
  }

  /** Queue a PUT in this remote's bounded pool; `body` is asked for when the job starts. */
  upload(
    hash: string,
    durationMs: number,
    body: () => { body: Blob; release?: () => Promise<void> },
    tally: { count: number; bytes: number; ms: number; failed: number },
  ): void {
    const key = this.trafficOf(hash)
    key.uploading++
    this.traffic.inFlight++
    this.uploadQueue.push(async () => {
      const start = performance.now()
      let release: (() => Promise<void>) | undefined
      try {
        const got = body()
        release = got.release
        await this.remote.put(hash, got.body, { durationMs })
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
      }
    })
    this.pump()
  }

  /** Resolves once every queued and in-flight upload has settled. */
  async drain(): Promise<void> {
    if (this.activeUploads === 0 && this.uploadQueue.length === 0) return
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
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
    const e = err instanceof Error ? err : new Error(String(err))
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
    while (this.activeUploads < UPLOAD_CONCURRENCY && this.uploadQueue.length > 0) {
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
