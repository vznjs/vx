// The client of a vx-history server (`@vzn/vx-history-server`, its
// PROTOCOL.md): each task's numbers asked once a run, and the run's own
// timings sent once at its end. A query names the issuer, repository and
// refs the workspace reads, plainly; a CI job's request carries its OIDC
// token, which writes its own ref, and with no token a run only reads (a
// server with `READ_ACCESS=public`). A refusal is never swallowed: it is said with the
// server's status and words.

import type { TaskOutcome } from '@vzn/vx'

/** One task's numbers, as the server folds and answers them. */
export interface ServerTiming {
  readonly durationMs: number
  readonly cores?: number
  readonly rssBytes?: number
}

/** One cached task's run, as the server's flaky record keeps it (PROTOCOL.md "Outcomes"). */
export interface ServerOutcome {
  /** The task's definition hash. */
  readonly hash: string
  /** The run's cache key. */
  readonly key: string
  readonly outcome: 'pass' | 'fail' | 'flaky'
}

/** What a query answers: each held hash's numbers, and the hashes asked that are flaky. */
export interface Answer {
  readonly timings: Map<string, ServerTiming>
  readonly flaky: Set<string>
}

/**
 * A cached task the run ran, as the flaky record takes it; else undefined.
 * A hit ran nothing, and a task behind a failure ran on bytes its key never
 * named: neither says anything of the key.
 */
export function outcomeOf(o: TaskOutcome, def: string): ServerOutcome | undefined {
  if (o.node.config.cache === undefined || o.hash === undefined || o.hash === '') return undefined
  if (o.blockedBy !== undefined) return undefined
  if (o.status === 'failed') return { hash: def, key: o.hash, outcome: 'fail' }
  if (o.status !== 'success') return undefined
  const flaky = (o.attempts ?? 1) > 1 || o.flaky !== undefined
  return { hash: def, key: o.hash, outcome: flaky ? 'flaky' : 'pass' }
}

/** Every request's deadline: a run never waits on history longer. */
const DEADLINE_MS = 10_000
/** Tries of a request, to the server or GitHub's OIDC endpoint, before it fails (`tried`). */
const ATTEMPTS = 3

/** The issuer and repository a workspace names, as a key holds them: the issuer's URL with no trailing slash, `org/name` lowercased. */
export interface Named {
  readonly issuer: string
  readonly repository: string
}

/** Whether this job has a token: GitHub's OIDC endpoint, or GitLab's `VX_HISTORY_TOKEN`. */
const hasToken = (env: Record<string, string | undefined>): boolean =>
  (!!env.ACTIONS_ID_TOKEN_REQUEST_URL && !!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) ||
  !!env.VX_HISTORY_TOKEN

/** A task the run ran and that succeeded, as the server takes its timing; else undefined. */
export function timingOf(o: TaskOutcome): ServerTiming | undefined {
  if (o.status !== 'success') return undefined
  // Core's need (history.ts NEED_SQL): at most the machine's cores, and no
  // reading where the share is 0. Uncapped, a crowded 4-core worker sent 8
  // and a DTE plan booked that; an Infinity went as null and the server
  // refused the whole upload.
  const need =
    o.cpuMs === undefined || o.durationMs <= 0
      ? undefined
      : Math.min(o.cpuMs / (o.durationMs * (o.cpuShare ?? 1)), o.whereCores ?? Infinity)
  // A share rounded to 0 divides by it, and the server refuses the upload.
  const cores = need !== undefined && Number.isFinite(need) ? need : undefined
  return {
    durationMs: Math.max(0, aloneMs(o)),
    ...(cores === undefined ? {} : { cores }),
    ...(o.peakRssBytes === undefined ? {} : { rssBytes: o.peakRssBytes }),
  }
}

/**
 * How long it would have taken alone, as core's local history stores it
 * (`run-history.ts` aloneMs): on a crowded DTE worker (`cpuShare` < 1) each
 * thread waited for a core. Sent as it ran, every crowded run raised the
 * shared number a forecast reads (2026-10-26).
 */
function aloneMs(o: TaskOutcome): number {
  const { durationMs: d, cpuMs: c, cpuShare: s } = o
  if (c === undefined || s === undefined || !(s > 0 && s < 1) || !(d > 0)) return Math.round(d)
  return Math.round(d - (c / s - c) / Math.max(1, c / (d * s)))
}

/** {@link DEADLINE_MS}, or `stop` first. */
const deadline = (stop?: AbortSignal): AbortSignal => {
  const c = new AbortController()
  setTimeout(() => c.abort(new Error(`no answer within ${DEADLINE_MS} ms`)), DEADLINE_MS).unref()
  return stop === undefined ? c.signal : AbortSignal.any([c.signal, stop])
}

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
  // quiet: with the body unread, the status alone names the refusal
  const text = (await res.text().catch(() => '')).slice(0, 2048)
  let said = text
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message
    if (typeof m === 'string') said = m
  } catch {
    // quiet: not JSON, so the text is what it said
  }
  said = printable(said.replace(/\s+/g, ' ').trim().slice(0, 200))
  return new Error(`HTTP ${res.status}${said === '' ? '' : `: ${said}`}`)
}

/** A 200's JSON; one that is none (a website's page) names the likely fault, the url. */
async function jsonOf(res: Response, path: string): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    const type = res.headers.get('content-type') ?? 'no content type'
    throw new Error(
      `${path} answered ${res.status} with ${type}, not JSON: is the url a vx-history server?`,
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

/** A JWT's `exp` in ms; 0 when it names none. */
function expiryOf(jwt: string): number {
  try {
    const exp = (
      JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as {
        exp?: unknown
      }
    ).exp
    return typeof exp === 'number' ? exp * 1000 : 0
  } catch {
    // quiet: an unreadable exp is no known expiry; the server refuses the token
    return 0
  }
}

/** A whole count a server keeps (its own check): a sum of thousands stays finite. */
const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/**
 * A request refused for its size, its refusal naming a smaller limit
 * (`vx-max-*`): sent again in parts of at most `max`.
 */
class TooMany extends Error {
  constructor(readonly max: number) {
    super(`at most ${max} a request`)
  }
}

/** The limit `header` names, when it is a whole number above 0. */
function limitOf(res: Response, header: string): number | undefined {
  const n = Number(res.headers.get(header) ?? NaN)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

export class HistoryServer {
  private token: Promise<string> | undefined
  private held: { jwt: string; exp: number } | undefined
  // A refused token is refused again: the run's later calls stay unasked and unsaid.
  private refused = false

  constructor(
    readonly url: string,
    private readonly named: Named,
    private readonly env: Record<string, string | undefined> = Bun.env,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly headers: Readonly<Record<string, string>> = {},
    private readonly wait: (ms: number) => Promise<void> = Bun.sleep,
  ) {}

  /** Whether the run has a token to send: with none it reads only. */
  get writes(): boolean {
    return hasToken(this.env)
  }

  /**
   * The job's token: GitHub's OIDC token for the server's origin, asked
   * again a minute before it ends (it lives minutes, a run can outlive it),
   * else `VX_HISTORY_TOKEN`.
   */
  private bearer(signal?: AbortSignal): Promise<string> {
    const held = this.held
    if (held !== undefined && (held.exp === 0 || Date.now() < held.exp - 60_000)) {
      return Promise.resolve(held.jwt)
    }
    this.token ??= (async () => {
      const ask = this.env.ACTIONS_ID_TOKEN_REQUEST_URL
      if (ask === undefined || ask === '') return { jwt: this.env.VX_HISTORY_TOKEN ?? '', exp: 0 }
      const u = new URL(ask)
      u.searchParams.set('audience', new URL(this.url).origin)
      const res = await this.askGithub(u, signal)
      if (!res.ok) throw new Error(`GitHub's OIDC endpoint: ${(await refusal(res)).message}`)
      // quiet: a body that is not JSON holds no token, said below
      const jwt = ((await res.json().catch(() => null)) as { value?: unknown } | null)?.value
      if (typeof jwt !== 'string' || jwt === '') throw new Error("GitHub's OIDC endpoint: no token")
      return { jwt, exp: expiryOf(jwt) }
    })()
      .then((t) => (this.held = t).jwt)
      .finally(() => (this.token = undefined))
    return this.token
  }

  /**
   * One answer, asked again while `again(status)` (`undefined`: no answer)
   * holds, up to three tries, 1 s then 2 s apart: the upload is sent once, at the run's end,
   * and one 503 there, or from GitHub's OIDC endpoint (as vx-cache asks
   * it, #4571), lost the run's timings.
   */
  private async tried(
    send: () => Promise<Response>,
    again: (status: number | undefined) => boolean,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined
      let failure: unknown
      try {
        res = await send()
      } catch (err) {
        failure = err
      }
      if (!again(res?.status)) {
        if (res === undefined) throw failure
        return res
      }
      if (attempt === ATTEMPTS) {
        if (res === undefined) throw failure
        return res
      }
      await res?.body?.cancel()
      await this.wait(1000 * attempt)
    }
  }

  /** GitHub's OIDC endpoint: a 4xx is final. */
  private askGithub(ask: URL, signal?: AbortSignal): Promise<Response> {
    return this.tried(
      () =>
        this.fetchImpl(ask, {
          headers: { authorization: `bearer ${this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ''}` },
          signal: deadline(signal),
        }),
      (status) => status === undefined || status === 429 || status >= 500,
    )
  }

  /**
   * One request. `sized`: its body's count of items and the `vx-max-*`
   * header that limits them; a refusal naming a smaller limit throws
   * `TooMany`.
   */
  private async call(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    sized?: { count: number; header: string },
  ): Promise<Response> {
    const bearer = this.writes ? await this.bearer(signal) : ''
    const json = body === undefined ? undefined : JSON.stringify(body)
    // A 500 is the server's own failure, maybe after the fold: sent again, a
    // run would count twice. The edge's 502, 503 and 504 and a 429 come
    // before it. No answer is not asked again: a server down or misnamed
    // would add seconds to every run's end.
    const url = `${this.url}${path}`
    const res = await this.tried(
      () =>
        this.fetchImpl(url, {
          method: json === undefined ? 'GET' : 'POST',
          headers: {
            ...this.headers,
            ...(bearer === '' ? {} : { authorization: `Bearer ${bearer}` }),
            ...(json === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(json === undefined ? {} : { body: json }),
          signal: deadline(signal),
          redirect: 'manual',
        }),
      (status) => status !== undefined && (status === 429 || (status >= 502 && status <= 504)),
    )
    if (res.status >= 300 && res.status < 400) throw await redirected(res, url)
    if (res.status === 401 && bearer === '') {
      // Off CI: the bare 401 said nothing of why or what to do (2026-10-26).
      const err = await refusal(res)
      const fix =
        this.env.GITHUB_ACTIONS === 'true'
          ? 'give the job `permissions: id-token: write`'
          : this.env.GITLAB_CI === 'true'
            ? 'name an id_tokens entry VX_HISTORY_TOKEN'
            : 'off CI, a server reads only with READ_ACCESS=public'
      throw new Error(`${err.message}: a read with no CI token was refused (${fix})`)
    }
    if (res.status === 401) {
      // The bare "HTTP 401: wrong audience" named neither what was sent nor what to check.
      this.refused = true
      const err = await refusal(res)
      throw new Error(
        `${err.message}: the token was refused (this workspace names ${this.named.repository} at ${this.named.issuer}; the server's ALLOW must name it, and the token's audience be ${new URL(this.url).origin}); the history server is off for this run`,
      )
    }
    if (!res.ok) {
      const max = sized === undefined ? undefined : limitOf(res, sized.header)
      if (max !== undefined && sized!.count > max) {
        await res.body?.cancel()
        throw new TooMany(max)
      }
      throw await refusal(res)
    }
    return res
  }

  /**
   * `items` in requests of `send`, whole until an answer names the limit
   * (`vx-max-*`): one refused for its size is sent again in parts of the
   * limit it names, each a smaller one than the last. Nothing is asked apart: `/v1/capabilities` cost
   * every run a request, and the query a round-trip (2026-11-06). A query
   * sends its parts at once; an upload one after another, so a refused
   * part resends no part the server folded.
   */
  private async parts<T, R>(
    items: readonly T[],
    header: string,
    atOnce: boolean,
    send: (part: readonly T[], sized?: { count: number; header: string }) => Promise<R>,
  ): Promise<R[]> {
    let per = this.limits.get(header) ?? items.length
    const sized = (part: readonly T[]) => ({ count: part.length, header })
    const learn = (err: unknown): void => {
      if (!(err instanceof TooMany) || this.limits.get(header) === err.max) throw err
      this.limits.set(header, err.max)
      per = err.max
    }
    const split = (from: readonly T[]) =>
      Array.from({ length: Math.ceil(from.length / per) }, (_, i) =>
        from.slice(i * per, (i + 1) * per),
      )
    if (atOnce) {
      const first = await Promise.allSettled(split(items).map((p) => send(p, sized(p))))
      const refused = first.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []))
      const failed = refused.find((err) => !(err instanceof TooMany))
      if (failed !== undefined) throw failed
      if (refused.length === 0) return first.map((r) => (r as PromiseFulfilledResult<R>).value)
      learn(refused[0])
      return Promise.all(split(items).map((p) => send(p)))
    }
    const out: R[] = []
    for (let at = 0; at < items.length;) {
      const part = items.slice(at, at + per)
      try {
        out.push(await send(part, sized(part)))
        at += part.length
      } catch (err) {
        learn(err)
      }
    }
    return out
  }

  /** The limits a refusal named this run, by header: later requests keep to them. */
  private readonly limits = new Map<string, number>()

  /** Each held hash's numbers under the first of `refs` that holds them, and the flaky ones: one request a run. */
  async query(refs: readonly string[], hashes: readonly string[]): Promise<Answer> {
    if (hashes.length === 0 || this.refused) return { timings: new Map(), flaky: new Set() }
    const parts = await this.parts(hashes, 'vx-max-query-hashes', true, async (part, sized) => {
      const res = await this.call(
        '/v1/timings/query',
        { ...this.named, refs, hashes: part },
        undefined,
        sized,
      )
      const body = (await jsonOf(res, '/v1/timings/query')) as {
        timings?: unknown
        flaky?: unknown
      } | null
      if (typeof body?.timings !== 'object' || body.timings === null) {
        throw new Error('the query answered no `timings` object')
      }
      // A server before the flaky record answers none: nothing is flaky.
      const flaky = Array.isArray(body.flaky)
        ? body.flaky.filter((h): h is string => typeof h === 'string')
        : []
      return {
        timings: Object.entries(body.timings as Record<string, ServerTiming | null>),
        flaky,
      }
    })
    // Only numbers a server folds (PROTOCOL.md): `1e309` parses to Infinity,
    // and kept as a forecast it made a NaN weight that failed every later
    // run of the cache in `schedule`.
    const out = new Map<string, ServerTiming>()
    for (const [hash, t] of parts.flatMap((p) => p.timings)) {
      if (!isCount(t?.durationMs)) continue
      out.set(hash, {
        durationMs: t.durationMs,
        ...(typeof t.cores === 'number' && Number.isFinite(t.cores) && t.cores >= 0
          ? { cores: t.cores }
          : {}),
        ...(isCount(t.rssBytes) ? { rssBytes: t.rssBytes } : {}),
      })
    }
    return { timings: out, flaky: new Set(parts.flatMap((p) => p.flaky)) }
  }

  /**
   * The run's timings, by task definition hash, and its outcomes, in
   * uploads the server takes; `stop` abandons them.
   */
  async upload(
    timings: ReadonlyMap<string, ServerTiming>,
    stop?: AbortSignal,
    outcomes: readonly ServerOutcome[] = [],
  ): Promise<void> {
    if ((timings.size === 0 && outcomes.length === 0) || this.refused) return
    const all = [...timings].map(([hash, t]) => ({ hash, ...t }))
    const at = Array.from({ length: Math.max(all.length, outcomes.length) }, (_, i) => i)
    // A refused upload folded nothing: sent again in parts, none counts twice.
    await this.parts(at, 'vx-max-upload-timings', false, (part, sized) => {
      const from = part[0] ?? 0
      const to = from + part.length
      const some = outcomes.slice(from, to)
      return this.call(
        '/v1/timings/upload',
        { timings: all.slice(from, to), ...(some.length > 0 ? { outcomes: some } : {}) },
        stop,
        sized,
      )
    })
  }
}
