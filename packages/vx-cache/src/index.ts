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
  /** Per-request deadline for reads and queries (default 30 s); a download's bounds its answer, then its bytes must arrive at 1 MiB a second over each. */
  timeoutMs?: number
  /** … and for an upload (default 60 s): its bytes must leave at 1 MiB a second over each, then its answer come within one. */
  uploadTimeoutMs?: number
  /**
   * Headers every request to the server carries, for a proxy in front of
   * it (`{ 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID }`, an
   * Access service token, 2026-10-25). An unset value is left out;
   * `authorization`, `content-type`, `content-length` and the `vx-*` names
   * the request sets are refused.
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
/** A connection that dropped, not a server that answered: an upload is sent again. */
const RESET = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED'])

/**
 * The names a request sets itself: one of them in `headers`, in another
 * case, was joined to the request's own value, and the server refused it.
 */
const WIRE_HEADERS = new Set([
  'authorization',
  'content-type',
  'content-length',
  'vx-issuer',
  'vx-repository',
  'vx-scope',
])

/** `headers` with unset values left out; a name or value no header can carry, or one the wire sets, refused. */
function proxyHeaders(
  factory: string,
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || WIRE_HEADERS.has(name.toLowerCase()))
      throw new UserError(`${factory} option "headers" cannot set "${name}"`)
    if (typeof value !== 'string' || /[\r\n\0]/.test(value))
      throw new UserError(
        `${factory} option "headers.${name}" must be one line of text (its value is not printed)`,
      )
    out[name] = value
  }
  return out
}

/** An issuer or a repository on the wire: its SHA-256's first 128 bits in hex, never the value (2026-10-25). */
const hashOf = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 32)

/** A ref's scope on the wire: the ref, percent-encoded, its folder's name on the server (2026-11-03). */
const scopeOf = (ref: string): string => encodeURIComponent(ref)

/** The longest scope a server takes (PROTOCOL.md § Keys), so a folder's name fits a bucket's key. */
const SCOPE_MAX = 512

/**
 * A body's first `max` bytes as text, the rest cancelled unread, and
 * whether there was more: an answer is read no further than vx needs, so
 * a server's endless one cannot fill this machine's memory.
 */
async function upTo(res: Response, max: number): Promise<{ text: string; over: boolean }> {
  const reader = res.body?.getReader()
  if (reader === undefined) return { text: '', over: false }
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    n += value.byteLength
    if (n > max) {
      // quiet: the answer is refused for its size; its cancel adds nothing
      await reader.cancel().catch(() => {})
      return { text: Buffer.concat(parts).subarray(0, max).toString('utf8'), over: true }
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), over: false }
}

/** A JSON answer of at most `max` bytes; past it, a refusal that says so. */
async function jsonUpTo(res: Response, max: number, what: string): Promise<unknown> {
  const { text, over } = await upTo(res, max)
  if (over) throw new Error(`${what} answered over ${max} bytes`)
  return JSON.parse(text)
}

/** A CI token's answer is a few hundred bytes: room to spare. */
const SMALL_ANSWER_BYTES = 64 * 1024
/**
 * A check's answer per hash asked: a hash (up to 128), a size and a scope
 * (up to 512, a long branch's) in JSON are under 700 bytes. At 512 an
 * answer under the longest scopes was refused as too long.
 */
const CHECK_BYTES_PER_HASH = 1024

/**
 * `s` with each C0/C1 control and DEL written as `\xNN`: a server's words
 * reach the terminal, and an `ESC ]` or `\r` in them retitled it or
 * overwrote the line before (core's `printable`, L-31).
 */
const printable = (s: string): string =>
  // oxlint-disable-next-line no-control-regex
  s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)

/** Shorter values are not hidden, as core masks none under 6 characters: each would blank common words. */
const MIN_TOKEN_CHARS = 6

/** `text` with each of `tokens` written `***`. */
function hideTokens(text: string, tokens: Iterable<string>): string {
  let out = text
  for (const token of tokens)
    if (token.length >= MIN_TOKEN_CHARS) out = out.replaceAll(token, '***')
  return out
}

/**
 * A refusal, named by its status and the server's own `message`, each
 * token `hide` knows written `***` before the cut, so none is left in part.
 */
async function refusal(res: Response, hide: (text: string) => string): Promise<Error> {
  let said = ''
  try {
    const { text } = await upTo(res, 2048)
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
  said = printable(hide(said).replace(/\s+/g, ' ').trim().slice(0, 200))
  return new Error(`HTTP ${res.status}${said === '' ? '' : `: ${said}`}`)
}

/** A 200's JSON; one that is none (a website's page) names the likely fault, the url. */
async function jsonOf(res: Response, path: string, max: number): Promise<unknown> {
  const { text, over } = await upTo(res, max)
  if (over) throw new Error(`${path} answered over ${max} bytes`)
  try {
    return JSON.parse(text)
  } catch {
    const type = res.headers.get('content-type') ?? 'no content type'
    throw new Error(
      `${path} answered ${res.status} with ${type}, not JSON: is the url a vx-cache server?`,
    )
  }
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

/** A transfer's least pace: at 1 MiB a second, a 60 MB artifact is in within a minute. */
const FLOOR_BYTES_PER_S = 1024 * 1024

/** An upload's body is handed to the fetch in slices this long, so its pace can be read. */
const SLICE_BYTES = 64 * 1024

/**
 * At least `FLOOR_BYTES_PER_S` over each `ms`, or `controller` aborts
 * naming the pace. A whole-body deadline failed a big artifact still
 * arriving at a steady pace (a 30 s cut, CI 2026-10-25); a gap-only one
 * let a trickle hold a run 19 minutes (a byte now and then reset it, CI
 * 2026-10-28).
 */
function pace(
  controller: AbortController,
  ms: number,
): { moved(bytes: number): void; stop(): void } {
  const floor = (FLOOR_BYTES_PER_S * ms) / 1000
  let got = 0
  const window = setInterval(() => {
    if (got < floor)
      controller.abort(
        new Error(
          got === 0 ? `no bytes in ${ms} ms` : `${got} bytes in ${ms} ms, under 1 MiB a second`,
        ),
      )
    got = 0
  }, ms)
  window.unref()
  const stop = () => clearInterval(window)
  controller.signal.addEventListener('abort', stop, { once: true })
  return {
    moved: (bytes) => {
      got += bytes
    },
    stop,
  }
}

/**
 * A download's deadline: `ms` for the answer, then `pace` over its body.
 * Core judges whether running the task beats the rest of the wait.
 */
function streamed(res: Response, controller: AbortController, ms: number): Response {
  if (res.body === null) return res
  const window = pace(controller, ms)
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        window.moved(chunk.byteLength)
        out.enqueue(chunk)
      },
      flush: window.stop,
    }),
  )
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/**
 * An upload's body, held to `pace` while the fetch takes it, then `ms`
 * for the answer (`sent`). A deadline over the whole upload failed every
 * artifact slower than its size over it: 100 MB under 1.7 MB a second at
 * the default 60 s. The pace is what the fetch takes, so the bytes the
 * socket buffers ahead of the wire (MBs) count early once; a stalled
 * link still ends at the first window they do not fill.
 */
function paced(
  blob: Blob,
  controller: AbortController,
  ms: number,
  sent: () => void,
): { body: ReadableStream<Uint8Array>; stop(): void } {
  const window = pace(controller, ms)
  let at = 0
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(out) {
        if (at >= blob.size) {
          window.stop()
          out.close()
          sent()
          return
        }
        const slice = await blob.slice(at, at + SLICE_BYTES).bytes()
        at += slice.byteLength
        window.moved(slice.byteLength)
        out.enqueue(slice)
      },
      cancel: window.stop,
    },
    { highWaterMark: 0 },
  )
  return { body, stop: window.stop }
}

/** The limits a server names on each `/v1/artifacts` answer (`vx-max-*`). */
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

const chunks = <T>(all: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(all.length / size) }, (_, i) =>
    all.slice(i * size, (i + 1) * size),
  )

/** The limits an answer's `vx-max-*` headers name, or undefined when one is missing or bad. */
function limitsNamed(res: Response): Limits | undefined {
  const read = (k: keyof Limits) => count(Number(res.headers.get(LIMIT_HEADERS[k]) ?? NaN))
  const maxCheckHashes = read('maxCheckHashes')
  const maxUploadBytes = read('maxUploadBytes')
  return maxCheckHashes === undefined || maxUploadBytes === undefined
    ? undefined
    : { maxCheckHashes, maxUploadBytes }
}

/**
 * The seam over vx-cache v1. `has` and `hasMany` are `check`, `get` a
 * download and `put` an upload by `PUT`. A check names the
 * scope of each ref the run reads, in order, and the first holding a hash
 * answers it; a download names the scope its check found. A refused token (401/403) throws
 * once, for core to report, and turns the layer off for the run; an
 * upload's 403 turns off writes alone (a job that reads only).
 */
export class VxCacheLayer implements RemoteCacheLayer {
  readonly endpoint: string
  private disabled = false
  /** Core's `off`: the failure that turned the layer off is the run's, on no task. */
  get off(): boolean {
    return this.disabled
  }
  private writesRefused = false
  /** The refs a read names, in order: the first holding a hash answers it. */
  refs: readonly string[] = []
  private scoped: { refs: readonly string[]; scopes: readonly string[] } | undefined
  /** `refs` as the wire names them (`scopeOf`), encoded once. */
  private get scopes(): readonly string[] {
    if (this.scoped?.refs !== this.refs)
      this.scoped = { refs: this.refs, scopes: this.refs.map(scopeOf) }
    return this.scoped.scopes
  }
  /** The ref a check found each hash under, which its download names. */
  private readonly found = new Map<string, string>()
  /**
   * The limits the server's last answer named; none before its first.
   * Nothing is guessed, nor asked apart: a check before any answer goes
   * whole, and one refused for its size is sent again in the chunks its
   * refusal names (`/v1/capabilities` cost every run a request, one
   * round-trip before its first check, 2026-11-06).
   */
  private limits: Limits | undefined
  /** Where the layer says what is no failure of a request: core's `ctx.warn`. */
  warn: (message: string) => void = () => {}

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
      'vx-issuer': hashOf(config.issuer),
      'vx-repository': hashOf(config.repository),
    }
  }

  private idToken: { jwt: string; exp: number } | undefined
  /**
   * Every token this layer sent: a server that quoted a request's
   * Authorization header in its refusal printed it to the CI log and
   * cache.db, as core masks only secret-named variables.
   */
  private readonly sent = new Set<string>()
  private readonly hidden = (text: string): string => hideTokens(text, this.sent)

  /** `work`, each error it throws with every token sent hidden: the one way an error leaves the layer. */
  private async guard<T>(work: Promise<T>): Promise<T> {
    try {
      return await work
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const hidden = this.hidden(message)
      if (hidden === message) throw err
      const code = (err as { code?: unknown } | null)?.code
      throw Object.assign(new Error(hidden), code === undefined ? {} : { code })
    }
  }
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
    this.sent.add(this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN!)
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
      if (!res.ok) throw await refusal(res, this.hidden)
      jwt = ((await jsonUpTo(res, SMALL_ANSWER_BYTES, 'it')) as { value?: unknown } | null)?.value
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
   * to this job is never lent on, nor one once the remote is off: core
   * lends while its policy reads, and a refused token lent was refused on
   * every worker.
   */
  lend(): Promise<LentAccess | undefined> {
    return this.guard(this.lending())
  }

  private async lending(): Promise<LentAccess | undefined> {
    if (this.disabled || this.lent?.() !== undefined) return undefined
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
      /** A body read at its own pace: the deadline then bounds its pace (`streamed`). */
      streamed?: boolean
      /** A body sent at its own pace: the deadline bounds its pace, then the answer (`paced`). */
      paced?: boolean
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
    if (bearer !== '') this.sent.add(bearer)
    const ms = init.timeoutMs ?? this.config.timeoutMs
    const controller = new AbortController()
    let answer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (answer !== undefined) return
      answer = setTimeout(() => controller.abort(new Error(`no answer within ${ms} ms`)), ms)
      answer.unref()
    }
    const sending =
      init.paced === true && init.body instanceof Blob
        ? paced(init.body, controller, ms, arm)
        : undefined
    if (sending === undefined) arm()
    const url = `${this.config.url}${path}`
    const noAnswer = (err: unknown) => {
      // A read the server never answered: the next would wait the same
      // deadline, so the remote is off for the run (a server that takes the
      // connection and never answers cost each of 300 tasks 30 s). An
      // upload's deadline bounds its pace, no sign of a dead server.
      if (init.write === true || !controller.signal.aborted || controller.signal.reason !== err)
        throw err
      const first = !this.disabled
      this.disabled = true
      if (!first) return undefined
      throw new Error(`${(err as Error).message}; remote cache off for this run`, { cause: err })
    }
    let res = await this.fetchImpl(url, {
      method: init.method ?? 'POST',
      headers: {
        ...this.config.headers,
        ...this.named,
        ...(bearer === '' ? {} : { authorization: `Bearer ${bearer}` }),
        ...init.headers,
        // A stream names no length, and the server refuses an upload without one.
        ...(sending === undefined ? {} : { 'content-length': String((init.body as Blob).size) }),
      },
      ...(init.body === undefined ? {} : { body: sending?.body ?? init.body }),
      signal: controller.signal,
      redirect: 'manual',
    }).catch(noAnswer)
    if (res === undefined) return undefined
    // An answer before the last byte (one the scope holds): its body is bounded as any answer's.
    sending?.stop()
    arm()
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(answer)
      throw await redirected(res, url)
    }
    // Any answer's, a refusal's too: one refused for its size by a server
    // whose limits fell mid-run names them for the next check and upload.
    this.limits = limitsNamed(res) ?? this.limits
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
        `${(await refusal(res, this.hidden)).message}: the write was refused (this job reads only); writes off for this run, reads go on`,
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
        `${(await refusal(res, this.hidden)).message}: ${bearer === '' ? 'a read with no token was refused' : `the token was refused (this workspace names ${this.config.repository} at ${this.config.issuer})`}; remote cache off for this run`,
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

  /** A token refusal met by `open`'s ask, which no call could throw: the next check or download does. */
  private unsaid: Error | undefined
  /** A `replace` refused was said: it is said once a run. */
  private saidNoReplace = false

  /** Throws the refusal `open`'s ask met, once. */
  private sayUnsaid(): void {
    const err = this.unsaid
    this.unsaid = undefined
    if (err !== undefined) throw err
  }

  /**
   * Core's `open`: called only when the run's policy reads or writes this
   * remote, so a `--no-cache` run or a plan asks GitHub nothing. Starts
   * asking for the job's token, so the first check need not wait on
   * GitHub; the server is asked nothing until a check, a download or an
   * upload, so a run the local cache answers sends it none.
   */
  async open(): Promise<void> {
    this.bearer().catch((err: unknown) => {
      // Said by the first call; the requests that shared the ask say nothing.
      if (this.tokenFailed) return
      this.tokenFailed = true
      this.unsaid = err instanceof Error ? err : new Error(String(err))
    })
  }

  async has(hash: string): Promise<ArtifactInfo | null> {
    return (await this.hasMany([hash]))?.get(hash) ?? null
  }

  /**
   * One check of the run's refs' scopes, in order: each hash answers the
   * first that holds it. Null once the layer is off: no answer, which core
   * keeps apart from "none held" (an empty map rewrote every key it asked
   * as a miss in `remote_hits`, and the next run fetched none of them).
   */
  hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> {
    return this.guard(this.lookup(hashes))
  }

  private async lookup(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> {
    const held = new Map<string, ArtifactInfo>()
    this.sayUnsaid()
    if (this.disabled || this.refs.length === 0) return null
    const scopes = this.scopes
    const ask = [...new Set(hashes)]
    const checks = (max: number, again: boolean) => {
      // More refs than one check takes: each hash's scopes span several
      // checks, the first in order holding it answering (a check of every
      // scope at once was refused, every time).
      const span = Math.min(scopes.length, max)
      const per = Math.max(1, Math.floor(max / span))
      const spans = chunks(scopes, span)
      return chunks(ask, per).flatMap((some) => spans.map((s) => this.check(s, some, again)))
    }
    // None named yet: one check of every lookup.
    const first = await Promise.allSettled(
      checks(this.limits?.maxCheckHashes ?? Math.max(1, ask.length * scopes.length), true),
    )
    const refused = first.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []))
    const failed = refused.find((err) => !(err instanceof TooMany))
    if (failed !== undefined) throw failed
    const parts =
      refused.length === 0
        ? first.map(
            (r) =>
              (r as PromiseFulfilledResult<Map<string, { size: number; scope: string }>>).value,
          )
        : await settledAll(checks(Math.min(...refused.map((err) => (err as TooMany).max)), false))
    // A token refused to `open`'s ask, which a check here shared.
    this.sayUnsaid()
    if (this.disabled) return null
    for (const part of parts)
      for (const [hash, { size, scope }] of part) {
        if (held.has(hash)) continue
        held.set(hash, { size })
        this.found.set(hash, scope)
      }
    return held
  }

  /**
   * `POST /v1/artifacts` (Turbo's batch query): the size and scope of each
   * hash held. One refused for its size, its refusal naming a smaller
   * `maxCheckHashes`, throws `TooMany` when `again`: the caller sends it
   * in chunks.
   */
  private async check(
    scopes: readonly string[],
    hashes: readonly string[],
    again: boolean,
  ): Promise<Map<string, { size: number; scope: string }>> {
    const res = await this.json('/v1/artifacts', { hashes, scopes })
    if (res === undefined) return new Map()
    if (res.status !== 200) {
      const max = limitsNamed(res)?.maxCheckHashes
      if (again && max !== undefined && hashes.length * scopes.length > max) {
        await res.body?.cancel()
        throw new TooMany(max)
      }
      throw await refusal(res, this.hidden)
    }
    const body = (await jsonOf(
      res,
      '/v1/artifacts',
      SMALL_ANSWER_BYTES + hashes.length * CHECK_BYTES_PER_HASH,
    )) as Record<string, unknown> | null
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

  /**
   * The scope a check found it under, else every ref's in order in one
   * request, the first holding it answering: one by one, a branch's run
   * paid a round-trip and a 404 for its own scope before each download of
   * main's (2026-11-06). More refs than the server's `maxCheckHashes` go
   * in several, in order.
   */
  get(hash: string): Promise<{ body: Response; durationMs: undefined } | null | undefined> {
    return this.guard(this.download(hash))
  }

  private async download(
    hash: string,
  ): Promise<{ body: Response; durationMs: undefined } | null | undefined> {
    this.sayUnsaid()
    const at = this.found.get(hash)
    const scopes = at === undefined ? this.scopes : [at]
    for (let next = 0; next < scopes.length;) {
      // Off, or refused: no answer, which core keeps apart from a miss (a
      // null forgot each hit the index kept, the remote never asked).
      if (this.disabled) return undefined
      const some = scopes.slice(next, next + (this.limits?.maxCheckHashes ?? scopes.length))
      const res = await this.request(`/v1/artifacts/${hash}`, {
        method: 'GET',
        headers: { 'vx-scope': some.join(', ') },
        streamed: true,
      })
      if (res === undefined) return undefined
      if (res.status === 404) {
        await res.body?.cancel()
        next += some.length
        continue
      }
      if (res.status !== 200) {
        // Refused for its scopes: sent again in as many as the refusal names.
        const max = limitsNamed(res)?.maxCheckHashes
        if (max !== undefined && some.length > max) {
          await res.body?.cancel()
          continue
        }
        throw await refusal(res, this.hidden)
      }
      return { body: res, durationMs: undefined }
    }
    return null
  }

  /** An artifact over the server's upload limit is not sent: it is said. */
  put(
    hash: string,
    body: Blob,
    meta: { durationMs: number; replace?: true },
  ): Promise<void | false> {
    return this.guard(this.store(hash, body, meta))
  }

  private async store(
    hash: string,
    body: Blob,
    meta: { durationMs: number; replace?: true },
  ): Promise<void | false> {
    // With no token a job reads only: nothing is uploaded, and none counted.
    if (this.disabled || this.writesRefused || !hasCiToken(this.env, this.lent?.() !== undefined))
      return false
    // The server keeps the bytes a scope holds and answers 204 unread
    // (PROTOCOL.md): a PUT reported the corrupt copy fixed, so no run (nor
    // DTE peer) learned it was not, and each one downloaded it again.
    if (meta.replace === true) {
      if (!this.saidNoReplace)
        this.warn(
          `[vx] vx-cache: ${hash} did not read back, and a vx-cache server never replaces an artifact it holds: not uploaded; the remote misses it until the bucket's lifecycle rule expires it`,
        )
      this.saidNoReplace = true
      return false
    }
    if (this.overLimit(hash, body)) return false
    return this.upload({ hash, body })
  }

  /** Says an artifact over the upload limit the server last named, which is not sent. */
  private overLimit(hash: string, body: Blob): boolean {
    const max = this.limits?.maxUploadBytes
    if (max === undefined || body.size <= max) return false
    this.warn(
      `[vx] vx-cache: ${hash} is ${body.size} bytes, over the server's upload limit of ${max}: not uploaded`,
    )
    return true
  }

  /**
   * One artifact by `PUT`, its bytes reaching the bucket untouched
   * (2026-10-25: no batch upload; a batch passes through the server's code,
   * which on Workers costs CPU by the byte, and a 40 MB one ran out of it).
   * The server answers one its scope holds before reading the bytes. As
   * many at once as core sends (`cache.concurrency.upload`): a cap of four
   * here held a 1,500-task cold run 11 s past its last task on a remote
   * 40 ms away, the setting unheard.
   */
  private async upload(item: { hash: string; body: Blob }): Promise<void | false> {
    // Queued before the remote or its writes were turned off.
    if (this.disabled || this.writesRefused) return false
    // Sent again after a 5xx, a 429 or a reset connection, up to three tries,
    // as the token's ask: the server failing to read GitHub's keys once, and
    // one ECONNRESET, each lost a DTE worker's entry (2026-10-29). A PUT
    // names its hash, so a second one stores the same bytes. A deadline is
    // not retried: the upload already had its time.
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined
      try {
        res = await this.request(`/v1/artifacts/${item.hash}`, {
          method: 'PUT',
          body: item.body,
          headers: { 'content-type': 'application/octet-stream' },
          timeoutMs: this.config.uploadTimeoutMs,
          write: true,
          paced: true,
        })
      } catch (err) {
        if (!RESET.has((err as { code?: unknown }).code as string) || attempt === ASK_ATTEMPTS)
          throw err
        await this.wait(1000 * attempt)
        continue
      }
      if (res === undefined) return false
      if (res.ok) return
      // Sent before any answer named the limits: the 413 names them
      // (PROTOCOL.md), so it is said as a later one is, never a failure.
      if (res.status === 413 && this.overLimit(item.hash, item.body)) {
        await res.body?.cancel()
        return false
      }
      if ((res.status !== 429 && res.status < 500) || attempt === ASK_ATTEMPTS)
        throw await refusal(res, this.hidden)
      await res.body?.cancel()
      await this.wait(1000 * attempt)
    }
  }
}

/**
 * `Promise.all` that ends only once every check has: a refused chunk
 * rejected the lookup while its siblings were still in flight, so their
 * requests outlived the call that sent them.
 */
async function settledAll<T>(ps: readonly Promise<T>[]): Promise<T[]> {
  const done = await Promise.allSettled(ps)
  const failed = done.find((r) => r.status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return done.map((r) => (r as PromiseFulfilledResult<T>).value)
}

/** A check refused for its size: sent again in checks of `max` lookups. */
class TooMany extends Error {
  constructor(readonly max: number) {
    super(`a check is at most ${max} lookups`)
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

/** The longest delay a timer holds. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** `url` as a refusal may print it: a `user:pass@` would reach the CI log. */
function shown(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1***@')
}

/**
 * https, or http to this machine: every request carries the CI token, and
 * http:// to another host sent it in clear.
 */
function secure(url: string): boolean {
  // Parsed as the request will be: a scheme in any case, no url it cannot carry.
  const u = URL.parse(url)
  if (u === null || u.host === '') return false
  if (u.protocol === 'https:') return true
  if (u.protocol !== 'http:') return false
  return u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost'
}

/** Options over `VX_CACHE_URL`; `undefined`: no server named. */
export function resolveVxCacheConfig(
  options: VxCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
): ResolvedVxCacheConfig | undefined {
  const named = namedOf(options)
  const url = (options.url ?? env.VX_CACHE_URL)?.replace(/\/+$/, '')
  if (url === undefined || url === '') return undefined
  // Named as the workspace set it: a bad VX_CACHE_URL was refused as `url`.
  const from = options.url === undefined ? 'VX_CACHE_URL' : 'url'
  if (!secure(url))
    throw new UserError(
      `vxCache(): ${from} must be https (http only to 127.0.0.1, ::1 or localhost), got ${shown(url)}`,
    )
  // Each route is appended to the url: past a `?` or `#` it was query or
  // fragment, and every request asked the server's root.
  if (/[?#]/.test(url))
    throw new UserError(
      `vxCache(): ${from} takes no ?query or #fragment: each route is appended to it, got ${shown(url)}`,
    )
  // Each route is the url's /v1/…: one that names /v1 asked /v1/v1/…, and every answer was a 404.
  if (url.endsWith('/v1'))
    throw new UserError(
      `vxCache(): ${from} is the server's base, without /v1: ${shown(url.slice(0, -3))}`,
    )
  return {
    url,
    ...named,
    timeoutMs: options.timeoutMs ?? 30_000,
    uploadTimeoutMs: options.uploadTimeoutMs ?? 60_000,
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
  // A NaN, zero or negative deadline aborted every request as it began,
  // and so did one over 2³¹−1: Bun runs a timer it cannot hold after 1 ms.
  for (const name of ['timeoutMs', 'uploadTimeoutMs'] as const) {
    const ms = options[name]
    if (ms !== undefined && !(ms > 0 && ms <= MAX_TIMER_MS))
      throw new UserError(
        `vxCache() option "${name}" must be a positive number of ms up to ${MAX_TIMER_MS}, got ${ms}`,
      )
  }
  proxyHeaders('vxCache()', options.headers)
  namedOf(options)
  // At the call, as vxHistory() checks its url: in the hook alone, a verb
  // that opens no cache (`vx show`) took a url every run then failed on.
  if (options.url !== undefined) resolveVxCacheConfig(options, {})
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
      // A scope the server cannot name was a 400 on every check, and the
      // run read nothing, its base branch's artifacts too.
      const refs = [...new Set(ctx.refs)].filter((ref) => {
        const length = scopeOf(ref).length
        if (length <= SCOPE_MAX) return true
        ctx.warn(
          `[vx] vx-cache: ${ref} is ${length} characters percent-encoded, over the ${SCOPE_MAX} a cache folder's name takes: the run does not read it`,
        )
        return false
      })
      if (refs.length === 0) {
        ctx.warn(
          '[vx] vx-cache: the run reads no ref, so it names no key; remote cache off for this run',
        )
        return undefined
      }
      const layer = new VxCacheLayer(config)
      layer.refs = refs
      layer.lent = ctx.lent
      layer.warn = ctx.warn
      return layer
    },
  })
}
