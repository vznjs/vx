// The client of a vx-history server (`@vzn/vx-history-server`, its
// PROTOCOL.md): each task's numbers asked once a run, and the run's own
// timings sent once at its end. CI jobs only: every request carries the
// job's OIDC token. A refusal is never swallowed: it is said with the
// server's status and words.

import type { TaskOutcome } from '@vzn/vx'

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
  if (!/^https?:\/\//.test(url)) throw new Error(`vxHistory(): server must be http(s), got ${url}`)
  return url
}

/** Whether this job has a token: GitHub's OIDC endpoint, or GitLab's `VX_HISTORY_TOKEN`. */
export const hasToken = (env: Record<string, string | undefined>): boolean =>
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
    durationMs: Math.max(0, Math.round(o.durationMs)),
    ...(cores === undefined ? {} : { cores }),
    ...(o.peakRssBytes === undefined ? {} : { rssBytes: o.peakRssBytes }),
  }
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

export class HistoryServer {
  private token: Promise<string> | undefined
  private held: { jwt: string; exp: number } | undefined
  private limits: Promise<Limits> | undefined

  constructor(
    readonly url: string,
    private readonly env: Record<string, string | undefined> = Bun.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${await this.bearer()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: deadline(),
    })
    if (!res.ok) throw await refusal(res)
    return res
  }

  /** `/v1/capabilities`, asked once: nothing is guessed. */
  private limitsNow(): Promise<Limits> {
    this.limits ??= (async () => {
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
    })()
    return this.limits
  }

  /** Each held hash's numbers in the first of `scopes` (refs' hashes) holding it. */
  async query(
    scopes: readonly string[],
    hashes: readonly string[],
  ): Promise<Map<string, ServerTiming>> {
    const per = (await this.limitsNow()).maxQueryHashes
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(hashes.length / per) }, async (_, i) => {
        const res = await this.call('/v1/timings/query', {
          scopes,
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
