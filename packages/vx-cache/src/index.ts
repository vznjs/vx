// @vzn/vx-cache — `vxCache()`, a vx `cache` plugin for a server that speaks
// the vx-cache protocol (`@vzn/vx-cache-server`, its PROTOCOL.md, /v1).
// Nothing is on by default: declare it in `.vx/workspace.ts` with the
// server's URL. It serves CI jobs only: every request carries the job's
// OIDC token, and off CI it declines with one note. Every read names
// exact keys: the run's branch, then the branches it reads after it.
// Imports core only through `@vzn/vx`.

import {
  type ArtifactInfo,
  definePlugin,
  type LentAccess,
  type PluginOptionKinds,
  refuseUnknownOptions,
  type RemoteCacheLayer,
  type VxPlugin,
} from '@vzn/vx'

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
/** Uploads open at once; more wait. */
const IN_FLIGHT = 4
/** Waiting uploads go as one batch only when more than this many wait. */
const BATCH_OVER = 2
const BATCH_TYPE = 'application/vnd.vx-cache.batch'

/** A ref's scope on the wire: its SHA-256's first 128 bits in hex, never the ref (M, 2026-10-25). */
const scopeOf = (ref: string): string =>
  new Bun.CryptoHasher('sha256').update(ref).digest('hex').slice(0, 32)

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

/** The limits a server names at `/v1/capabilities` and on each check (`x-vx-max-*`). */
interface Limits {
  readonly maxCheckKeys: number
  readonly maxBatchArtifacts: number
  readonly maxUploadBytes: number
}

const LIMIT_HEADERS: Record<keyof Limits, string> = {
  maxCheckKeys: 'x-vx-max-check-keys',
  maxBatchArtifacts: 'x-vx-max-batch-artifacts',
  maxUploadBytes: 'x-vx-max-upload-bytes',
}

const count = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined

/** Each limit, or undefined when one is missing or bad. */
function limitsOf(read: (k: keyof Limits) => unknown): Limits | undefined {
  const maxCheckKeys = count(read('maxCheckKeys'))
  const maxBatchArtifacts = count(read('maxBatchArtifacts'))
  const maxUploadBytes = count(read('maxUploadBytes'))
  return maxCheckKeys === undefined ||
    maxBatchArtifacts === undefined ||
    maxUploadBytes === undefined
    ? undefined
    : { maxCheckKeys, maxBatchArtifacts, maxUploadBytes }
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
 * download and `put` an upload, alone or in a batch (`Lane`). Every read
 * names exact `{ scope, hash }` keys, one per ref the run reads, and the
 * first ref holding a hash answers it. A refused token (401/403) throws
 * once, for core to report, and turns the layer off for the run; an
 * upload's 403 turns off writes alone (a job that reads only).
 */
export class VxCacheLayer implements RemoteCacheLayer {
  readonly endpoint: string
  private disabled = false
  private writesRefused = false
  /** The refs a read names, in order: the first holding a hash answers it. */
  refs: readonly string[] = []
  /** The ref a check found each hash under, which its download names. */
  private readonly found = new Map<string, string>()
  /** The limits the server named, at `/v1/capabilities` and on its last check; nothing is guessed. */
  private limits: Limits | undefined
  private asked: Promise<Limits | undefined> | undefined
  /** Where the layer says what is no failure of a request: core's `ctx.warn`. */
  warn: (message: string) => void = () => {}
  private limitsMissing = false

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
      body?: Blob | string | ReadableStream<Uint8Array>
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

  private json(path: string, body: unknown): Promise<Response | undefined> {
    return this.request(path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  }

  /**
   * The server's limits: `/v1/capabilities`, asked once and kept, then
   * whatever each check names. Unnamed, said once: checks go one ref's
   * key at a time and uploads one artifact at a time.
   */
  private async limitsNow(): Promise<Limits | undefined> {
    if (this.limits !== undefined) return this.limits
    this.asked ??= (async () => {
      const res = await this.request('/v1/capabilities', { method: 'GET' })
      if (res === undefined) return undefined
      if (res.status !== 200) throw await refusal(res)
      const body = (await res.json()) as Record<string, unknown> | null
      const named = limitsOf((k) => body?.[k])
      if (named === undefined) this.limitsUnnamed(`/v1/capabilities (HTTP ${res.status})`)
      return named
    })()
    this.limits ??= await this.asked
    return this.limits
  }

  private limitsUnnamed(where: string): void {
    if (this.limitsMissing) return
    this.limitsMissing = true
    this.warn(
      `[vx] vx-cache: ${where} named no limits (maxCheckKeys, maxBatchArtifacts, maxUploadBytes); checks and uploads go one at a time`,
    )
  }

  /** Starts asking for the limits, so the first check need not wait for them. */
  start(): void {
    this.limitsNow().catch(() => {
      // quiet here: the first check asks again and reports what it gets
      this.asked = undefined
    })
  }

  async has(hash: string): Promise<ArtifactInfo | null> {
    return (await this.hasMany([hash])).get(hash) ?? null
  }

  async hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo>> {
    if (this.disabled || this.refs.length === 0) return new Map()
    const scopes = this.refs.map(scopeOf)
    const keys = hashes.flatMap((hash) => scopes.map((scope) => ({ scope, hash })))
    const per = (await this.limitsNow())?.maxCheckKeys ?? 1
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(keys.length / per) }, (_, i) =>
        this.check(keys.slice(i * per, (i + 1) * per)),
      ),
    )
    const sizes = parts.flat()
    const held = new Map<string, ArtifactInfo>()
    // Keys go hash by hash, each in the refs' order: the first held wins.
    for (const [i, { scope, hash }] of keys.entries()) {
      const size = sizes[i]
      if (held.has(hash) || typeof size !== 'number' || size < 0) continue
      held.set(hash, { size })
      this.found.set(hash, scope)
    }
    return held
  }

  /** `POST /v1/artifacts/check`: each key's size, or null, in order. */
  private async check(keys: readonly { scope: string; hash: string }[]): Promise<unknown[]> {
    const res = await this.json('/v1/artifacts/check', { keys })
    if (res === undefined) return []
    if (res.status !== 200) throw await refusal(res)
    const named = limitsOf((k) => Number(res.headers.get(LIMIT_HEADERS[k]) ?? NaN))
    if (named === undefined) this.limitsUnnamed(`the check (HTTP ${res.status})`)
    else this.limits = named
    const body = (await res.json()) as { sizes?: unknown } | null
    if (!Array.isArray(body?.sizes) || body.sizes.length !== keys.length) {
      throw new Error('the check answered no `sizes` list, one per key')
    }
    return body.sizes
  }

  /** The scope a check found it under, else each ref's in order until one holds it. */
  async get(hash: string): Promise<{ body: Response; durationMs: undefined } | null> {
    const at = this.found.get(hash)
    for (const scope of at === undefined ? this.refs.map(scopeOf) : [at]) {
      if (this.disabled) return null
      const res = await this.request(`/v1/artifacts/download/${hash}`, {
        method: 'GET',
        headers: { 'x-vx-scope': scope },
      })
      if (res === undefined) return null
      if (res.status === 404) {
        await res.body?.cancel()
        continue
      }
      if (res.status !== 200) throw await refusal(res)
      return { body: res, durationMs: undefined }
    }
    return null
  }

  /** An artifact over the server's upload limit is not sent: it is said. */
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
   * ones before reading its bytes.
   */
  private async upload(batch: Waiting<{ hash: string; body: Blob }, void>[]): Promise<void> {
    let send = batch
    if (batch.length > BATCH_OVER) {
      const held = await this.hasMany(batch.map((w) => w.item.hash))
      send = batch.filter((w) => !held.has(w.item.hash))
      for (const w of batch) if (held.has(w.item.hash)) w.resolve()
      if (send.length === 0) return
    }
    const line = JSON.stringify({
      artifacts: send.map((w) => ({ hash: w.item.hash, size: w.item.body.size })),
    })
    // Streamed, each artifact read as it is sent: a 100 MB batch never sits
    // in memory. Not one Blob of them all: Bun 1.4.4 drops a file-backed
    // Blob nested in another, and the body falls short.
    const parts = [new Blob([`${line}\n`]), ...send.map((w) => w.item.body)]
    const size = parts.reduce((n, p) => n + p.size, 0)
    async function* bytes(): AsyncGenerator<Uint8Array> {
      for (const p of parts) yield* p.stream()
    }
    const it = bytes()
    const res = await this.request('/v1/artifacts/upload', {
      body: new ReadableStream<Uint8Array>({
        async pull(c) {
          const { done, value } = await it.next()
          if (done) c.close()
          else c.enqueue(value)
        },
      }),
      headers: { 'content-type': BATCH_TYPE, 'content-length': String(size) },
      timeoutMs: this.config.uploadTimeoutMs,
      write: true,
    })
    if (res !== undefined && !res.ok) throw await refusal(res)
    for (const w of send) w.resolve()
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
  return definePlugin(import.meta, {
    cache(ctx): RemoteCacheLayer | undefined {
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
      if (ctx.refs.length === 0) {
        ctx.warn(
          '[vx] vx-cache: the run reads no ref, so it names no key; remote cache off for this run',
        )
        return undefined
      }
      const layer = new VxCacheLayer(config)
      layer.refs = [...new Set(ctx.refs)]
      layer.lent = ctx.lent
      layer.warn = ctx.warn
      layer.start()
      return layer
    },
  })
}
