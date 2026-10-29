// CI OIDC tokens: RS256 JWTs a relay checks against each trusted issuer's
// published keys. The run claims bind every participant to the repository
// that started the run (PROTOCOL.md § Tokens). The JWT itself is jose's
// to check: signature, algorithm, audience and times.

import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from 'jose'

/**
 * Who may take part: jobs of `workflow` in `repository`, by tokens of
 * `issuer`. Unset parts admit any (`@vzn/vx-dte` checks a repository by its
 * run claim); the relay's own entry points take all three (`parseAllow`).
 */
export interface Allowed {
  /** The full issuer URL, e.g. `https://token.actions.githubusercontent.com`. */
  issuer: string
  /** `owner/repo` (a GitLab project's full path), matched without case against `repositoryClaimOf(iss)`. */
  repository?: string
  /**
   * The workflow file its jobs are defined in, any ref, matched without case
   * against `workflowClaimOf(iss)`: on GitHub a file of `.github/workflows/`
   * (`ci.yml`), on GitLab the CI config's path (`.gitlab-ci.yml`).
   */
  workflow?: string
}

export interface OidcOptions {
  /** Whose tokens the relay takes; any other is refused. */
  allow: readonly Allowed[]
  /** The `aud` a token must name. */
  audience: string
  /** Run claims by issuer; an issuer not named here uses `runClaimsOf`. */
  runClaims?: Readonly<Record<string, readonly string[]>>
  /**
   * Reads a URL as JSON; tests serve keys without a network. `fresh`: a
   * token named a key the last read did not have, so a cached copy will not do.
   */
  fetchJson?: (url: string, fresh: boolean) => Promise<unknown>
  /** Seconds since the epoch; tests move the clock. */
  now?: () => number
}

/** A token the relay accepted: its issuer and the values of its run claims. */
export interface VerifiedToken {
  iss: string
  run: readonly string[]
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 502,
  ) {
    super(message)
  }
}

const GITHUB = 'https://token.actions.githubusercontent.com'

/**
 * The claims a run binds: its repository, GitHub's or GitLab's. Not the
 * pipeline: workers run in another one (a GitLab pipeline the run triggers,
 * a GitHub workflow it dispatches), and the run's own key admits them.
 */
export function runClaimsOf(iss: string): readonly string[] {
  return iss === GITHUB ? ['repository_id'] : ['project_id']
}

/**
 * The claim naming a token's repository: `owner/repo` on GitHub, the
 * project's full path on GitLab.
 */
export function repositoryClaimOf(iss: string): string {
  return iss === GITHUB ? 'repository' : 'project_path'
}

/**
 * The claim naming the workflow a token's job is defined in, `<path>@<ref>`:
 * GitHub's `job_workflow_ref` (the reusable workflow, when the job is one),
 * GitLab's `ci_config_ref_uri`.
 */
export function workflowClaimOf(iss: string): string {
  return iss === GITHUB ? 'job_workflow_ref' : 'ci_config_ref_uri'
}

/**
 * `ALLOW`'s entries, space separated, each
 * `issuer:owner/repo:workflow`: read from the right, since the issuer
 * holds `:`s of its own.
 */
export function parseAllow(list: string): Allowed[] {
  return list
    .split(/\s+/)
    .filter((e) => e !== '')
    .map((e) => {
      // One grammar on every server: read as a separator nowhere, a comma
      // would end up inside a workflow name no token ever carries.
      if (e.includes(','))
        throw new Error(`${e} is not issuer:owner/repo:workflow: entries are space separated`)
      const w = e.lastIndexOf(':')
      const r = e.lastIndexOf(':', w - 1)
      const [issuer, repository, workflow] = [e.slice(0, r), e.slice(r + 1, w), e.slice(w + 1)]
      if (r < 0 || !issuer.startsWith('https://') || !repository.includes('/') || workflow === '') {
        throw new Error(`${e} is not issuer:owner/repo:workflow`)
      }
      return { issuer, repository, workflow }
    })
}

/** What `workflowClaimOf(iss)` says, up to its `@`, for a job of `workflow` in `repository`. */
function workflowPath(iss: string, repository: string, workflow: string): string {
  return iss === GITHUB
    ? `${repository}/.github/workflows/${workflow}`
    : `${iss.replace(/^https:\/\//, '').replace(/\/$/, '')}/${repository}//${workflow}`
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Clock skew a token's `exp` / `nbf` may be off by. */
const LEEWAY_S = 60
/** An RS256 signature: at least a 2048-bit key's 256 bytes, base64url. */
const SIGNATURE = /^[\w-]{342,}$/

/** An unknown `kid` refetches an issuer's keys at most this often. */
const REFETCH_MS = 60_000
/**
 * Keys read longer ago than this are read again: a key the issuer withdrew
 * stops signing for the relay, as jose's remote key set ages them for the
 * cache and history servers.
 */
const KEYS_MAX_AGE_MS = 600_000

export function createVerifier(opts: OidcOptions): (token: string) => Promise<VerifiedToken> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson
  const now = opts.now ?? (() => Date.now() / 1000)
  const nowMs = () => now() * 1000
  type KeySet = ReturnType<typeof createLocalJWKSet>
  const keys = new Map<string, { at: number; set: Promise<KeySet> }>()

  const load = (iss: string, fresh: boolean): { at: number; set: Promise<KeySet> } => {
    const entry = { at: nowMs(), set: loadKeys(iss, (url) => fetchJson(url, fresh)) }
    keys.set(iss, entry)
    // A failed load is not kept: the next token tries again.
    // quiet: the awaited set rethrows it; this only forgets it
    entry.set.catch(() => keys.get(iss) === entry && keys.delete(iss))
    return entry
  }
  const verifyWith = async (token: string, iss: string, fresh: boolean): Promise<JWTPayload> => {
    const held = fresh ? undefined : keys.get(iss)
    const entry =
      held !== undefined && nowMs() - held.at < KEYS_MAX_AGE_MS ? held : load(iss, fresh)
    // The issuer's outage, not the token's fault: a client ends its run on
    // a 401, and retries a 5xx.
    const set = await entry.set.catch((err: unknown) => {
      throw keysUnread(iss, err)
    })
    const { payload } = await jwtVerify(token, set, {
      algorithms: ['RS256'],
      audience: opts.audience,
      clockTolerance: LEEWAY_S,
      currentDate: new Date(now() * 1000),
      requiredClaims: ['exp'],
    })
    return payload
  }

  return async (token) => {
    let iss: unknown
    let alg: unknown
    try {
      iss = decodeJwt(token).iss
      // decodeJwt reads no header: one that does not decode threw out of the relay (a 500).
      alg = decodeProtectedHeader(token).alg
      // A token that cannot be signed costs no fetch of its issuer's keys.
      if (!SIGNATURE.test(token.slice(token.lastIndexOf('.') + 1))) throw new Error()
    } catch {
      throw new TokenError('not a JWT', 401)
    }
    if (alg !== 'RS256') throw new TokenError('alg is not RS256', 401)
    const ofIssuer = opts.allow.filter((a) => a.issuer === iss)
    if (typeof iss !== 'string' || ofIssuer.length === 0) {
      throw new TokenError('untrusted issuer', 401)
    }
    let claims: JWTPayload
    try {
      // A key rotated in since the last read is fetched once a REFETCH_MS.
      claims = await verifyWith(token, iss, false).catch((err: unknown) => {
        const at = keys.get(iss)?.at ?? 0
        if (!(err instanceof errors.JWKSNoMatchingKey) || nowMs() - at < REFETCH_MS) throw err
        return verifyWith(token, iss, true)
      })
    } catch (err) {
      throw refusal(err, iss)
    }
    let ofRepo = ofIssuer
    if (ofIssuer.some((a) => a.repository !== undefined)) {
      const claim = repositoryClaimOf(iss)
      const repo = claims[claim]
      if (typeof repo !== 'string') throw new TokenError(`no ${claim} claim`, 403)
      ofRepo = ofIssuer.filter((a) => a.repository === undefined || same(a.repository, repo))
      if (ofRepo.length === 0) {
        throw new TokenError(`repository ${repo} is not in this relay's ALLOW`, 403)
      }
    }
    if (ofRepo.every((a) => a.workflow !== undefined)) {
      const claim = workflowClaimOf(iss)
      const ref = claims[claim]
      if (typeof ref !== 'string') throw new TokenError(`no ${claim} claim`, 403)
      const workflow = ref.replace(/@.*$/, '')
      const repo = String(claims[repositoryClaimOf(iss)])
      if (
        !ofRepo.some((a) => same(workflow, workflowPath(iss, a.repository ?? repo, a.workflow!)))
      ) {
        throw new TokenError(`workflow ${workflow} is not in this relay's ALLOW`, 403)
      }
    }
    const run = (opts.runClaims?.[iss] ?? runClaimsOf(iss)).map((c) => {
      const v = claims[c]
      if (typeof v !== 'string' && typeof v !== 'number') {
        throw new TokenError(`no ${c} claim`, 403)
      }
      return String(v)
    })
    return { iss, run }
  }
}

/** What jose's refusal of a token says, as the relay answers it. */
function refusal(err: unknown, iss: string): TokenError {
  if (err instanceof TokenError) return err
  // A refetch of the keys for a kid not held failed: the network, not the token.
  if (!(err instanceof errors.JOSEError) || err instanceof errors.JWKSInvalid)
    return keysUnread(iss, err)
  if (err instanceof errors.JOSEAlgNotAllowed) return new TokenError('alg is not RS256', 401)
  if (err instanceof errors.JWKSNoMatchingKey) return new TokenError('unknown signing key', 401)
  if (err instanceof errors.JWSSignatureVerificationFailed)
    return new TokenError('bad signature', 401)
  if (err instanceof errors.JWTExpired) return new TokenError('expired', 401)
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === 'aud') return new TokenError('wrong audience', 401)
    if (err.claim === 'nbf') return new TokenError('not yet valid', 401)
    if (err.claim === 'exp') return new TokenError('expired', 401)
  }
  return new TokenError('not a JWT', 401)
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

/** The issuer's keys out of reach, with why: a 503 and a missing jwks_uri read the same. */
const keysUnread = (iss: string, err: unknown): TokenError =>
  new TokenError(
    `could not read ${iss}'s keys: ${err instanceof Error ? err.message : String(err)}`,
    502,
  )

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}
