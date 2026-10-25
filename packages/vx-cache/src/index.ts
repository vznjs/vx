// @vzn/vx-cache — `vxCache()`, a vx `cache` plugin for a server that speaks
// the vx-cache protocol (`@vzn/vx-cache-server`, its PROTOCOL.md, /v1).
// Nothing is on by default: declare it in `.vx/workspace.ts` with the
// server's URL. It serves CI jobs only: every request carries the job's
// OIDC token, and off CI it declines with one note. It also keeps the
// timings a scheduler needs: each task a run ran is timed on the server,
// and every run orders its tasks by the critical path those timings give.
// Imports core only through `@vzn/vx`.

import {
  type ArtifactInfo,
  definePlugin,
  type LentAccess,
  LocalHistoryProvider,
  type PluginOptionKinds,
  refuseUnknownOptions,
  type RemoteCacheLayer,
  type TaskNode,
  type TaskOutcome,
  type TaskResources,
  taskDefinitions,
  type VxPlugin,
} from '@vzn/vx'
import { criticalPath } from '@vzn/vx-schedule-history'

export interface VxCacheOptions {
  /** The server's base URL (`https://cache.example.com`), or `VX_CACHE_URL`. */
  url?: string
  /** Per-request deadline for reads and queries (default 30 s). */
  timeoutMs?: number
  /** … and for an upload (default 60 s). */
  uploadTimeoutMs?: number
}

const KEYS: PluginOptionKinds<VxCacheOptions> = {
  url: 'string',
  timeoutMs: 'number',
  uploadTimeoutMs: 'number',
}

/** What a run that ran a task learned of it: what the server keeps. */
export interface Timing {
  /** The task's definition hash (`taskDefinitions`). */
  hash: string
  durationMs: number
  /** CPU cores it kept busy on average. */
  cores?: number
  /** Its peak memory. */
  rssBytes?: number
}

/** A JWT's `exp`, in ms, or 0 when it has none. */
function expiryOf(jwt: string): number {
  try {
    const exp = (
      JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
        exp?: unknown
      }
    ).exp
    return typeof exp === 'number' ? exp * 1000 : 0
  } catch {
    return 0
  }
}

/** A lent token ending sooner than this is asked again first, so a request never carries a spent one. */
const LEND_MARGIN_MS = 5 * 60_000
/** Hashes one check or timings query carries (the server's cap). */
const QUERY_MAX = 1000
/** Uploads open at once; more wait. */
const IN_FLIGHT = 4
/** Waiting uploads go as one batch only when more than this many wait. */
const BATCH_OVER = 2
/** Timings one upload's line carries (the server's cap). */
const LINE_TIMINGS_MAX = 1000
/** Timings one `POST /v1/timings/upload` carries (the server's cap). */
const TIMINGS_MAX = 20_000
/** Timings asked per task: the newest few, trusted first. */
const TIMINGS_LIMIT = 5
/** Refs one read names (the protocol's cap). */
const READ_SCOPES_MAX = 8
const BATCH_TYPE = 'application/vnd.vx-cache.batch'

/** `x-artifact-read-scopes`: an RFC 8941 list of strings. */
function readScopes(refs: readonly string[]): Record<string, string> {
  const list = refs.slice(0, READ_SCOPES_MAX)
  return list.length === 0
    ? {}
    : { 'x-artifact-read-scopes': list.map((r) => `"${r.replace(/[\\"]/g, '\\$&')}"`).join(', ') }
}

/** A refusal, named by its status and the server's own `message`. */
async function refusal(res: Response): Promise<Error> {
  let said = ''
  try {
    const text = (await res.text()).slice(0, 2048)
    try {
      const message = (JSON.parse(text) as { message?: unknown }).message
      said = typeof message === 'string' ? message : text
    } catch {
      said = text
    }
  } catch {
    // quiet: the status alone still names the refusal
  }
  said = said.replace(/\s+/g, ' ').trim().slice(0, 200)
  return new Error(`HTTP ${res.status}${said === '' ? '' : `: ${said}`}`)
}

/** A deadline that names itself: the runtime's own abort says only "The operation timed out." */
function deadline(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error(`no answer within ${ms} ms`)), ms).unref()
  return controller.signal
}

interface Waiting<T, R> {
  readonly item: T
  resolve(r: R): void
  reject(err: unknown): void
}

/**
 * Uploads: up to `IN_FLIGHT` requests at once, each of one artifact while
 * few wait, and of a batch once more than `BATCH_OVER` do.
 */
class Lane<T, R> {
  private readonly waiting: Waiting<T, R>[] = []
  private open = 0

  constructor(
    /** Takes the batch from the front of `waiting`: at least one. */
    private readonly take: (waiting: Waiting<T, R>[]) => Waiting<T, R>[],
    private readonly send: (batch: Waiting<T, R>[]) => Promise<void>,
  ) {}

  push(item: T): Promise<R> {
    const { promise, resolve, reject } = Promise.withResolvers<R>()
    this.waiting.push({ item, resolve, reject })
    this.pump()
    return promise
  }

  private pump(): void {
    while (this.open < IN_FLIGHT && this.waiting.length > 0) {
      const batch =
        this.waiting.length > BATCH_OVER ? this.take(this.waiting) : this.waiting.splice(0, 1)
      this.open++
      void this.send(batch)
        .catch((err: unknown) => {
          for (const w of batch) w.reject(err)
        })
        .finally(() => {
          this.open--
          this.pump()
        })
    }
  }
}

/** The batch limits a server named on a check (`x-vx-max-*`). */
interface Limits {
  readonly maxBatchArtifacts: number
  readonly maxUploadBytes: number
}

/**
 * The front of `waiting` within the server's `limits`, at least one; one
 * alone while the server has named none.
 */
function takeBatch<T, R>(
  waiting: Waiting<T, R>[],
  limits: Limits | undefined,
  size: (item: T) => number,
): Waiting<T, R>[] {
  if (limits === undefined) return waiting.splice(0, 1)
  let n = 0
  let bytes = 0
  while (n < waiting.length && n < limits.maxBatchArtifacts) {
    const s = size(waiting[n]!.item)
    if (n > 0 && bytes + s > limits.maxUploadBytes) break
    bytes += s
    n++
  }
  return waiting.splice(0, Math.max(1, n))
}

/**
 * The seam over vx-cache v1. `has` and `hasMany` are `check`, `get` a
 * download and `put` an upload, alone or in a batch (`Lane`). A
 * refused token (401/403) throws once, for core to report, and turns the
 * layer off for the run; an upload's 403 turns off writes alone (a job
 * that reads only).
 */
export class VxCacheLayer implements RemoteCacheLayer {
  readonly endpoint: string
  private disabled = false
  private writesRefused = false
  /** Headers every read carries: the refs it may be answered from. */
  reads: Record<string, string> = {}
  /** The batch limits the server named on its last check; none until then, so nothing is guessed. */
  private limits: Limits | undefined
  /** Where the layer says what is no failure of a request: core's `ctx.warn`. */
  warn: (message: string) => void = () => {}
  private limitsMissing = false
  /** Timings not yet sent: each upload's line carries them, and `flushTimings` the rest. */
  private pending: Timing[] = []

  private readonly uploads = new Lane<{ hash: string; body: Blob }, void>(
    (w) => takeBatch(w, this.limits, (x) => x.body.size),
    (batch) => this.upload(batch),
  )

  constructor(
    private readonly config: Required<VxCacheOptions>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: Record<string, string | undefined> = Bun.env,
  ) {
    this.endpoint = config.url
  }

  private idToken: { jwt: string; exp: number } | undefined
  /** The token a run running its tasks here lent (`CacheContext.lent`). */
  lent: (() => string | undefined) | undefined

  /** On GitHub Actions with `id-token: write`: the job's token is asked for. */
  private get github(): boolean {
    return !!this.env.ACTIONS_ID_TOKEN_REQUEST_URL && !!this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  }

  /**
   * The bearer: a token the run lent, else the job's GitHub OIDC token for
   * the server's origin, asked again a minute before it ends, else
   * `VX_CACHE_TOKEN` (GitLab's `id_tokens`). A lent token beats the job's
   * own: a job of another workflow writes nowhere the run reads. A token
   * GitHub would not give throws once, and the layer turns off.
   */
  private async bearer(marginMs = 60_000): Promise<string> {
    const lent = this.lent?.()
    if (lent !== undefined) return lent
    if (!this.github) return this.env.VX_CACHE_TOKEN ?? ''
    if (this.idToken !== undefined && Date.now() < this.idToken.exp - marginMs) {
      return this.idToken.jwt
    }
    const ask = new URL(this.env.ACTIONS_ID_TOKEN_REQUEST_URL!)
    ask.searchParams.set('audience', new URL(this.config.url).origin)
    let jwt: unknown
    try {
      const res = await this.fetchImpl(ask, {
        headers: { authorization: `bearer ${this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN!}` },
        signal: deadline(this.config.timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      jwt = ((await res.json()) as { value?: unknown }).value
      if (typeof jwt !== 'string' || jwt === '') throw new Error('no token in its answer')
    } catch (err) {
      this.disabled = true
      throw new Error(
        `GitHub's OIDC endpoint: ${err instanceof Error ? err.message : String(err)}; remote cache off for this run`,
      )
    }
    this.idToken = { jwt, exp: expiryOf(jwt) }
    return jwt
  }

  /**
   * This job's token, for a job that runs this run's tasks
   * (`RemoteCacheLayer.lend`): its writes land where this run reads them.
   * GitHub's is asked again when it ends within five minutes. A token lent
   * to this job is never lent on.
   */
  async lend(): Promise<LentAccess | undefined> {
    if (this.lent?.() !== undefined) return undefined
    const jwt = await this.bearer(LEND_MARGIN_MS)
    if (jwt === '') return undefined
    const exp = this.github ? this.idToken!.exp : expiryOf(jwt)
    return { token: jwt, ...(exp === 0 ? {} : { expiresAt: exp - LEND_MARGIN_MS }) }
  }

  private async request(
    path: string,
    init: {
      method?: string
      body?: Blob | string
      headers?: Record<string, string>
      timeoutMs?: number
      write?: boolean
    } = {},
  ): Promise<Response | undefined> {
    const res = await this.fetchImpl(`${this.config.url}${path}`, {
      method: init.method ?? 'POST',
      headers: { authorization: `Bearer ${await this.bearer()}`, ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: deadline(init.timeoutMs ?? this.config.timeoutMs),
    })
    if (init.write === true && res.status === 403) {
      const first = !this.writesRefused
      this.writesRefused = true
      this.pending = []
      if (!first) return undefined
      throw new Error(
        `${(await refusal(res)).message}: the write was refused (this job reads only); writes off for this run, reads go on`,
      )
    }
    if (res.status === 401 || res.status === 403) {
      const first = !this.disabled
      this.disabled = true
      if (!first) return undefined
      throw new Error(
        `${(await refusal(res)).message}: the token was refused; remote cache off for this run`,
      )
    }
    return res
  }

  private json(path: string, body: unknown, write = false): Promise<Response | undefined> {
    return this.request(path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(write ? {} : this.reads) },
      ...(write ? { write, timeoutMs: this.config.uploadTimeoutMs } : {}),
    })
  }

  async has(hash: string): Promise<ArtifactInfo | null> {
    return (await this.hasMany([hash])).get(hash) ?? null
  }

  async hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo>> {
    if (this.disabled) return new Map()
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(hashes.length / QUERY_MAX) }, (_, i) =>
        this.check(hashes.slice(i * QUERY_MAX, (i + 1) * QUERY_MAX)),
      ),
    )
    return new Map(parts.flatMap((p) => [...p]))
  }

  /** `POST /v1/artifacts/check`: each held hash's size. */
  private async check(hashes: readonly string[]): Promise<Map<string, ArtifactInfo>> {
    const res = await this.json('/v1/artifacts/check', { hashes })
    if (res === undefined) return new Map()
    if (res.status !== 200) throw await refusal(res)
    this.readLimits(res)
    const body = (await res.json()) as unknown
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('the check answered no object')
    }
    const held = new Map<string, ArtifactInfo>()
    for (const hash of hashes) {
      const size = (body as Record<string, { size?: unknown } | null>)[hash]?.size
      if (typeof size !== 'number' || size < 0) continue
      held.set(hash, { size })
    }
    return held
  }

  /** A check's `x-vx-max-*` headers; missing or bad, said once, and uploads stay one at a time. */
  private readLimits(res: Response): void {
    const read = (name: string): number | undefined => {
      const n = Number(res.headers.get(name) ?? NaN)
      return Number.isSafeInteger(n) && n > 0 ? n : undefined
    }
    const maxBatchArtifacts = read('x-vx-max-batch-artifacts')
    const maxUploadBytes = read('x-vx-max-upload-bytes')
    if (maxBatchArtifacts !== undefined && maxUploadBytes !== undefined) {
      this.limits = { maxBatchArtifacts, maxUploadBytes }
    } else if (!this.limitsMissing) {
      this.limitsMissing = true
      this.warn(
        `[vx] vx-cache: the check (HTTP ${res.status}) named no batch limits (x-vx-max-batch-artifacts, x-vx-max-upload-bytes); uploads go one at a time`,
      )
    }
  }

  async get(hash: string): Promise<{ body: Response; durationMs: undefined } | null> {
    if (this.disabled) return null
    const res = await this.request(`/v1/artifacts/download/${hash}`, {
      method: 'GET',
      headers: this.reads,
    })
    if (res === undefined) return null
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (res.status !== 200) throw await refusal(res)
    return { body: res, durationMs: undefined }
  }

  /**
   * An artifact over the server's upload limit is not sent: it is said,
   * and the task's timing still goes.
   */
  async put(hash: string, body: Blob, _meta: { durationMs: number }): Promise<void> {
    if (this.disabled || this.writesRefused) return
    const max = this.limits?.maxUploadBytes
    if (max !== undefined && body.size > max) {
      this.warn(
        `[vx] vx-cache: ${hash} is ${body.size} bytes, over the server's upload limit of ${max}: not uploaded`,
      )
      return
    }
    await this.uploads.push({ hash, body })
  }

  /**
   * A batch of more than `BATCH_OVER` asks `check` first and sends only the
   * missing; fewer go straight, and the server answers an upload of held
   * ones before reading its bytes. The pending timings ride along.
   */
  private async upload(batch: Waiting<{ hash: string; body: Blob }, void>[]): Promise<void> {
    let send = batch
    if (batch.length > BATCH_OVER) {
      const held = await this.check(batch.map((w) => w.item.hash))
      send = batch.filter((w) => !held.has(w.item.hash))
      for (const w of batch) if (held.has(w.item.hash)) w.resolve()
      if (send.length === 0) return
    }
    const timings = this.pending.splice(0, LINE_TIMINGS_MAX)
    const line = JSON.stringify({
      artifacts: send.map((w) => ({ hash: w.item.hash, size: w.item.body.size })),
      ...(timings.length === 0 ? {} : { timings }),
    })
    try {
      const res = await this.request('/v1/artifacts/upload', {
        body: new Blob([`${line}\n`, ...send.map((w) => w.item.body)]),
        headers: { 'content-type': BATCH_TYPE },
        timeoutMs: this.config.uploadTimeoutMs,
        write: true,
      })
      if (res !== undefined && !res.ok) throw await refusal(res)
    } catch (err) {
      if (!this.writesRefused) this.pending.unshift(...timings)
      throw err
    }
    for (const w of send) w.resolve()
  }

  /** Keeps a timing for the next upload's line, or `flushTimings`. */
  addTiming(t: Timing): void {
    if (!this.disabled && !this.writesRefused) this.pending.push(t)
  }

  /** `POST /v1/timings/upload`: the timings no upload carried. */
  async flushTimings(): Promise<void> {
    while (this.pending.length > 0 && !this.disabled && !this.writesRefused) {
      const timings = this.pending.splice(0, TIMINGS_MAX)
      const res = await this.json('/v1/timings/upload', { timings }, true)
      if (res !== undefined && !res.ok) throw await refusal(res)
    }
  }

  /**
   * `POST /v1/timings/query`: each hash's newest timings, trusted first,
   * then the read refs in order. A hash none holds is absent.
   */
  async timings(hashes: readonly string[]): Promise<Map<string, Timing[]>> {
    if (this.disabled) return new Map()
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(hashes.length / QUERY_MAX) }, async (_, i) => {
        const asked = hashes.slice(i * QUERY_MAX, (i + 1) * QUERY_MAX)
        const res = await this.json('/v1/timings/query', { hashes: asked, limit: TIMINGS_LIMIT })
        if (res === undefined) return []
        if (res.status !== 200) throw await refusal(res)
        const body = (await res.json()) as { timings?: unknown }
        if (typeof body.timings !== 'object' || body.timings === null) {
          throw new Error('the timings query answered no `timings` object')
        }
        return Object.entries(body.timings as Record<string, unknown>)
      }),
    )
    const out = new Map<string, Timing[]>()
    for (const [hash, list] of parts.flat()) {
      if (!Array.isArray(list) || list.length === 0) continue
      out.set(
        hash,
        list.map((t: { durationMs: number; cores: number | null; rssBytes: number | null }) => ({
          hash,
          durationMs: t.durationMs,
          ...(t.cores === null ? {} : { cores: t.cores }),
          ...(t.rssBytes === null ? {} : { rssBytes: t.rssBytes }),
        })),
      )
    }
    return out
  }
}

/** A task the run ran and that succeeded, as the server keeps its timing; else undefined. */
function timingOf(o: TaskOutcome, hash: string | undefined): Timing | undefined {
  if (hash === undefined || o.status !== 'success') return undefined
  const durationMs = Math.max(0, Math.round(o.durationMs))
  // The cores it kept busy, as core's own history reads them.
  const cores =
    o.cpuMs === undefined || o.durationMs <= 0
      ? undefined
      : o.cpuMs / (o.durationMs * (o.cpuShare ?? 1))
  return {
    hash,
    durationMs,
    ...(cores === undefined ? {} : { cores }),
    ...(o.peakRssBytes === undefined ? {} : { rssBytes: o.peakRssBytes }),
  }
}

/** A task's timings as one forecast: the median duration, the mean cores, the largest peak. */
function forecastOf(list: readonly Timing[]): { ms: number; needs: TaskResources } {
  const ms = list.map((t) => t.durationMs).sort((a, b) => a - b)
  const cores = list.flatMap((t) => (t.cores === undefined ? [] : [t.cores]))
  const rss = list.flatMap((t) => (t.rssBytes === undefined ? [] : [t.rssBytes]))
  const p50 = ms[Math.floor(ms.length / 2)]!
  return {
    ms: p50,
    needs: {
      p50DurationMs: p50,
      ...(cores.length === 0
        ? {}
        : { maxCpuParallelism: cores.reduce((a, b) => a + b, 0) / cores.length }),
      ...(rss.length === 0 ? {} : { maxPeakRssBytes: Math.max(...rss) }),
    },
  }
}

/** Options over `VX_CACHE_URL`; `undefined`: no server named. */
export function resolveVxCacheConfig(
  options: VxCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
): Required<VxCacheOptions> | undefined {
  const url = (options.url ?? env.VX_CACHE_URL)?.replace(/\/+$/, '')
  if (url === undefined || url === '') return undefined
  if (!/^https?:\/\//.test(url)) throw new Error(`vxCache(): url must be http(s), got ${url}`)
  return {
    url,
    timeoutMs: options.timeoutMs ?? 30_000,
    uploadTimeoutMs: options.uploadTimeoutMs ?? 60_000,
  }
}

/** Whether this job has a CI token to send: GitHub's, GitLab's `VX_CACHE_TOKEN`, or one a run lent. */
export function hasCiToken(env: Record<string, string | undefined>, lent: boolean): boolean {
  return (
    lent ||
    (!!env.ACTIONS_ID_TOKEN_REQUEST_URL && !!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) ||
    !!env.VX_CACHE_TOKEN
  )
}

/**
 * Declare in `.vx/workspace.ts`; the local store stays the floor beneath it:
 *
 * ```ts
 * plugins: [vxCache({ url: 'https://cache.example.com' })]
 * ```
 */
export function vxCache(options: VxCacheOptions = {}): VxPlugin {
  refuseUnknownOptions('vxCache()', options, KEYS)
  // One layer per run, shared by its hooks.
  let layer: VxCacheLayer | undefined
  /** The run times its tasks: it was lent no token, so it is not running another run's. */
  let times = false
  let warn: ((m: string) => void) | undefined
  return definePlugin(import.meta, {
    cache(ctx): RemoteCacheLayer | undefined {
      layer = undefined
      const config = resolveVxCacheConfig(options)
      if (config === undefined) return undefined
      const lent = ctx.lent?.() !== undefined
      if (!hasCiToken(Bun.env, lent)) {
        ctx.warn(
          Bun.env.GITHUB_ACTIONS === 'true'
            ? '[vx] vx-cache: this job gets no OIDC token: give it `permissions: id-token: write`; remote cache off for this run'
            : '[vx] vx-cache: serves CI jobs only (no CI token here); remote cache off for this run',
        )
        return undefined
      }
      layer = new VxCacheLayer(config)
      layer.reads = readScopes(ctx.refs)
      layer.lent = ctx.lent
      layer.warn = ctx.warn
      times = !lent
      return layer
    },
    // The run never waits for the server: it starts on the baseline order,
    // and the critical path re-ranks what has not started when the timings
    // land in local history, where every reader of it finds them.
    schedule(nodes, ctx) {
      const l = layer
      if (l === undefined) return undefined
      const defs = taskDefinitions(nodes.values())
      if (defs.size === 0) return undefined
      ctx.refine(
        l.timings([...defs.values()]).then(
          async (byHash) => {
            const timings = new Map<string, number>()
            const needs = new Map<string, TaskResources>()
            for (const [id, def] of defs) {
              const list = byHash.get(def)
              if (list === undefined) continue
              const f = forecastOf(list)
              timings.set(id, f.ms)
              needs.set(id, f.needs)
            }
            if (timings.size === 0) return undefined
            const history = new LocalHistoryProvider(
              ctx.localCache.dbHandle(),
              undefined,
              ctx.branch,
              defs,
            )
            // One import per answer: a run that read the same keeps no more.
            const sha = `vx-cache:${Bun.hash(JSON.stringify([...byHash])).toString(16)}`
            if (!history.hasImported(sha)) history.importTimings(sha, timings, needs, defs)
            return criticalPath(
              [...nodes.values()],
              await history.resourcesFor([...defs.keys()]),
              {},
            )
          },
          (err: unknown) => {
            ctx.warn(
              `[vx] vx-cache: ordering stays on the baseline: ${err instanceof Error ? err.message : String(err)}`,
            )
            return undefined
          },
        ),
      )
      return undefined
    },
    setup(ctx) {
      warn = ctx.warn
      const l = layer
      if (l === undefined || !times) return
      ctx.on('onTaskComplete', (node: TaskNode, outcome: TaskOutcome) => {
        const def = taskDefinitions([node]).get(node.id)
        const t = timingOf(outcome, def)
        if (t !== undefined) l.addTiming(t)
      })
    },
    async teardown() {
      const l = layer
      if (l === undefined) return
      try {
        await l.flushTimings()
      } catch (err) {
        warn?.(
          `[vx] vx-cache: the timings were not written: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  })
}
