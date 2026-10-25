// CI OIDC tokens, the only tokens vx's servers take (@vzn/vx-cache-server,
// @vzn/vx-history-server): a job's token names its repository and decides
// where it writes, never a header or a client option. A token of a repository that
// `TRUST` names matching one of its rules writes the trusted scope; any
// other of that repository writes its own branch's; any other repository
// is refused. The JWT itself is jose's to check: signature, algorithm,
// audience and times.

import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  errors,
  jwtVerify,
  type JWTPayload,
} from 'jose'

/** A request refused: its HTTP status and what to fix. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** The scope a token matching a trust rule writes, and every read walks last. */
export const TRUSTED = 'trusted'

/**
 * One rule of `TRUST`: the issuer, the repository's id claim
 * (`repository_id` on GitHub, `project_id` elsewhere), and any other
 * claims a trusted job's token holds, each a string (`*` matches any run
 * of characters) or a list of them.
 */
export interface TrustRule {
  readonly iss: string
  readonly [claim: string]: string | readonly string[]
}

/** What a request may do: its repository's data, and write to `write` when set. */
export interface Access {
  /** The repository's id claim: every row and blob lives under it. */
  readonly repo: string
  readonly write?: string
  /** Whether `ref` is one a trust rule of the repository names: a read of it reads trusted. */
  readonly trustedRef: (ref: string) => boolean
}

export type Authorize = (req: Request) => Promise<Access>

const GITHUB = 'https://token.actions.githubusercontent.com'

/** The claim naming a token's repository by an id that a rename keeps. */
const repoClaimOf = (iss: string): string => (iss === GITHUB ? 'repository_id' : 'project_id')
/** The claim naming the ref a token's job runs on. */
const refClaimOf = (iss: string): string => (iss === GITHUB ? 'ref' : 'ref_path')

/** `TRUST`: a JSON list of rules, each with `iss` and its repository id claim. */
export function parseTrust(json: string): TrustRule[] {
  if (json.trim() === '') return []
  const rules: unknown = JSON.parse(json)
  if (!Array.isArray(rules)) throw new Error('not a JSON list of rules')
  const parsed = rules.map((r: unknown, i) => {
    const at = `rule ${i}`
    if (typeof r !== 'object' || r === null || Array.isArray(r))
      throw new Error(`${at}: not an object`)
    const rule = r as Record<string, unknown>
    for (const [claim, v] of Object.entries(rule)) {
      const ok =
        typeof v === 'string' ||
        (claim !== 'iss' &&
          Array.isArray(v) &&
          v.length > 0 &&
          v.every((x) => typeof x === 'string'))
      if (!ok)
        throw new Error(
          `${at}: ${claim} is not a string${claim === 'iss' ? '' : ' or a list of them'}`,
        )
    }
    // Loopback over plain HTTP too: a server's own tests (its container's)
    // run an issuer beside it, and no one else reaches that address.
    if (
      typeof rule['iss'] !== 'string' ||
      !/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(rule['iss'])
    ) {
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
  // A repository's rows live under its id alone: two issuers' repositories
  // of one id would read each other's.
  for (const a of parsed) {
    const other = parsed.find(
      (b) => b.iss !== a.iss && b[repoClaimOf(b.iss)] === a[repoClaimOf(a.iss)],
    )
    if (other !== undefined) {
      throw new Error(
        `${a.iss} and ${other.iss} both name repository ${String(a[repoClaimOf(a.iss)])}`,
      )
    }
  }
  return parsed
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

/** The `Access` a request's verified CI token has; a refused one throws a 401 or 403. */
export function oidcAuth(opts: OidcOptions): Authorize {
  const fetchJson = opts.fetchJson ?? defaultFetchJson
  const now = opts.now ?? (() => Date.now() / 1000)
  // jose keeps each issuer's keys, and refetches them for a key it lacks.
  const keys = new Map<string, Promise<ReturnType<typeof createRemoteJWKSet>>>()
  const keysOf = (iss: string) => {
    let set = keys.get(iss)
    if (set === undefined) {
      set = fetchJson(`${iss.replace(/\/$/, '')}/.well-known/openid-configuration`).then((c) => {
        const uri = (c as { jwks_uri?: unknown }).jwks_uri
        if (typeof uri !== 'string') throw new Error('no jwks_uri')
        return createRemoteJWKSet(new URL(uri), {
          [customFetch]: async (url: string) => Response.json(await fetchJson(url)),
        })
      })
      keys.set(iss, set)
      // A failed discovery is not kept: the next token tries again.
      set.catch(() => keys.get(iss) === set && keys.delete(iss))
    }
    return set.catch(() => {
      throw new Refusal(401, `could not read ${iss}'s keys`)
    })
  }

  return async (req) => {
    if (opts.trust.length === 0) throw new Refusal(401, 'the server trusts no CI: set TRUST')
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
    if (bearer === null) throw new Refusal(401, 'no bearer token')
    const token = bearer[1]!
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
      claims = (
        await jwtVerify(token, await keysOf(iss), {
          algorithms: ['RS256'],
          audience,
          clockTolerance: LEEWAY_S,
          currentDate: new Date(now() * 1000),
          requiredClaims: ['exp'],
        })
      ).payload
    } catch (err) {
      throw refusal(err)
    }
    const id = repoClaimOf(iss)
    const repo = String(claims[id])
    const ofRepo = opts.trust.filter((r) => r.iss === iss && r[id] === repo)
    if (ofRepo.length === 0) throw new Refusal(403, `${id} ${repo} is not in this server's TRUST`)
    const trusted = ofRepo.find((r) => matches(r, claims))
    // A trusted ref is read as trusted, and is never an untrusted token's
    // scope: what main reads, only a trusted job writes.
    const refClaim = refClaimOf(iss)
    const trustedRef = (ref: string): boolean =>
      ofRepo.some((r) => {
        const want = r[refClaim]!
        return (typeof want === 'string' ? [want] : want).some((w) => globOf(w).test(ref))
      })
    if (trusted !== undefined) return { repo, write: TRUSTED, trustedRef }
    const branch = branchOf(iss, claims)
    return branch === undefined || trustedRef(branch)
      ? { repo, trustedRef }
      : { repo, write: branch, trustedRef }
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

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}
