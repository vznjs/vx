// The client of a vx-history server (`@vzn/vx-history-server`, its
// PROTOCOL.md): each task's numbers asked once a run, and the run's own
// timings sent once at its end. A query names the issuer, repository and
// refs the workspace reads, plainly; a CI job's request carries its OIDC
// token, which writes its own ref, and with no token a run only reads (a
// server with `READ_ACCESS=public`). A refusal is never swallowed: it is said with the
// server's status and words.

import { type TaskOutcome, UserError } from '@vzn/vx'

/** One task's numbers, as the server folds and answers them. */
export interface ServerTiming {
  readonly durationMs: number
  readonly cores?: number
  readonly rssBytes?: number
}

/** Every request's deadline: a run never waits on history longer. */
const DEADLINE_MS = 10_000

/** `VX_HISTORY_URL` under the option, trailing slashes dropped; undefined when neither names one. */
export function serverUrlOf(
  option: string | undefined,
  env: Record<string, string | undefined> = Bun.env,
): string | undefined {
  const url = (option ?? env.VX_HISTORY_URL)?.replace(/\/+$/, '')
  if (url === undefined || url === '') return undefined
  // Named as the workspace set it: a bad VX_HISTORY_URL was refused as `url`.
  const from = option === undefined ? 'VX_HISTORY_URL' : 'url'
  if (!/^https?:\/\//.test(url)) throw new Error(`vxHistory(): ${from} must be http(s), got ${url}`)
  // Each route is the server's /v1/…: one that names /v1 asked /v1/v1/…, and every answer was a 404.
  if (url.endsWith('/v1'))
    throw new Error(`vxHistory(): ${from} is the server's base, without /v1: ${url.slice(0, -3)}`)
  return url
}

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
  const cores =
    o.cpuMs === undefined || o.durationMs <= 0
      ? undefined
      : o.cpuMs / (o.durationMs * (o.cpuShare ?? 1))
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

const deadline = (): AbortSignal => {
  const c = new AbortController()
  setTimeout(() => c.abort(new Error(`no answer within ${DEADLINE_MS} ms`)), DEADLINE_MS).unref()
  return c.signal
}

/** A refusal, named by its status and the server's own `message`. */
async function refusal(res: Response): Promise<Error> {
  const text = (await res.text().catch(() => '')).slice(0, 2048)
  let said = text
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message
    if (typeof m === 'string') said = m
  } catch {
    // not JSON: the text is what it said
  }
  said = said.replace(/\s+/g, ' ').trim().slice(0, 200)
  return new Error(`HTTP ${res.status}${said === '' ? '' : `: ${said}`}`)
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
    return 0
  }
}

interface Limits {
  readonly maxUploadTimings: number
  readonly maxQueryHashes: number
}

/** `vxHistory({ headers })` with unset values left out; a name or value no header can carry, or `authorization`, refused. */
export function proxyHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.toLowerCase() === 'authorization')
      throw new UserError(`vxHistory(): headers cannot set "${name}"`)
    if (typeof value !== 'string' || /[\r\n\0]/.test(value))
      throw new UserError(`vxHistory(): header "${name}" must be one line of text`)
    out[name] = value
  }
  return out
}

export class HistoryServer {
  private token: Promise<string> | undefined
  private held: { jwt: string; exp: number } | undefined
  private limits: Promise<Limits> | undefined

  constructor(
    readonly url: string,
    private readonly named: Named,
    private readonly env: Record<string, string | undefined> = Bun.env,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly headers: Readonly<Record<string, string>> = {},
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
  private bearer(): Promise<string> {
    const held = this.held
    if (held !== undefined && (held.exp === 0 || Date.now() < held.exp - 60_000)) {
      return Promise.resolve(held.jwt)
    }
    this.token ??= (async () => {
      const ask = this.env.ACTIONS_ID_TOKEN_REQUEST_URL
      if (ask === undefined || ask === '') return { jwt: this.env.VX_HISTORY_TOKEN ?? '', exp: 0 }
      const u = new URL(ask)
      u.searchParams.set('audience', new URL(this.url).origin)
      const res = await this.fetchImpl(u, {
        headers: { authorization: `bearer ${this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ''}` },
        signal: deadline(),
      })
      if (!res.ok) throw new Error(`GitHub's OIDC endpoint: ${(await refusal(res)).message}`)
      const jwt = ((await res.json()) as { value?: unknown }).value
      if (typeof jwt !== 'string' || jwt === '') throw new Error("GitHub's OIDC endpoint: no token")
      return { jwt, exp: expiryOf(jwt) }
    })()
      .then((t) => (this.held = t).jwt)
      .finally(() => (this.token = undefined))
    return this.token
  }

  private async call(path: string, body?: unknown): Promise<Response> {
    const bearer = this.writes ? await this.bearer() : ''
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...this.headers,
        ...(bearer === '' ? {} : { authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: deadline(),
    })
    if (res.status === 401 && bearer === '') {
      // Off CI: the bare 401 said nothing of why or what to do (2026-10-26).
      const err = await refusal(res)
      throw new Error(
        `${err.message}: a read with no CI token was refused (off CI, a server reads only with READ_ACCESS=public)`,
      )
    }
    if (!res.ok) throw await refusal(res)
    return res
  }

  /** `/v1/capabilities`, asked once a run, and again after a failed ask: nothing is guessed. */
  private limitsNow(): Promise<Limits> {
    const asked = (this.limits ??= (async () => {
      const body = (await (await this.call('/v1/capabilities')).json()) as Partial<Limits> | null
      const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0)
      const limits = {
        maxUploadTimings: n(body?.maxUploadTimings),
        maxQueryHashes: n(body?.maxQueryHashes),
      }
      if (limits.maxUploadTimings === 0 || limits.maxQueryHashes === 0) {
        throw new Error('/v1/capabilities named no maxUploadTimings or maxQueryHashes')
      }
      return limits
    })())
    asked.catch(() => {
      if (this.limits === asked) this.limits = undefined
    })
    return asked
  }

  /** Each held hash's numbers under the first of `refs` that holds them: one request a run. */
  async query(
    refs: readonly string[],
    hashes: readonly string[],
  ): Promise<Map<string, ServerTiming>> {
    const per = (await this.limitsNow()).maxQueryHashes
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(hashes.length / per) }, async (_, i) => {
        const res = await this.call('/v1/timings/query', {
          ...this.named,
          refs,
          hashes: hashes.slice(i * per, (i + 1) * per),
        })
        const body = (await res.json()) as { timings?: unknown } | null
        if (typeof body?.timings !== 'object' || body.timings === null) {
          throw new Error('the query answered no `timings` object')
        }
        return Object.entries(body.timings as Record<string, ServerTiming | null>)
      }),
    )
    const out = new Map<string, ServerTiming>()
    for (const [hash, t] of parts.flat()) {
      if (typeof t?.durationMs !== 'number' || !(t.durationMs >= 0)) continue
      out.set(hash, {
        durationMs: t.durationMs,
        ...(typeof t.cores === 'number' ? { cores: t.cores } : {}),
        ...(typeof t.rssBytes === 'number' ? { rssBytes: t.rssBytes } : {}),
      })
    }
    return out
  }

  /** The run's timings, by task definition hash, in uploads of at most `maxUploadTimings`. */
  async upload(timings: ReadonlyMap<string, ServerTiming>): Promise<void> {
    if (timings.size === 0) return
    const per = (await this.limitsNow()).maxUploadTimings
    const all = [...timings].map(([hash, t]) => ({ hash, ...t }))
    for (let i = 0; i < all.length; i += per) {
      await this.call('/v1/timings/upload', { timings: all.slice(i, i + per) })
    }
  }
}
