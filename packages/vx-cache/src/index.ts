// @vzn/vx-cache — `vxCache()`, a vx `cache` plugin for a server that speaks
// the vx-cache protocol (`@vzn/vx-cache-server`, its PROTOCOL.md, /v1).
// Nothing is on by default: declare it in `.vx/workspace.ts` with the
// server's URL, the CI issuer and the repository, which every request
// names by their hashes (2026-10-25: the user names them, nothing
// guesses). A CI job's requests carry its OIDC token and write; with no
// token it reads only, from a server with `READ_ACCESS=public`. Every read
// names exact scopes: the run's branch, then the branches it reads after it.
// Imports core only through `@vzn/vx`.

import {
  type ArtifactInfo,
  definePlugin,
  type LentAccess,
  type PluginOptionKinds,
  refuseUnknownOptions,
  type RemoteCacheLayer,
  UserError,
  type VxPlugin,
} from '@vzn/vx'

export interface VxCacheOptions {
  /** The server's base URL (`https://cache.example.com`; http only to this machine), or `VX_CACHE_URL`. */
  url?: string
  /** The CI issuer whose tokens the server takes, as they name it (`https://token.actions.githubusercontent.com`). */
  issuer: string
  /** The repository at that issuer, `org/name`. */
  repository: string
  /** Per-request deadline for reads and queries (default 30 s); a download's bounds its answer, then each gap between its bytes. */
  timeoutMs?: number
  /** … and for an upload (default 60 s). */
  uploadTimeoutMs?: number
  /**
   * Headers every request to the server carries, for a proxy in front of
   * it (`{ 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID }`, an
   * Access service token, 2026-10-25). An unset value is left out;
   * `authorization` stays the CI token's.
   */
  headers?: Record<string, string | undefined>
}

const KEYS: PluginOptionKinds<VxCacheOptions> = {
  url: 'string',
  issuer: 'string',
  repository: 'string',
  timeoutMs: 'number',
  uploadTimeoutMs: 'number',
  headers: 'object',
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
    // quiet: an unreadable exp is no known expiry; the server refuses the token
    return 0
  }
}

/** A lent token ending sooner than this is asked again first, so a request never carries a spent one. */
const LEND_MARGIN_MS = 5 * 60_000
/** Tries of GitHub's OIDC endpoint before the remote turns off (`askOnce`). */
const ASK_ATTEMPTS = 3
/** Uploads open at once; more wait. */
const IN_FLIGHT = 4

/** `headers` with unset values left out; a name or value no header can carry, or `authorization`, refused. */
function proxyHeaders(
  factory: string,
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.toLowerCase() === 'authorization')
      throw new Error(`${factory}: headers cannot set "${name}"`)
    if (typeof value !== 'string' || /[\r\n\0]/.test(value))
      throw new Error(`${factory}: header "${name}" must be one line of text`)
    out[name] = value
  }
  return out
}

/** A ref's scope, an issuer or a repository on the wire: its SHA-256's first 128 bits in hex, never the value (2026-10-25). */
const scopeOf = (ref: string): string =>
  new Bun.CryptoHasher('sha256').update(ref).digest('hex').slice(0, 32)

/**
 * `s` with each C0/C1 control and DEL written as `\xNN`: a server's words
 * reach the terminal, and an `ESC ]` or `\r` in them retitled it or
 * overwrote the line before (core's `printable`, L-31).
 */
const printable = (s: string): string =>
  // oxlint-disable-next-line no-control-regex
  s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)

/** A refusal, named by its status and the server's own `message`. */
async function refusal(res: Response): Promise<Error> {
  let said = ''
  try {
    const text = (await res.text()).slice(0, 2048)
    try {
      const message = (JSON.parse(text) as { message?: unknown }).message
      said = typeof message === 'string' ? message : text
    } catch {
      // quiet: not JSON, so the text is what it said
      said = text
    }
  } catch {
    // quiet: the status alone still names the refusal
  }
  said = printable(said.replace(/\s+/g, ' ').trim().slice(0, 200))
  return new Error(`HTTP ${res.status}${said === '' ? '' : `: ${said}`}`)
}

/**
 * A redirect, never followed: fetch drops only `Authorization` on one to
 * another origin, so `headers` (a proxy's secret) went where a 307 named.
 */
async function redirected(res: Response, from: string): Promise<Error> {
  await res.body?.cancel()
  const to = res.headers.get('location')
  return new Error(
    `HTTP ${res.status}${to === null ? '' : ` to ${new URL(to, from).href}`}: not followed, as it would carry the server's headers; name the server's own URL`,
  )
}

/** A deadline that names itself: the runtime's own abort says only "The operation timed out." */
function deadline(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error(`no answer within ${ms} ms`)), ms).unref()
  return controller.signal
}

/**
 * A download's deadline: `ms` for the answer, then `ms` between its body's
 * bytes. A whole-body deadline failed a big artifact still arriving at a
 * steady pace (a 30 s cut, CI 2026-10-25); core judges whether running
 * the task beats the rest of the wait.
 */
function streamed(res: Response, controller: AbortController, ms: number): Response {
  if (res.body === null) return res
  let timer: Timer | undefined
  const rearm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error(`no bytes for ${ms} ms`)), ms)
    timer.unref()
  }
  rearm()
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        rearm()
        out.enqueue(chunk)
      },
      flush: () => clearTimeout(timer),
    }),
  )
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/**
 * Uploads: up to `IN_FLIGHT` at once, each one artifact by `PUT`, whose
 * bytes reach the bucket untouched (2026-10-25: no batch upload; a
 * batch passes through the server's code, which on Workers costs CPU by the
 * byte, and a 40 MB one ran out of it).
 */
class Lane<T, R> {
  private readonly waiting: { item: T; resolve(r: R): void; reject(err: unknown): void }[] = []
  private open = 0

  constructor(private readonly send: (item: T) => Promise<R>) {}

  push(item: T): Promise<R> {
    const { promise, resolve, reject } = Promise.withResolvers<R>()
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

/** The limits a server names at `/v1/capabilities` and on each check (`vx-max-*`). */
interface Limits {
  readonly maxCheckHashes: number
  readonly maxUploadBytes: number
}

const LIMIT_HEADERS: Record<keyof Limits, string> = {
  maxCheckHashes: 'vx-max-check-hashes',
  maxUploadBytes: 'vx-max-upload-bytes',
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

  private readonly uploads = new Lane<{ hash: string; body: Blob }, void | false>((item) =>
    this.upload(item),
  )

  /** The issuer and repository, named on every request by their hashes. */
  private readonly named: Readonly<Record<string, string>>

  constructor(
    private readonly config: ResolvedVxCacheConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: Record<string, string | undefined> = Bun.env,
    private readonly wait: (ms: number) => Promise<void> = Bun.sleep,
  ) {
    this.endpoint = config.url
    this.named = {
      'vx-issuer': scopeOf(config.issuer),
      'vx-repository': scopeOf(config.repository),
    }
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
    // One ask for the requests that need it at once: each asked its own,
    // a check and two uploads three (2026-10-26).
    this.asking ??= this.askGithub().finally(() => (this.asking = undefined))
    return this.asking
  }

  private asking: Promise<string> | undefined
  /** A failed ask was said: the requests that shared it say nothing. */
  private tokenFailed = false

  /**
   * One answer from GitHub's OIDC endpoint, asked again after a 5xx, a 429
   * or none, up to three tries: a DTE run asks every few minutes for the
   * token it lends, and one 503 turned the remote off for the rest of the
   * run on every worker. A refusal (a 4xx) is final.
   */
  private async askOnce(ask: URL): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined
      let failure: unknown
      try {
        res = await this.fetchImpl(ask, {
          headers: { authorization: `bearer ${this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN!}` },
          signal: deadline(this.config.timeoutMs),
        })
      } catch (err) {
        failure = err
      }
      if (res !== undefined && res.status !== 429 && res.status < 500) return res
      if (attempt === ASK_ATTEMPTS) {
        if (res === undefined) throw failure
        return res
      }
      await res?.body?.cancel()
      await this.wait(1000 * attempt)
    }
  }

  private async askGithub(): Promise<string> {
    const ask = new URL(this.env.ACTIONS_ID_TOKEN_REQUEST_URL!)
    ask.searchParams.set('audience', new URL(this.config.url).origin)
    let jwt: unknown
    try {
      const res = await this.askOnce(ask)
      if (!res.ok) {
        // Unread, its body would hold the connection.
        await res.body?.cancel()
        throw new Error(`HTTP ${res.status}`)
      }
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
    // Its real end: the run lends again a few minutes before it (vx-dte's
    // RELEND_MS). Less a margin, GitHub's five-minute token ended as it was
    // lent, and the run lent again at once, in a loop.
    return { token: jwt, ...(exp === 0 ? {} : { expiresAt: exp }) }
  }

  private async request(
    path: string,
    init: {
      method?: string
      body?: Blob | string
      headers?: Record<string, string>
      timeoutMs?: number
      write?: boolean
      /** A body read at its own pace: the deadline then bounds the gaps between its bytes. */
      streamed?: boolean
    } = {},
  ): Promise<Response | undefined> {
    let bearer: string
    try {
      bearer = await this.bearer()
    } catch (err) {
      // The requests waiting on one ask share its failure: the first says it.
      if (this.tokenFailed) return undefined
      this.tokenFailed = true
      throw err
    }
    const ms = init.timeoutMs ?? this.config.timeoutMs
    const controller = new AbortController()
    const answer = setTimeout(() => controller.abort(new Error(`no answer within ${ms} ms`)), ms)
    answer.unref()
    const url = `${this.config.url}${path}`
    let res = await this.fetchImpl(url, {
      method: init.method ?? 'POST',
      headers: {
        ...this.config.headers,
        ...this.named,
        ...(bearer === '' ? {} : { authorization: `Bearer ${bearer}` }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: controller.signal,
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(answer)
      throw await redirected(res, url)
    }
    if (init.streamed === true) {
      clearTimeout(answer)
      res = streamed(res, controller, ms)
    }
    if (init.write === true && res.status === 403) {
      const first = !this.writesRefused
      this.writesRefused = true
      // The first says it; an unread body would hold its connection.
      if (!first) {
        await res.body?.cancel()
        return undefined
      }
      throw new Error(
        `${(await refusal(res)).message}: the write was refused (this job reads only); writes off for this run, reads go on`,
      )
    }
    if (res.status === 401 || res.status === 403) {
      const first = !this.disabled
      this.disabled = true
      if (!first) {
        await res.body?.cancel()
        return undefined
      }
      throw new Error(
        `${(await refusal(res)).message}: ${bearer === '' ? 'a read with no token was refused' : `the token was refused (this workspace names ${this.config.repository} at ${this.config.issuer})`}; remote cache off for this run`,
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
    const asked = (this.asked ??= (async () => {
      const res = await this.request('/v1/capabilities', { method: 'GET' })
      if (res === undefined) return undefined
      if (res.status !== 200) throw await refusal(res)
      const body = (await res.json()) as Record<string, unknown> | null
      const named = limitsOf((k) => body?.[k])
      if (named === undefined) this.limitsUnnamed(`/v1/capabilities (HTTP ${res.status})`)
      return named
    })())
    // A failed ask is asked again by the next check: kept, two failures
    // while a server restarted failed every read of the run (2026-10-26).
    // quiet: the awaited ask rethrows it; this only forgets it
    asked.catch(() => {
      if (this.asked === asked) this.asked = undefined
    })
    this.limits ??= await asked
    return this.limits
  }

  private limitsUnnamed(where: string): void {
    if (this.limitsMissing) return
    this.limitsMissing = true
    this.warn(
      `[vx] vx-cache: ${where} named no limits (maxCheckHashes, maxUploadBytes); checks go one hash at a time`,
    )
  }

  /** A refusal met while starting, which no call could throw: the next check or download does. */
  private unsaid: Error | undefined

  /** Throws the refusal met while starting, once. */
  private sayUnsaid(): void {
    const err = this.unsaid
    this.unsaid = undefined
    if (err !== undefined) throw err
  }

  /** Starts asking for the limits, so the first check need not wait for them. */
  start(): void {
    this.limitsNow().catch((err: unknown) => {
      // A refusal turned the layer off, and is said only once: the first
      // check says it. Anything else, the first check asks again and says.
      if (this.disabled) this.unsaid = err instanceof Error ? err : new Error(String(err))
    })
  }

  async has(hash: string): Promise<ArtifactInfo | null> {
    return (await this.hasMany([hash])).get(hash) ?? null
  }

  /** One check of the run's refs' scopes, in order: each hash answers the first that holds it. */
  async hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo>> {
    const held = new Map<string, ArtifactInfo>()
    this.sayUnsaid()
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
    this.sayUnsaid()
    const at = this.found.get(hash)
    for (const scope of at === undefined ? this.refs.map(scopeOf) : [at]) {
      if (this.disabled) return null
      const res = await this.request(`/v1/artifacts/${hash}`, {
        method: 'GET',
        headers: { 'vx-scope': scope },
        streamed: true,
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
  async put(hash: string, body: Blob, _meta: { durationMs: number }): Promise<void | false> {
    // With no token a job reads only: nothing is uploaded, and none counted.
    if (this.disabled || this.writesRefused || !hasCiToken(this.env, this.lent?.() !== undefined))
      return false
    const max = this.limits?.maxUploadBytes
    if (max !== undefined && body.size > max) {
      this.warn(
        `[vx] vx-cache: ${hash} is ${body.size} bytes, over the server's upload limit of ${max}: not uploaded`,
      )
      return false
    }
    return this.uploads.push({ hash, body })
  }

  /** One artifact by `PUT`: the server answers one its scope holds before reading the bytes. */
  private async upload(item: { hash: string; body: Blob }): Promise<void | false> {
    // Queued before the remote or its writes were turned off.
    if (this.disabled || this.writesRefused) return false
    const res = await this.request(`/v1/artifacts/${item.hash}`, {
      method: 'PUT',
      body: item.body,
      headers: { 'content-type': 'application/octet-stream' },
      timeoutMs: this.config.uploadTimeoutMs,
      write: true,
    })
    if (res === undefined) return false
    if (!res.ok) throw await refusal(res)
  }
}

/** The issuer and repository as a key names them: the issuer's URL with no trailing slash, `org/name` lowercased. */
function namedOf(options: VxCacheOptions): { issuer: string; repository: string } {
  const { issuer, repository } = options as Partial<VxCacheOptions>
  if (typeof issuer !== 'string' || !/^https?:\/\/\S+$/.test(issuer))
    throw new UserError(
      `vxCache(): issuer must be the CI issuer's URL (https://token.actions.githubusercontent.com), got ${String(issuer)}`,
    )
  if (typeof repository !== 'string' || !/^[^/\s]+(\/[^/\s]+)+$/.test(repository))
    throw new UserError(`vxCache(): repository must be org/name, got ${String(repository)}`)
  return { issuer: issuer.replace(/\/$/, ''), repository: repository.toLowerCase() }
}

/** The deadlines, each one a timer waits on: Bun fires a zero, NaN or past-2^31 one after 1 ms. */
function deadlinesOf(options: VxCacheOptions): { timeoutMs: number; uploadTimeoutMs: number } {
  const out = {
    timeoutMs: options.timeoutMs ?? 30_000,
    uploadTimeoutMs: options.uploadTimeoutMs ?? 60_000,
  }
  for (const [key, ms] of Object.entries(out))
    if (!(ms >= 1 && ms <= 2 ** 31 - 1))
      throw new Error(`vxCache(): ${key} must be a number of ms from 1 to 2147483647, got ${ms}`)
  return out
}

/**
 * https, or http to this machine: every request carries the CI token, and
 * http:// to another host sent it in clear.
 */
function secure(url: string): boolean {
  if (/^https:\/\/\S/.test(url)) return true
  if (!/^http:\/\/\S/.test(url)) return false
  const host = URL.parse(url)?.hostname
  return host === '127.0.0.1' || host === '[::1]' || host === 'localhost'
}

/** Options over `VX_CACHE_URL`; `undefined`: no server named. */
export function resolveVxCacheConfig(
  options: VxCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
): ResolvedVxCacheConfig | undefined {
  const named = namedOf(options)
  const deadlines = deadlinesOf(options)
  const url = (options.url ?? env.VX_CACHE_URL)?.replace(/\/+$/, '')
  if (url === undefined || url === '') return undefined
  if (!secure(url))
    throw new Error(
      `vxCache(): url must be https (http only to 127.0.0.1, ::1 or localhost), got ${url}`,
    )
  // Each route is the url's /v1/…: one that names /v1 asked /v1/v1/…, and every answer was a 404.
  if (url.endsWith('/v1'))
    throw new Error(`vxCache(): url is the server's base, without /v1: ${url.slice(0, -3)}`)
  return {
    url,
    ...named,
    ...deadlines,
    headers: proxyHeaders('vxCache()', options.headers),
  }
}

export interface ResolvedVxCacheConfig extends Required<Omit<VxCacheOptions, 'headers'>> {
  readonly headers: Readonly<Record<string, string>>
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
 * plugins: [
 *   vxCache({
 *     url: 'https://cache.example.com',
 *     issuer: 'https://token.actions.githubusercontent.com',
 *     repository: 'acme/app',
 *   }),
 * ]
 * ```
 */
export function vxCache(options: VxCacheOptions): VxPlugin {
  refuseUnknownOptions('vxCache()', options, KEYS)
  namedOf(options)
  deadlinesOf(options)
  return definePlugin(import.meta, {
    cache(ctx): RemoteCacheLayer | undefined {
      const config = resolveVxCacheConfig(options)
      if (config === undefined) return undefined
      const lent = ctx.lent?.() !== undefined
      // A GitLab job with no `id_tokens` entry read only, unsaid (2026-10-26).
      if (
        !hasCiToken(Bun.env, lent) &&
        (Bun.env.GITHUB_ACTIONS === 'true' || Bun.env.GITLAB_CI === 'true')
      )
        ctx.warn(
          Bun.env.GITHUB_ACTIONS === 'true'
            ? '[vx] vx-cache: this job gets no OIDC token (give it `permissions: id-token: write`): it reads only'
            : '[vx] vx-cache: no CI token for the cache server (name an id_tokens entry VX_CACHE_TOKEN): it reads only',
        )
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
