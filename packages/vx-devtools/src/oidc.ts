// CI OIDC tokens, the only tokens vx's servers take (@vzn/vx-cache-server,
// @vzn/vx-history-server): a job's token names its repository and the one
// scope it writes, its own branch, never a header or a client option. A
// cache request names its issuer and repository by their hashes (2026-10-25:
// the user names them, no client guesses), which a token must match; a
// history request names them plainly in its body (`oidcTokenAuth`).
// Who may take part is `ALLOW`, the string @vzn/vx-dte-server reads
// (2026-10-26: that string and nothing else): `issuer:owner/repo:workflow`
// entries. `READ_ACCESS=public` lets a request with no token read a
// repository ALLOW names. Any other repository is refused. The JWT itself is
// jose's to check: signature, algorithm, audience and times.

import { hashPart } from './hash-part.js'
import { Refusal } from './refusal.js'
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  errors,
  jwtVerify,
  type JWTPayload,
} from 'jose'

/** One entry of `ALLOW`: the jobs of one workflow file of one repository at one issuer. */
export interface Allowed {
  /** The issuer's URL, `https://token.actions.githubusercontent.com`. */
  readonly issuer: string
  /** `owner/repo` (a GitLab project's full path), matched without case. */
  readonly repository: string
  /** The workflow file its jobs are defined in (`ci.yml`, GitLab's `.gitlab-ci.yml`), matched without case. */
  readonly workflow: string
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
   * GitLab's `project_path`, 2026-10-25), what a checkout's origin names.
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
/** The claim naming the workflow a token's job is defined in, up to the `@` before its ref. */
const workflowClaimOf = (iss: string): string =>
  iss === GITHUB ? 'job_workflow_ref' : 'ci_config_ref_uri'

/**
 * `ALLOW`'s entries, space separated, each
 * `issuer:owner/repo:workflow`, as @vzn/vx-dte-server reads it: read from
 * the right, since the issuer holds `:`s of its own.
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
      // Loopback over plain HTTP too: a server's own tests (its container's)
      // run an issuer beside it, and no one else reaches that address.
      // Its host, not its spelling: `http://127.0.0.1:80@x.example` is x.example.
      const https =
        issuer.startsWith('https://') ||
        (issuer.startsWith('http://') && URL.parse(issuer)?.hostname === '127.0.0.1')
      // An entry missing a part splits elsewhere: its issuer is then no URL.
      const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(issuer)
      if (r < 0 || !url || !repository.includes('/') || workflow === '') {
        throw new Error(`${e} is not issuer:owner/repo:workflow`)
      }
      if (!https)
        throw new Error(
          `${e}: the issuer is https://, not ${issuer} (plain http only on 127.0.0.1)`,
        )
      return { issuer, repository, workflow }
    })
}

/** What `workflowClaimOf(iss)` says, up to the `@` before its ref, for a job of `workflow` in `repository`. */
function workflowPath(iss: string, repository: string, workflow: string): string {
  return iss === GITHUB
    ? `${repository}/.github/workflows/${workflow}`
    : `${iss.replace(/^https?:\/\//, '').replace(/\/$/, '')}/${repository}//${workflow}`
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** GitHub's merge queue ref, `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`. */
const QUEUE = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-\d+-(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * GitHub events that run in the base branch's context on a pull request's
 * behalf (design cache-signing-2026-10.md, "Events"): the token carries the
 * base's `ref` while the job may run the pull request's code, a fork's
 * included, which must never write the base.
 */
const ON_BEHALF = new Set(['pull_request_target', 'issue_comment', 'workflow_run'])

/**
 * The scope a token writes: its `ref`, GitLab's `ref_path`. A GitHub pull
 * request's run writes its merge ref, `refs/pull/<n>/merge`, never its
 * `head_ref`: a fork names that, and no claim tells a fork's from the
 * repository's own, so a fork's branch `release` wrote release. A merge
 * queue's (`merge_group`) run writes its base branch, which its code is
 * about to become (2026-10-25: "just strip it"); only its ref is renamed:
 * anyone can push a branch named like a queue ref. A run of an event in
 * `ON_BEHALF` writes nothing. A GitLab merge request pipeline writes its source branch
 * only when `source_project_path` names its own project: a fork's runs in
 * the parent project with the fork's branch as its `ref_path`, and a
 * GitLab before 19.5 names no source project.
 */
function branchOf(iss: string, claims: JWTPayload): string | undefined {
  if (iss !== GITHUB && claims['pipeline_source'] === 'merge_request_event') {
    const own = (claim: string) => {
      const p = claims[claim]
      return typeof p === 'string' && same(p, String(claims['project_path']))
    }
    if (
      !own('source_project_path') ||
      (claims['job_project_path'] !== undefined && !own('job_project_path'))
    )
      return undefined
  }
  const event = claims['event_name']
  if (ON_BEHALF.has(event as string)) return undefined
  const ref = iss === GITHUB ? claims['ref'] : claims['ref_path']
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.length > 512) return undefined
  const queued = iss === GITHUB && event === 'merge_group' ? QUEUE.exec(ref) : null
  return queued === null ? ref : `refs/heads/${queued[1]}`
}

export interface OidcOptions {
  /** `ALLOW` (`parseAllow`): who may take part. */
  readonly allow: readonly Allowed[]
  /** The `aud` a token must name; unset, the origin the server is reached at. */
  readonly audience?: string
  /** Reads a URL as JSON; tests serve keys without a network. */
  readonly fetchJson?: (url: string) => Promise<unknown>
  /** Seconds since the epoch; tests move the clock. */
  readonly now?: () => number
  /** `READ_ACCESS`: `public` lets a request with no token read a repository ALLOW names. */
  readonly readAccess?: string | undefined
}

/** Clock skew a token's `exp` / `nbf` may be off by. */
const LEEWAY_S = 60

/** The `Access` a request's verified CI token has; a refused one throws a 401 or 403. */
export function oidcAuth(opts: OidcOptions): Authorize {
  const open = readAccessOf(opts)
  // The repositories ALLOW names, by their hashes: what a public read may name.
  let named: Promise<Map<string, Access>> | undefined
  const allowed = () =>
    (named ??= Promise.all(
      opts.allow.map(async (a) => {
        const repo = { issuer: issuerOf(a.issuer), repository: a.repository.toLowerCase() }
        return [`${await hashPart(repo.issuer)}/${await hashPart(repo.repository)}`, repo] as [
          string,
          Access,
        ]
      }),
    ).then((pairs) => new Map(pairs)))
  const verify = tokenVerifier(opts)

  return async (req) => {
    if (opts.allow.length === 0)
      throw new Refusal(401, 'ALLOW is empty: set it to the CI workflows this server serves')
    const asked = `${req.headers.get(ISSUER_HEADER)}/${req.headers.get(REPOSITORY_HEADER)}`
    if (!asked.split('/').every((p) => PART.test(p)))
      throw new Refusal(
        400,
        `${ISSUER_HEADER} and ${REPOSITORY_HEADER}: the issuer's and the repository's hashes (PROTOCOL.md § Keys)`,
      )
    const bearer = bearerOf(req)
    if (bearer === undefined) {
      if (!open) throw new Refusal(401, 'no bearer token')
      const repo = (await allowed()).get(asked)
      if (repo === undefined)
        throw new Refusal(403, "the repository named is not in this server's ALLOW")
      return repo
    }
    const access = await verify(bearer, req)
    if (`${await hashPart(access.issuer)}/${await hashPart(access.repository)}` !== asked)
      throw new Refusal(
        403,
        `the token is of ${repoClaimOf(access.issuer)} ${access.repository} at ${access.issuer}, not the repository named`,
      )
    return access
  }
}

/** A repository as a request names it plainly: the issuer's URL and `org/name` there. */
export interface Repo {
  readonly issuer: string
  readonly repository: string
}

/**
 * A server whose requests name their repository plainly, in the body
 * (@vzn/vx-history-server). A token must be of `named`, when one is named;
 * with no token, `READ_ACCESS=public` reads a repository ALLOW names, and
 * answers `undefined` where none is named. Else a 401 or 403.
 */
export function oidcTokenAuth(
  opts: OidcOptions,
): (req: Request, named?: Repo) => Promise<Access | undefined> {
  const open = readAccessOf(opts)
  const check = tokenVerifier(opts)
  // A request is asked twice, before its body names the repository and
  // after: its token is verified once.
  const verified = new WeakMap<Request, Promise<Access>>()
  const verify = (token: string, req: Request): Promise<Access> => {
    let got = verified.get(req)
    if (got === undefined) verified.set(req, (got = check(token, req)))
    return got
  }
  return async (req, asked) => {
    if (opts.allow.length === 0)
      throw new Refusal(401, 'ALLOW is empty: set it to the CI workflows this server serves')
    const named = asked === undefined ? undefined : repoOf(asked)
    const bearer = bearerOf(req)
    if (bearer === undefined) {
      if (!open) throw new Refusal(401, 'no bearer token')
      if (named === undefined) return undefined
      if (
        !opts.allow.some(
          (a) => issuerOf(a.issuer) === named.issuer && same(a.repository, named.repository),
        )
      )
        throw new Refusal(403, `${named.repository} is not in this server's ALLOW`)
      return named
    }
    const access = await verify(bearer, req)
    if (
      named !== undefined &&
      (access.issuer !== named.issuer || access.repository !== named.repository)
    )
      throw new Refusal(
        403,
        `the token is of ${access.repository} at ${access.issuer}, not ${named.repository} at ${named.issuer}`,
      )
    return access
  }
}

/** A named repository as a token names it: the issuer's URL with no trailing slash, `org/name` lowercased. */
const repoOf = (r: Repo): Repo => ({
  issuer: issuerOf(r.issuer),
  repository: r.repository.toLowerCase(),
})

function readAccessOf(opts: OidcOptions): boolean {
  const given: unknown = opts.readAccess
  // A Worker var may be JSON: a list was refused "not public".
  if (given !== undefined && given !== '' && given !== 'public')
    throw new Error(
      `READ_ACCESS: public, or unset, not ${typeof given === 'string' ? given : JSON.stringify(given)}`,
    )
  return opts.readAccess === 'public'
}

const bearerOf = (req: Request): string | undefined =>
  /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]

/** A token checked: jose's checks, then ALLOW's repository and workflow, and the branch it may write. */
function tokenVerifier(opts: OidcOptions): (token: string, req: Request) => Promise<Access> {
  // A blank one is no origin a token names: every token was "wrong audience".
  if (opts.audience !== undefined && opts.audience.trim() === '')
    throw new Error('AUDIENCE: the aud CI tokens name, or unset, not blank')
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
      // quiet: the awaited set rethrows it; this only forgets it
      set.catch(() => keys.get(iss) === set && keys.delete(iss))
    }
    // The issuer's outage, not the token's fault: a 401 tells a client its
    // token is refused, and vx-cache turns the remote off for the run.
    return set.catch((err: unknown) => {
      throw keysUnread(iss, err)
    })
  }

  return async (token, req) => {
    let said: unknown
    try {
      said = decodeJwt(token).iss
    } catch {
      throw new Refusal(401, 'not a JWT')
    }
    // A trailing slash is no other issuer, as a key and a tokenless read
    // name it: one in ALLOW or in the token refused every token.
    const iss = typeof said === 'string' ? issuerOf(said) : undefined
    if (iss === undefined || !opts.allow.some((a) => issuerOf(a.issuer) === iss)) {
      throw new Refusal(
        401,
        typeof said === 'string'
          ? `issuer ${said.slice(0, 200)} is not in this server's ALLOW: add issuer:owner/repo:workflow for it`
          : 'the token names no issuer (iss)',
      )
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
      throw refusal(err, iss, audience)
    }
    const claim = repoClaimOf(iss)
    const named = claims[claim]
    if (typeof named !== 'string') throw new Refusal(403, `no ${claim} claim`)
    // GitHub and GitLab names ignore case; a checkout's origin may spell it either way.
    const repository = named.toLowerCase()
    const ofRepo = opts.allow.filter(
      (a) => issuerOf(a.issuer) === iss && same(a.repository, repository),
    )
    if (ofRepo.length === 0)
      throw new Refusal(403, `${claim} ${repository} is not in this server's ALLOW`)
    const wclaim = workflowClaimOf(iss)
    const ran = claims[wclaim]
    if (typeof ran !== 'string') throw new Refusal(403, `no ${wclaim} claim`)
    // Cut at the `@` before the ref: GitLab's CI file may itself hold one
    // (`.gitlab-ci.yml@group/project`, a file kept in another project).
    const workflow = ran.replace(/@(?:refs\/.*)?$/, '')
    if (!ofRepo.some((a) => same(workflow, workflowPath(iss, a.repository, a.workflow))))
      throw new Refusal(403, `${wclaim} ${workflow} is not in this server's ALLOW`)
    const repo = { issuer: iss, repository }
    const branch = branchOf(iss, claims)
    return branch === undefined ? repo : { ...repo, write: branch }
  }
}

/** An issuer as a key names it: its URL, no trailing slash. */
const issuerOf = (iss: string): string => iss.replace(/\/$/, '')

/** What jose's refusal of a token says. */
function refusal(err: unknown, iss: string, audience: string): Refusal {
  if (err instanceof Refusal) return err
  // A refetch of the keys for a kid not held failed, or the issuer served
  // no key set: the issuer, not the token. A broken set read "not a JWT".
  if (
    !(err instanceof errors.JOSEError) ||
    err instanceof errors.JWKSTimeout ||
    err instanceof errors.JWKSInvalid
  )
    return keysUnread(iss, err)
  if (err instanceof errors.JOSEAlgNotAllowed) return new Refusal(401, 'alg is not RS256')
  if (err instanceof errors.JWKSNoMatchingKey) return new Refusal(401, 'unknown signing key')
  if (err instanceof errors.JWSSignatureVerificationFailed) return new Refusal(401, 'bad signature')
  if (err instanceof errors.JWTExpired) return new Refusal(401, 'expired')
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === 'aud')
      return new Refusal(
        401,
        `the token's aud is ${audOf(err.payload)}, not this server's ${audience}: ask CI for a token for ${audience}, or set the server's AUDIENCE`,
      )
    if (err.claim === 'nbf') return new Refusal(401, 'not yet valid')
    if (err.reason === 'missing') return new Refusal(401, `no ${err.claim} claim`)
  }
  return new Refusal(401, 'not a JWT')
}

/** A token's `aud`, as a refusal names it: "wrong audience" alone left the fix to a guess. */
const audOf = (claims: JWTPayload): string => [claims.aud ?? 'unset'].flat().join(', ')
/** The issuer's keys out of reach, with why: a 503 and a missing jwks_uri read the same. */
const keysUnread = (iss: string, err: unknown): Refusal =>
  new Refusal(
    502,
    `could not read ${iss}'s keys: ${err instanceof Error ? err.message : String(err)}`,
  )

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}
