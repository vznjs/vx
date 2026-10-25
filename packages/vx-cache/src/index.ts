// @vzn/vx-cache — `vxCache()`, a vx `cache` plugin for a server that speaks
// the vx-cache protocol (`@vzn/vx-cache-server`, its PROTOCOL.md, /v1).
// Nothing is on by default: declare it in `.vx/workspace.ts` with the
// server's URL. It serves CI jobs only: every request carries the job's
// OIDC token, and off CI it declines with one note. Every read names
// exact scopes: the run's branch, then the branches it reads after it.
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

/**
 * Uploads: up to `IN_FLIGHT` at once, each one artifact by `PUT`, whose
 * bytes reach the bucket untouched (M, 2026-10-25: no batch upload; a
 * batch passes through the server's code, which on Workers costs CPU by the
 * byte, and a 40 MB one ran out of it).
 */
class Lane<T> {
  private readonly waiting: { item: T; resolve(): void; reject(err: unknown): void }[] = []
  private open = 0

  constructor(private readonly send: (item: T) => Promise<void>) {}

  push(item: T): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.waiting.push({ item, resolve, reject })
    this.pump()
    return promise
  }

  private pump(): void {
    while (this.open < IN_FLIGHT && this.waiting.length > 0) {
      const w = this.waiting.shift()!
      this.open++
      void this.send(w.item)
        .then(w.resolve, w.reject)
        .finally(() => {
          this.open--
          this.pump()
        })
    }
  }
}

/** The limits a server names at `/v1/capabilities` and on each check (`x-artifact-max-*`). */
interface Limits {
  readonly maxCheckHashes: number
  readonly maxUploadBytes: number
}

const LIMIT_HEADERS: Record<keyof Limits, string> = {
  maxCheckHashes: 'x-artifact-max-check-hashes',
  maxUploadBytes: 'x-artifact-max-upload-bytes',
}

const count = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined

/** Each limit, or undefined when one is missing or bad. */
function limitsOf(read: (k: keyof Limits) => unknown): Limits | undefined {
  const maxCheckHashes = count(read('maxCheckHashes'))
  const maxUploadBytes = count(read('maxUploadBytes'))
  return maxCheckHashes === undefined || maxUploadBytes === undefined
    ? undefined
    : { maxCheckHashes, maxUploadBytes }
}

/**
 * The seam over vx-cache v1. `has` and `hasMany` are `check`, `get` a
 * download and `put` an upload by `PUT` (`Lane`). A check names the
 * scope of each ref the run reads, in order, and the first holding a hash
 * answers it; a download names the scope its check found. A refused token (401/403) throws
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

  private readonly uploads = new Lane<{ hash: string; body: Blob }>((item) => this.upload(item))

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
   * whatever each check names. Unnamed, said once: checks go one hash at
   * a time.
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
      `[vx] vx-cache: ${where} named no limits (maxCheckHashes, maxUploadBytes); checks go one hash at a time`,
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

  /** One check of the run's refs' scopes, in order: each hash answers the first that holds it. */
  async hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo>> {
    const held = new Map<string, ArtifactInfo>()
    if (this.disabled || this.refs.length === 0) return held
    const scopes = this.refs.map(scopeOf)
    const ask = [...new Set(hashes)]
    const max = (await this.limitsNow())?.maxCheckHashes ?? scopes.length
    const per = Math.max(1, Math.floor(max / scopes.length))
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(ask.length / per) }, (_, i) =>
        this.check(scopes, ask.slice(i * per, (i + 1) * per)),
      ),
    )
    for (const part of parts)
      for (const [hash, { size, scope }] of part) {
        held.set(hash, { size })
        this.found.set(hash, scope)
      }
    return held
  }

  /** `POST /v1/artifacts` (Turbo's batch query): the size and scope of each hash held. */
  private async check(
    scopes: readonly string[],
    hashes: readonly string[],
  ): Promise<Map<string, { size: number; scope: string }>> {
    const res = await this.json('/v1/artifacts', { hashes, scopes })
    if (res === undefined) return new Map()
    if (res.status !== 200) throw await refusal(res)
    const named = limitsOf((k) => Number(res.headers.get(LIMIT_HEADERS[k]) ?? NaN))
    if (named === undefined) this.limitsUnnamed(`the check (HTTP ${res.status})`)
    else this.limits = named
    const body = (await res.json()) as Record<string, unknown> | null
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('the check answered no object of hashes')
    }
    const out = new Map<string, { size: number; scope: string }>()
    for (const hash of hashes) {
      const info = body[hash]
      if (info === null) continue
      const { size, scope } = (info ?? {}) as { size?: unknown; scope?: unknown }
      if (
        typeof size !== 'number' ||
        !(size >= 0) ||
        typeof scope !== 'string' ||
        !scopes.includes(scope)
      ) {
        throw new Error(`the check answered no size and scope asked, or null, for ${hash}`)
      }
      out.set(hash, { size, scope })
    }
    return out
  }

  /** The scope a check found it under, else each ref's in order until one holds it. */
  async get(hash: string): Promise<{ body: Response; durationMs: undefined } | null> {
    const at = this.found.get(hash)
    for (const scope of at === undefined ? this.refs.map(scopeOf) : [at]) {
      if (this.disabled) return null
      const res = await this.request(`/v1/artifacts/${hash}`, {
        method: 'GET',
        headers: { 'x-artifact-scope': scope },
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

  /** One artifact by `PUT`: the server answers one its scope holds before reading the bytes. */
  private async upload(item: { hash: string; body: Blob }): Promise<void> {
    const res = await this.request(`/v1/artifacts/${item.hash}`, {
      method: 'PUT',
      body: item.body,
      headers: { 'content-type': 'application/octet-stream' },
      timeoutMs: this.config.uploadTimeoutMs,
      write: true,
    })
    if (res !== undefined && !res.ok) throw await refusal(res)
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
