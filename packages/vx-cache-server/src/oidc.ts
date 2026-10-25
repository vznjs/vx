// CI OIDC tokens (PROTOCOL.md § Tokens): a job's token decides where it
// writes, never a header or a client option. A token of a repository that
// `TRUST` names matching one of its rules writes the trusted scope; any
// other of that repository writes its own branch's; any other repository
// is refused. The JWT itself is jose's to check: signature, algorithm,
// audience and times.

import { createLocalJWKSet, decodeJwt, errors, jwtVerify, type JWTPayload } from 'jose'
import type { Access, Authorize } from './auth.js'
import { Refusal } from './protocol.js'
import { TRUSTED } from './store.js'

/**
 * One rule of `TRUST`: the issuer, the repository's id claim
 * (`repository_id` on GitHub, `project_id` elsewhere), and any other
 * claims a trusted job's token holds, each a string (`*` matches any run
 * of characters) or a list of them. `ns` is the namespace the repository's
 * artifacts and runs live in (default `default`, the static tokens' own).
 */
export interface TrustRule {
  readonly iss: string
  readonly ns?: string
  readonly [claim: string]: string | readonly string[] | undefined
}

const GITHUB = 'https://token.actions.githubusercontent.com'
const NS = 'default'

/** The claim naming a token's repository by an id that a rename keeps. */
const repoClaimOf = (iss: string): string => (iss === GITHUB ? 'repository_id' : 'project_id')
/** The claim naming the ref a token's job runs on. */
const refClaimOf = (iss: string): string => (iss === GITHUB ? 'ref' : 'ref_path')

/** `TRUST`: a JSON list of rules, each with `iss` and its repository id claim. */
export function parseTrust(json: string): TrustRule[] {
  if (json.trim() === '') return []
  const rules: unknown = JSON.parse(json)
  if (!Array.isArray(rules)) throw new Error('not a JSON list of rules')
  return rules.map((r: unknown, i) => {
    const at = `rule ${i}`
    if (typeof r !== 'object' || r === null || Array.isArray(r))
      throw new Error(`${at}: not an object`)
    const rule = r as Record<string, unknown>
    for (const [claim, v] of Object.entries(rule)) {
      const ok =
        typeof v === 'string' ||
        (claim !== 'iss' &&
          claim !== 'ns' &&
          Array.isArray(v) &&
          v.length > 0 &&
          v.every((x) => typeof x === 'string'))
      if (!ok)
        throw new Error(
          `${at}: ${claim} is not a string${claim === 'iss' || claim === 'ns' ? '' : ' or a list of them'}`,
        )
    }
    if (typeof rule['iss'] !== 'string' || !rule['iss'].startsWith('https://')) {
      throw new Error(`${at}: iss is not an https:// issuer`)
    }
    const id = repoClaimOf(rule['iss'])
    if (typeof rule[id] !== 'string' || rule[id].includes('*')) {
      throw new Error(`${at}: names no ${id} (one repository, no *)`)
    }
    // The refs a rule trusts are the ones no untrusted token may write:
    // a read naming them would find that scope before trusted.
    if (rule[refClaimOf(rule['iss'])] === undefined) {
      throw new Error(`${at}: names no ${refClaimOf(rule['iss'])} (the refs it trusts)`)
    }
    return rule as TrustRule
  })
}

const globOf = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  )

/** Whether every claim a rule names holds one of its values. */
function matches(rule: TrustRule, claims: JWTPayload): boolean {
  for (const [claim, want] of Object.entries(rule)) {
    if (claim === 'ns' || want === undefined) continue
    const v = claims[claim]
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return false
    const got = String(v)
    if (!(typeof want === 'string' ? [want] : want).some((w) => globOf(w).test(got))) return false
  }
  return true
}

/**
 * The scope an untrusted token writes: its branch. A GitHub pull request's
 * run writes its head branch (its `ref` is the merge ref no local run
 * names); any other run its `ref`, GitLab's its `ref_path`.
 */
function branchOf(iss: string, claims: JWTPayload): string | undefined {
  const head = claims['head_ref']
  const ref =
    iss === GITHUB
      ? typeof head === 'string' && head !== ''
        ? `refs/heads/${head}`
        : claims['ref']
      : claims['ref_path']
  return typeof ref === 'string' && ref.startsWith('refs/') && ref.length <= 512 ? ref : undefined
}

export interface OidcOptions {
  readonly trust: readonly TrustRule[]
  /** The `aud` a token must name; unset, the origin the server is reached at. */
  readonly audience?: string
  /** Reads a URL as JSON; tests serve keys without a network. */
  readonly fetchJson?: (url: string) => Promise<unknown>
  /** Seconds since the epoch; tests move the clock. */
  readonly now?: () => number
}

/** Clock skew a token's `exp` / `nbf` may be off by. */
const LEEWAY_S = 60
/** An unknown `kid` refetches an issuer's keys at most this often. */
const REFETCH_MS = 60_000

/** The `Access` a verified CI token has; a refused one throws a 401 or 403. */
export function oidcAuth(opts: OidcOptions): (token: string, req: Request) => Promise<Access> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson
  const now = opts.now ?? (() => Date.now() / 1000)
  type KeySet = ReturnType<typeof createLocalJWKSet>
  const keys = new Map<string, { at: number; set: Promise<KeySet> }>()
  const load = (iss: string) => {
    const entry = { at: Date.now(), set: loadKeys(iss, fetchJson) }
    keys.set(iss, entry)
    // A failed load is not kept: the next token tries again.
    entry.set.catch(() => keys.get(iss) === entry && keys.delete(iss))
    return entry
  }
  const verify = async (token: string, iss: string, audience: string, fresh: boolean) => {
    const entry = (fresh ? undefined : keys.get(iss)) ?? load(iss)
    const set = await entry.set.catch(() => {
      throw new Refusal(401, `could not read ${iss}'s keys`)
    })
    return (
      await jwtVerify(token, set, {
        algorithms: ['RS256'],
        audience,
        clockTolerance: LEEWAY_S,
        currentDate: new Date(now() * 1000),
        requiredClaims: ['exp'],
      })
    ).payload
  }

  return async (token, req) => {
    let iss: unknown
    try {
      iss = decodeJwt(token).iss
    } catch {
      throw new Refusal(401, 'not a JWT')
    }
    if (typeof iss !== 'string' || !opts.trust.some((r) => r.iss === iss)) {
      throw new Refusal(401, 'untrusted issuer')
    }
    const audience = opts.audience ?? new URL(req.url).origin
    let claims: JWTPayload
    try {
      // A key rotated in since the last read is fetched once a REFETCH_MS.
      claims = await verify(token, iss, audience, false).catch((err: unknown) => {
        if (
          !(err instanceof errors.JWKSNoMatchingKey) ||
          Date.now() - (keys.get(iss)?.at ?? 0) < REFETCH_MS
        ) {
          throw err
        }
        return verify(token, iss, audience, true)
      })
    } catch (err) {
      throw refusal(err)
    }
    const id = repoClaimOf(iss)
    const repo = String(claims[id])
    const ofRepo = opts.trust.filter((r) => r.iss === iss && r[id] === repo)
    if (ofRepo.length === 0) throw new Refusal(403, `${id} ${repo} is not in this server's TRUST`)
    const trusted = ofRepo.find((r) => matches(r, claims))
    if (trusted !== undefined) return { ns: trusted.ns ?? NS, write: TRUSTED }
    const branch = branchOf(iss, claims)
    const ns = ofRepo[0]!.ns ?? NS
    // A trusted ref's scope is never an untrusted token's: main's runs
    // name refs/heads/main first, and would read it before trusted.
    const refClaim = refClaimOf(iss)
    const trustedRef = (ref: string): boolean =>
      ofRepo.some((r) => {
        const want = r[refClaim]!
        return (typeof want === 'string' ? [want] : want).some((w) => globOf(w).test(ref))
      })
    return branch === undefined || trustedRef(branch) ? { ns } : { ns, write: branch }
  }
}

/**
 * Static tokens and CI tokens behind one `Authorize`: a bearer that is a
 * JWT (three dot-separated parts) is a CI token, any other a static one.
 */
export function anyAuth(
  tokens: Authorize,
  oidc: ((token: string, req: Request) => Promise<Access>) | undefined,
): Authorize {
  if (oidc === undefined) return tokens
  return async (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
    return m !== null && m[1]!.split('.').length === 3 ? oidc(m[1]!, req) : tokens(req)
  }
}

/** What jose's refusal of a token says. */
function refusal(err: unknown): Refusal {
  if (err instanceof Refusal) return err
  if (err instanceof errors.JOSEAlgNotAllowed) return new Refusal(401, 'alg is not RS256')
  if (err instanceof errors.JWKSNoMatchingKey) return new Refusal(401, 'unknown signing key')
  if (err instanceof errors.JWSSignatureVerificationFailed) return new Refusal(401, 'bad signature')
  if (err instanceof errors.JWTExpired) return new Refusal(401, 'expired')
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === 'aud') return new Refusal(401, 'wrong audience')
    if (err.claim === 'nbf') return new Refusal(401, 'not yet valid')
  }
  return new Refusal(401, 'not a JWT')
}

async function loadKeys(
  iss: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<ReturnType<typeof createLocalJWKSet>> {
  const config = (await fetchJson(
    `${iss.replace(/\/$/, '')}/.well-known/openid-configuration`,
  )) as {
    jwks_uri?: unknown
  }
  if (typeof config.jwks_uri !== 'string') throw new Error('no jwks_uri')
  const jwks = (await fetchJson(config.jwks_uri)) as { keys?: unknown }
  return createLocalJWKSet({ keys: Array.isArray(jwks.keys) ? jwks.keys : [] })
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}
