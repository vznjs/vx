// CI OIDC tokens, the only tokens vx's servers take (@vzn/vx-cache-server,
// @vzn/vx-history-server): a job's token names its repository and the one
// scope it writes, its own ref, never a header or a client option. Every
// request names its issuer and repository by their hashes (M, 2026-10-25:
// the user names them, no client guesses), which a token must match;
// `READ_ACCESS=public` lets a request with no token read one TRUST names. The
// servers know no tier (M, 2026-10-25): a scope is an opaque ref. A ref a
// `TRUST` rule names is protected: only a token matching a rule writes it,
// so a pull request never writes main's. Any other repository is refused.
// The JWT itself is jose's to check: signature, algorithm, audience and
// times.

import { hashPart } from './hash-part.js'
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

/**
 * One rule of `TRUST`: the issuer, the repository's name claim
 * (`repository` on GitHub, `project_path` elsewhere), and the other
 * claims a job's token must hold to write the refs the rule names, each a
 * string (`*` matches any run of characters) or a list of them.
 */
export interface TrustRule {
  readonly iss: string
  readonly [claim: string]: string | readonly string[]
}

/** What a request may do: read its repository's scopes, and write `write` when set. */
export interface Access {
  /**
   * The issuer, as its tokens name it (`https://token.actions.githubusercontent.com`):
   * it signs the token, so two platforms' repositories never meet.
   */
  readonly issuer: string
  /**
   * The repository at that issuer, lowercased: `org/name` (`repository`,
   * GitLab's `project_path`, M 2026-10-25), what a checkout's origin names.
   */
  readonly repository: string
  /** The token's own ref: the one scope it writes. */
  readonly write?: string
}

export type Authorize = (req: Request) => Promise<Access>

const GITHUB = 'https://token.actions.githubusercontent.com'

/** The headers naming a request's issuer and repository, each its `hashPart`. */
const ISSUER_HEADER = 'vx-issuer'
const REPOSITORY_HEADER = 'vx-repository'
const PART = /^[0-9a-f]{32}$/

/** The claim naming a token's repository, `org/name`. */
const repoClaimOf = (iss: string): string => (iss === GITHUB ? 'repository' : 'project_path')
/** The claim naming the ref a token's job runs on. */
const refClaimOf = (iss: string): string => (iss === GITHUB ? 'ref' : 'ref_path')

/** `TRUST`: a JSON list of rules, each with `iss` and its repository name claim. */
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
    // The refs a rule names are the ones only a matching token writes.
    if (rule[refClaimOf(rule['iss'])] === undefined) {
      throw new Error(`${at}: names no ${refClaimOf(rule['iss'])} (the refs it protects)`)
    }
    return rule as TrustRule
  })
  return parsed
}

const globOf = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  )

/** Whether every other claim a rule names holds one of its values (the repository is matched before). */
function matches(rule: TrustRule, claims: JWTPayload): boolean {
  for (const [claim, want] of Object.entries(rule)) {
    if (claim === repoClaimOf(rule.iss)) continue
    const v = claims[claim]
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return false
    const got = String(v)
    if (!(typeof want === 'string' ? [want] : want).some((w) => globOf(w).test(got))) return false
  }
  return true
}

/** GitHub's merge queue ref, `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`. */
const QUEUE = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-\d+-(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * The scope a token writes: its branch. A GitHub pull request's run writes
 * its head branch (its `ref` is the merge ref the run's own reads never
 * name); a merge queue's run its base branch, which its code is about to
 * become (M, 2026-10-25: "just strip it"); any other run its `ref`,
 * GitLab's its `ref_path`. Only a `pull_request` run takes its head
 * branch: a `pull_request_target` run's `head_ref` is a fork's branch name,
 * chosen by the fork, so it writes its `ref` (the base, protected) instead.
 */
function branchOf(iss: string, claims: JWTPayload): string | undefined {
  const head = claims['event_name'] === 'pull_request' ? claims['head_ref'] : undefined
  const ref =
    iss === GITHUB
      ? typeof head === 'string' && head !== ''
        ? `refs/heads/${head}`
        : claims['ref']
      : claims['ref_path']
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.length > 512) return undefined
  const queued = iss === GITHUB ? QUEUE.exec(ref) : null
  return queued === null ? ref : `refs/heads/${queued[1]}`
}

export interface OidcOptions {
  readonly trust: readonly TrustRule[]
  /** The `aud` a token must name; unset, the origin the server is reached at. */
  readonly audience?: string
  /** Reads a URL as JSON; tests serve keys without a network. */
  readonly fetchJson?: (url: string) => Promise<unknown>
  /** Seconds since the epoch; tests move the clock. */
  readonly now?: () => number
  /** `READ_ACCESS`: `public` lets a request with no token read a repository TRUST names. */
  readonly readAccess?: string | undefined
}

/** Clock skew a token's `exp` / `nbf` may be off by. */
const LEEWAY_S = 60

/** The `Access` a request's verified CI token has; a refused one throws a 401 or 403. */
export function oidcAuth(opts: OidcOptions): Authorize {
  if (opts.readAccess !== undefined && opts.readAccess !== '' && opts.readAccess !== 'public')
    throw new Error(`READ_ACCESS: public, or unset, not ${opts.readAccess}`)
  const open = opts.readAccess === 'public'
  // The repositories TRUST names, by their hashes: what a public read may name.
  let named: Promise<Map<string, Access>> | undefined
  const trusted = () =>
    (named ??= Promise.all(
      opts.trust.map(async (r) => {
        const repo = {
          issuer: issuerOf(r.iss),
          repository: String(r[repoClaimOf(r.iss)]).toLowerCase(),
        }
        return [`${await hashPart(repo.issuer)}/${await hashPart(repo.repository)}`, repo] as [
          string,
          Access,
        ]
      }),
    ).then((pairs) => new Map(pairs)))
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
    // The issuer's outage, not the token's fault: a 401 tells a client its
    // token is refused, and vx-cache turns the remote off for the run.
    return set.catch(() => {
      throw new Refusal(502, `could not read ${iss}'s keys`)
    })
  }

  return async (req) => {
    if (opts.trust.length === 0) throw new Refusal(401, 'the server trusts no CI: set TRUST')
    const asked = `${req.headers.get(ISSUER_HEADER)}/${req.headers.get(REPOSITORY_HEADER)}`
    if (!asked.split('/').every((p) => PART.test(p)))
      throw new Refusal(
        400,
        `${ISSUER_HEADER} and ${REPOSITORY_HEADER}: the issuer's and the repository's hashes (PROTOCOL.md § Keys)`,
      )
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
    if (bearer === null) {
      if (!open) throw new Refusal(401, 'no bearer token')
      const repo = (await trusted()).get(asked)
      if (repo === undefined)
        throw new Refusal(403, "the repository named is not in this server's TRUST")
      return repo
    }
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
      throw refusal(err, iss)
    }
    const claim = repoClaimOf(iss)
    // GitHub and GitLab names ignore case; a checkout's origin may spell it either way.
    const repository = String(claims[claim]).toLowerCase()
    const ofRepo = opts.trust.filter(
      (r) => r.iss === iss && String(r[claim]).toLowerCase() === repository,
    )
    if (ofRepo.length === 0)
      throw new Refusal(403, `${claim} ${repository} is not in this server's TRUST`)
    const repo = { issuer: issuerOf(iss), repository }
    if (`${await hashPart(repo.issuer)}/${await hashPart(repository)}` !== asked)
      throw new Refusal(
        403,
        `the token is of ${claim} ${repository} at ${repo.issuer}, not the repository named`,
      )
    const branch = branchOf(iss, claims)
    if (branch === undefined) return repo
    if (ofRepo.some((r) => matches(r, claims))) return { ...repo, write: branch }
    const refClaim = refClaimOf(iss)
    const isProtected = ofRepo.some((r) => {
      const want = r[refClaim]!
      return (typeof want === 'string' ? [want] : want).some((w) => globOf(w).test(branch))
    })
    return isProtected ? repo : { ...repo, write: branch }
  }
}

/** An issuer as a key names it: its URL, no trailing slash. */
const issuerOf = (iss: string): string => iss.replace(/\/$/, '')

/** What jose's refusal of a token says. */
function refusal(err: unknown, iss: string): Refusal {
  if (err instanceof Refusal) return err
  // A refetch of the keys for a kid not held failed: the network, not the token.
  if (!(err instanceof errors.JOSEError) || err instanceof errors.JWKSTimeout)
    return new Refusal(502, `could not read ${iss}'s keys`)
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
