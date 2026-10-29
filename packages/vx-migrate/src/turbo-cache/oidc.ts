// A GitHub Actions job's OIDC token, exchanged for a short-lived remote
// cache token (RFC 8693), and revoked when the run ends (RFC 7009): no
// long-lived TURBO_TOKEN secret in the repo. Vercel's flow as its own
// action runs it (vercel/setup-turborepo-remote-cache-action, read
// 2026-10-17); any other server names its token URL.

import { deadline } from '../remote-deadline.js'

/** `turboCache({ oidc })`: `true` is Vercel's hosted cache with its defaults. */
export interface TurboOidcOptions {
  /** The RFC 8693 token endpoint; Vercel's by default with Vercel's cache, required otherwise. */
  tokenUrl?: string
  /** The RFC 7009 revocation endpoint, asked when the run ends; `false`: none. Vercel's by default. */
  revokeUrl?: string | false
  /** The `audience` GitHub mints the OIDC token for. */
  audience?: string
  /** Fields the exchange also sends (Vercel's `policy_id`); over the defaults. */
  params?: Record<string, string>
}

export interface OidcConfig {
  /** GitHub's ID-token endpoint and its bearer: the job's `ACTIONS_ID_TOKEN_REQUEST_*`. */
  idTokenUrl: string
  idTokenBearer: string
  tokenUrl: string
  revokeUrl?: string
  audience?: string
  params: Record<string, string>
}

const VERCEL_TOKEN_URL = 'https://api.vercel.com/login/oauth/token'
const VERCEL_REVOKE_URL = 'https://api.vercel.com/login/oauth/token/revoke'
/** Vercel's public OAuth client for the Remote Cache exchange, as its action sends it. */
const VERCEL_CLIENT_ID = 'cl_kyUx2zVvA4MGptBohkmtYHJly2XltXzD'

const ATTEMPTS = 3
const TIMEOUT_MS = 30_000

/**
 * The exchange `oidc` asks for, or undefined when the option is off. A
 * misconfigured one (a server that is not Vercel's with no `tokenUrl`, a
 * Vercel exchange with no team) is refused at config load.
 */
export function oidcSettings(
  oidc: true | TurboOidcOptions,
  vercel: boolean,
  team: string | undefined,
): Omit<OidcConfig, 'idTokenUrl' | 'idTokenBearer'> {
  const o = oidc === true ? {} : oidc
  if (typeof o !== 'object' || o === null)
    throw new Error('turboCache(): oidc must be true or { tokenUrl, revokeUrl, audience, params }')
  if (!vercel && o.tokenUrl === undefined)
    throw new Error("turboCache(): oidc needs tokenUrl for a cache that is not Vercel's")
  if (vercel && team === undefined)
    throw new Error('turboCache(): oidc on Vercel needs teamId or teamSlug (TURBO_TEAM)')
  const revokeUrl = o.revokeUrl ?? (vercel ? VERCEL_REVOKE_URL : undefined)
  return {
    tokenUrl: o.tokenUrl ?? VERCEL_TOKEN_URL,
    ...(revokeUrl === false || revokeUrl === undefined ? {} : { revokeUrl }),
    ...(o.audience !== undefined ? { audience: o.audience } : {}),
    params: {
      ...(vercel ? { client_id: VERCEL_CLIENT_ID, team_id_or_slug: team! } : {}),
      ...o.params,
    },
  }
}

/** A request, sent again on a 429, a 5xx or no answer: up to three tries, 30 s each. */
async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  wait: (ms: number) => Promise<void>,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined
    let failure: unknown
    try {
      res = await fetchImpl(url, { ...init, signal: deadline(TIMEOUT_MS) })
    } catch (err) {
      failure = err
    }
    const again = res === undefined || res.status === 429 || res.status >= 500
    if (!again || attempt === ATTEMPTS) {
      if (res === undefined) throw failure
      return res
    }
    await res?.body?.cancel()
    await wait(1000 * attempt)
  }
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
})

/** Where a URL points, never its query: GitHub's carries a runtime id. */
const where = (url: string) => (URL.canParse(url) ? new URL(url).host : 'the endpoint')

/**
 * A refusal's own words: RFC 6749's `error` and `error_description`, or
 * GitHub's `message`. Only those fields, which name a fault and never
 * carry a token; any other body is left unread. "answered HTTP 400" alone
 * did not say the audience or the grant was wrong.
 */
async function refused(res: Response, what: string): Promise<Error> {
  // quiet: a body that is not JSON says nothing; the status still names the refusal
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== ''
      ? v.replace(/\s+/g, ' ').trim().slice(0, 200)
      : undefined
  const said = [text(body?.['error']), text(body?.['error_description']) ?? text(body?.['message'])]
    .filter((s) => s !== undefined)
    .join(': ')
  return new Error(`${what} answered HTTP ${res.status}${said === '' ? '' : `: ${said}`}`)
}

async function field(res: Response, name: string, what: string): Promise<string> {
  if (!res.ok) throw await refused(res, what)
  const value = ((await res.json().catch(() => null)) as Record<string, unknown> | null)?.[name]
  if (typeof value !== 'string' || value === '') throw new Error(`${what} sent no ${name}`)
  return value
}

/** An exchanged token, and when it ends (epoch ms) when the server says. */
export interface Exchanged {
  readonly token: string
  readonly expiresAt?: number
}

/** The job's OIDC token, exchanged for the cache's access token. Errors never quote a token. */
export async function exchangeOidc(
  cfg: OidcConfig,
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = Bun.sleep,
): Promise<Exchanged> {
  const idUrl = new URL(cfg.idTokenUrl)
  if (cfg.audience !== undefined) idUrl.searchParams.set('audience', cfg.audience)
  const idToken = await field(
    await send(
      fetchImpl,
      idUrl.toString(),
      { headers: { Authorization: `bearer ${cfg.idTokenBearer}` } },
      wait,
    ),
    'value',
    `GitHub's OIDC endpoint (${where(cfg.idTokenUrl)})`,
  )
  const res = await send(
    fetchImpl,
    cfg.tokenUrl,
    form({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      ...cfg.params,
    }),
    wait,
  )
  const what = `the token exchange (${where(cfg.tokenUrl)})`
  if (!res.ok) throw await refused(res, what)
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const token = body?.['access_token']
  if (typeof token !== 'string' || token === '') throw new Error(`${what} sent no access_token`)
  const ttl = body?.['expires_in']
  return {
    token,
    ...(typeof ttl === 'number' && ttl > 0 ? { expiresAt: Date.now() + ttl * 1000 } : {}),
  }
}

/** Revoke the exchanged token; a throw is the caller's warning. */
export async function revokeOidc(
  cfg: OidcConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = Bun.sleep,
): Promise<void> {
  if (cfg.revokeUrl === undefined) return
  const clientId = cfg.params['client_id']
  const res = await send(
    fetchImpl,
    cfg.revokeUrl,
    form({
      ...(clientId !== undefined ? { client_id: clientId } : {}),
      token,
      token_type_hint: 'access_token',
    }),
    wait,
  )
  if (!res.ok) throw await refused(res, `revoking at ${where(cfg.revokeUrl)}`)
  await res.body?.cancel()
}
