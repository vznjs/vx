// The HTTP both remote wires, turboCache() and nxCache(), share: the URL and
// token checks, a request's deadline, a refusal's words, Turbo's retry and
// rate-limit rule, and Turbo's outage breaker.

import { isSecretUnavailable, type RemoteOpenContext, UserError } from '@vzn/vx'

/**
 * A remote cache's URL, refused as `from` names it (an option, a variable,
 * a config file). Refused at the call for
 * the option and when the cache opens for every source.
 *
 * Plain http:// to any host is taken, where vxCache() takes it only to
 * loopback: Turbo and Nx both send their token over it, and their
 * self-hosted servers document such URLs (`TURBO_API=http://cache:3000`
 * beside a CI service container; nx-cache-server's
 * `NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://your-server:3000`). These
 * plugins run such a repo unchanged.
 */
export function checkRemoteUrl(url: string, from: string): void {
  // With no scheme every request failed on its own, as a bare "Invalid URL".
  if (!/^https?:\/\//.test(url))
    throw new UserError(`${from} must be an http(s) URL, got ${JSON.stringify(url)}`)
  // The URL is printed in every refusal line, so a `user:pass@` in it would
  // leak to the log. Credentials go in the token.
  if (URL.canParse(url)) {
    const u = new URL(url)
    if (u.username !== '' || u.password !== '')
      throw new UserError(
        `${from} carries credentials (user:pass@); pass them as the token instead`,
      )
  }
}

/**
 * Why a string cannot be an HTTP header value, or null when it can. Bun's
 * `fetch` refuses a value holding a line break or NUL, or a character past
 * Latin-1, once it has trimmed the ends (measured on 1.4.2), and its error
 * QUOTES the whole value: a token with an interior newline (a two-line secret
 * file) reached every degrade warning as `'Bearer <token>'`. A caller refuses
 * with this reason and never with the value.
 */
export function headerValueFault(value: string): string | null {
  let past = false
  for (const ch of value.trim()) {
    const c = ch.codePointAt(0)!
    if (c === 0x0a || c === 0x0d || c === 0) return 'a line break or NUL'
    if (c > 0xff) past = true
  }
  return past ? 'a character past Latin-1' : null
}

/** One remote's keychain entry: `key` names it, `label` and `env` are what a person reads. */
export interface KeychainRemote {
  readonly key: string
  readonly label: string
  /** The variable that sets the token instead, named in the warning. */
  readonly env: string
}

/**
 * The token from the plugin's OS keychain, asked for on a terminal when
 * missing (core's `ctx.secret`): the last source, after the option, the
 * variable and the config files. A throw is the one warning that leaves the
 * run on the local cache.
 */
export async function keychainToken(
  ctx: RemoteOpenContext,
  remote: KeychainRemote,
): Promise<string> {
  let token: string
  try {
    token = await ctx.secret({
      key: remote.key,
      prompt: `Token for ${remote.label}, saved to the OS keychain: `,
    })
  } catch (err) {
    if (!isSecretUnavailable(err)) throw err
    throw new Error(
      `no token for ${remote.label}: set ${remote.env}, run vx in a terminal to be asked for one (kept in the OS keychain), or pass --cache-policy=remote: to skip the remote; local cache only this run`,
    )
  }
  const fault = headerValueFault(token)
  if (fault !== null) {
    await ctx.forgetSecret({ key: remote.key })
    throw new Error(
      `the OS keychain's token for ${remote.label} holds ${fault}, which no HTTP header can carry (it is not printed); removed it, so the next run asks again`,
    )
  }
  return token.trim()
}

/** How a remote reads in a prompt or a warning: its host, then its team. */
export function remoteLabel(url: string, team: string | undefined): string {
  const host = URL.canParse(url) ? new URL(url).host : url
  return team === undefined ? host : `${host} (${team})`
}

/**
 * A request's deadline, named. The runtime's abort says "The operation
 * timed out." and nothing else; core's degrade line already names the
 * request, the artifact and the server, so the cause names the deadline
 * that was spent. The name rides the signal's reason, not a catch around
 * `fetch`: the deadline covers the body too, and a body read past it
 * (core's ingest, the signed download's temp) rejects with the reason
 * (measured on Bun 1.4.2), where a catch around `fetch` never saw it.
 * Unref'd, as `AbortSignal.timeout`'s timer is.
 */
export function deadline(timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  // A timer past 2^31-1 ms fires after 1 ms: a 30-day
  // TURBO_REMOTE_CACHE_TIMEOUT aborted every request as it started. Turbo
  // defines that value, so it is held here; an option is refused at the call.
  setTimeout(
    () => controller.abort(new Error(`no answer within ${timeoutMs} ms`)),
    Math.min(timeoutMs, MAX_TIMER_MS),
  ).unref()
  return controller.signal
}

/** The longest delay a timer holds. */
export const MAX_TIMER_MS = 2 ** 31 - 1

/** How long the body's first chunk is waited for: a refusal is not held on a body that never comes. */
const BODY_WAIT_MS = 1_000

/**
 * The most of the first chunk read: a token that starts within the line's
 * 200 characters must end within it to be hidden whole (a JWT is ~1 KB).
 */
const READ_BYTES = 4096

/** Shorter values are not hidden, as core masks none under 6 characters: each would blank common words. */
const MIN_TOKEN_CHARS = 6

/**
 * `text` with each of `tokens` written `***`: a server that quoted a
 * request's Authorization header printed the token to the CI log and
 * cache.db, as core masks only secret-named variables.
 */
export function hideTokens(text: string, tokens: Iterable<string | undefined>): string {
  let out = text
  for (const token of tokens)
    if (token !== undefined && token.length >= MIN_TOKEN_CHARS) out = out.replaceAll(token, '***')
  return out
}

/** `work`, each error it throws with `hide` applied: a thrown fetch error can quote a request's header. */
export async function hidingErrors<T>(
  work: Promise<T>,
  hide: (text: string) => string,
): Promise<T> {
  try {
    return await work
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const hidden = hide(message)
    if (hidden === message) throw err
    // The code is how core groups a failure (a reset connection), and a retry reads it.
    const code = (err as { code?: unknown } | null)?.code
    throw Object.assign(new Error(hidden), code === undefined ? {} : { code })
  }
}

/**
 * A remote's refusal, named by its status and its own words: "HTTP 500" alone
 * said nothing, and a batch query Vercel refused with 400 "Too many hashes.
 * Limit is 100." read as no answer and was never seen. One line of the body,
 * bounded: it is remote text, each token `hide` knows written `***` before the
 * cut, so none is left in part.
 */
export async function refusal(
  res: Response,
  hide: (text: string) => string,
  what = '',
): Promise<Error> {
  let said = ''
  try {
    const reader = res.body?.getReader()
    if (reader !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const first = await Promise.race([
        reader.read(),
        new Promise<undefined>((r) => {
          timer = setTimeout(() => r(undefined), BODY_WAIT_MS)
        }),
      ]).finally(() => clearTimeout(timer))
      // quiet: read no further; a cancel that fails has nothing left to free
      void reader.cancel().catch(() => undefined)
      said = hide(new TextDecoder().decode(first?.value?.subarray(0, READ_BYTES)))
        .replace(/\s+/g, ' ')
        .trim()
    }
  } catch {
    // quiet: the status alone still names the refusal
  }
  // Each control as `\xNN`: an `ESC ]` in the server's words retitled the
  // terminal.
  const line = said
    .slice(0, 200)
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  return new Error(`${what}HTTP ${res.status}${line === '' ? '' : `: ${line}`}`)
}

/**
 * When a remote's rate limit ends, shared by every request to that remote:
 * Turbo's `RateLimit` (`turborepo-api-client/src/retry.rs`; tests
 * `waits_for_known_cooldown_before_initial_send`,
 * `scopes_artifact_cooldowns_to_client_team_and_token`). A request that
 * starts inside it waits it out before its first send instead of spending
 * a try on a 429. One per wire instance: a client, its server and token.
 */
export class Cooldown {
  until = 0
  constructor(private readonly now: () => number = Date.now) {}

  /** Ms left of the limit, 0 when there is none. */
  left(): number {
    return Math.max(0, this.until - this.now())
  }

  extend(ms: number): void {
    this.until = Math.max(this.until, this.now() + ms)
  }
}

/**
 * One request with Turbo's retry rule (`turborepo-api-client/src/retry.rs`): a
 * 5xx other than 501, or a request that never connected, is sent again after 2
 * s, `retries` times. A 429 opens the remote's `cooldown` for its `Retry-After`
 * (capped at 10 s a wait, 2 s without one or for a `0` after the first), and
 * the request is resent once it ends, as often as fits in 20 s from its first
 * 429: a limit longer than one capped wait lost every hit before (Growth's
 * parity run). A spent deadline is not retried, unlike Turbo's reads: it has
 * already cost its wait, and a hung server would cost it twice. Every request
 * both wires make is idempotent (content-addressed, and Nx's second write is a
 * 409 the caller takes as done), so a resend applies nothing twice.
 */
export async function withRetry(
  send: () => Promise<Response>,
  retries: number,
  wait: (ms: number) => Promise<void> = Bun.sleep,
  cooldown: Cooldown = new Cooldown(),
  now: () => number = Date.now,
): Promise<Response> {
  let firstLimit: number | undefined
  for (let attempt = 0; ;) {
    const held = cooldown.left()
    if (held > 0) await wait(held)
    let res: Response
    try {
      res = await send()
    } catch (err) {
      if (attempt >= retries || !neverConnected(err)) throw err
      attempt++
      await wait(BACKOFF_MS)
      continue
    }
    if (res.status === 429) {
      // `Retry-After: 0` resends at once, but only once in a row: each
      // answered so sent again at once, hundreds a second for 20 s.
      const asked = retryAfterMs(res)
      const delay =
        asked === undefined || (asked === 0 && firstLimit !== undefined) ? BACKOFF_MS : asked
      firstLimit ??= now()
      if (retries === 0 || now() + delay - firstLimit > RATE_LIMIT_BUDGET_MS) return res
      cooldown.extend(delay)
      await res.body?.cancel()
      continue
    }
    if (attempt >= retries || !retryable(res.status)) return res
    attempt++
    await res.body?.cancel()
    await wait(BACKOFF_MS)
  }
}

const BACKOFF_MS = 2_000
const MAX_RETRY_AFTER_MS = 10_000
const RATE_LIMIT_BUDGET_MS = 20_000

function retryable(status: number): boolean {
  return status >= 500 && status !== 501
}

/** A refused port or an unresolved host, as Bun's `fetch` codes them (1.4.4 took errno names). */
function neverConnected(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND'
}

/** `Retry-After` as seconds or an HTTP date, capped as Turbo caps it. */
function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('retry-after')
  if (v === null) return undefined
  const ms = /^\d+$/.test(v.trim()) ? Number(v) * 1000 : Date.parse(v) - Date.now()
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined
}

/**
 * Turbo's outage breaker (`turborepo-cache/src/outage_breaker.rs`): three
 * outages in a row — no connection, no answer in time, or a 5xx once the
 * retries are spent — open it for 30 s, and while open no request is sent.
 * After the cooldown one request probes; its success closes the breaker,
 * its outage opens it again. Without it a server that hung cost every
 * task its full deadline. A result that lands after the breaker moved on
 * (a request already in flight when it opened) changes nothing.
 *
 * A hit's body (`settleOnBody`, a 200 with a body) is judged when the
 * body ends, not when its headers land: a server that sent headers in
 * time and then stalled the body was judged a success, reset the count,
 * and cost every task its full deadline. The body's error is the outage;
 * its end or a cancel is the success. A body nobody reads or cancels
 * leaves its verdict open.
 */
export class OutageBreaker {
  private failures = 0
  private openUntil: number | undefined
  private probing = false
  private generation = 0
  constructor(private readonly now: () => number = Date.now) {}

  async send(request: () => Promise<Response>, settleOnBody = false): Promise<Response> {
    let probe = false
    if (this.openUntil !== undefined) {
      if (this.now() < this.openUntil || this.probing)
        throw new Error(
          `unavailable after ${FAILURE_THRESHOLD} failures in a row; not asked again for ${COOLDOWN_MS / 1000} s`,
        )
      this.probing = probe = true
    }
    const generation = this.generation
    let res: Response
    try {
      res = await request()
    } catch (err) {
      this.finish(generation, probe, true)
      throw err
    }
    if (!settleOnBody || res.status !== 200 || res.body === null) {
      this.finish(generation, probe, res.status >= 500)
      return res
    }
    const reader = res.body.getReader()
    const settle = (outage: boolean) => this.finish(generation, probe, outage)
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read().catch((err: unknown) => {
            settle(true)
            controller.error(err)
          })
          if (chunk === undefined) return
          if (chunk.done) {
            settle(false)
            controller.close()
          } else controller.enqueue(chunk.value)
        },
        async cancel(reason) {
          settle(false)
          await reader.cancel(reason)
        },
      }),
      { status: res.status, statusText: res.statusText, headers: res.headers },
    )
  }

  private finish(generation: number, probe: boolean, outage: boolean): void {
    if (generation !== this.generation) return
    if (outage) {
      this.failures++
      if (probe || this.failures >= FAILURE_THRESHOLD) {
        this.openUntil = this.now() + COOLDOWN_MS
        this.probing = false
        this.generation++
      }
      return
    }
    this.failures = 0
    if (probe) {
      this.openUntil = undefined
      this.probing = false
      this.generation++
    }
  }
}

const FAILURE_THRESHOLD = 3
const COOLDOWN_MS = 30_000
