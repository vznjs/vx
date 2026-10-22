// CI OIDC tokens: RS256 JWTs a relay checks against each trusted issuer's
// published keys. The run claims bind every participant to the repository
// that started the run (PROTOCOL.md § Tokens).

export interface OidcOptions {
  /** Issuers whose tokens the relay trusts, e.g. `https://gitlab.com`. */
  issuers: readonly string[]
  /** The `aud` a token must name. */
  audience: string
  /**
   * The repositories whose runs the relay carries, as `owner/repo` (a GitLab
   * project's full path): a token of any other is refused. Matched without
   * case against `repositoryClaimOf(iss)`. Unset, no name is checked: the
   * relay's own entry points require it.
   */
  repositories?: readonly string[]
  /**
   * The workflows whose jobs may take part, as `owner/repo/.github/workflows/ci.yml`
   * (GitLab: `gitlab.com/group/project//.gitlab-ci.yml`), any ref. Matched
   * without case against `workflowClaimOf(iss)` up to its `@`. Unset, any
   * workflow of a named repository.
   */
  workflows?: readonly string[]
  /** Run claims by issuer; an issuer not named here uses `runClaimsOf`. */
  runClaims?: Readonly<Record<string, readonly string[]>>
  /** Reads a URL as JSON; tests serve keys without a network. */
  fetchJson?: (url: string) => Promise<unknown>
  /** Seconds since the epoch; tests move the clock. */
  now?: () => number
}

/** A token the relay accepted: its issuer and the values of its run claims. */
export interface VerifiedToken {
  iss: string
  run: readonly string[]
  /** The CI job it is from (`jobClaimsOf`), when it names one: a run's orchestrator is pinned to it. */
  job?: string
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message)
  }
}

const GITHUB = 'https://token.actions.githubusercontent.com'

/**
 * The claims a run binds: its repository, GitHub's or GitLab's. Not the
 * pipeline: agents run in another one (a GitLab child pipeline, a GitHub
 * workflow the run dispatches), and the run's own key admits them.
 */
export function runClaimsOf(iss: string): readonly string[] {
  return iss === GITHUB ? ['repository_id'] : ['project_id']
}

/**
 * The claims naming the CI job a token is from, the first set a token
 * carries: GitHub's job (`check_run_id`; a host without it, the workflow
 * run and attempt, which its other jobs share), GitLab's job.
 */
function jobClaimsOf(iss: string): readonly (readonly string[])[] {
  return iss === GITHUB ? [['check_run_id'], ['run_id', 'run_attempt']] : [['job_id']]
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

/** Clock skew a token's `exp` / `nbf` may be off by. */
const LEEWAY_S = 60

/** An unknown `kid` refetches an issuer's keys at most this often. */
const REFETCH_MS = 60_000

export function createVerifier(opts: OidcOptions): (token: string) => Promise<VerifiedToken> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson
  const now = opts.now ?? (() => Date.now() / 1000)
  const repositories =
    opts.repositories === undefined
      ? undefined
      : new Set(opts.repositories.map((r) => r.toLowerCase()))
  const workflows =
    opts.workflows === undefined || opts.workflows.length === 0
      ? undefined
      : new Set(opts.workflows.map((w) => w.toLowerCase()))
  const keys = new Map<string, { at: number; byKid: Promise<Map<string, CryptoKey>> }>()

  const load = (iss: string): { at: number; byKid: Promise<Map<string, CryptoKey>> } => {
    const entry = { at: Date.now(), byKid: loadKeys(iss, fetchJson) }
    keys.set(iss, entry)
    // A failed load is not kept: the next token tries again.
    entry.byKid.catch(() => keys.get(iss) === entry && keys.delete(iss))
    return entry
  }
  // A key rotated in since the last read is fetched once a REFETCH_MS.
  const keyOf = async (iss: string, kid: string): Promise<CryptoKey | undefined> => {
    const entry = keys.get(iss) ?? load(iss)
    const byKid = await entry.byKid
    if (byKid.has(kid) || Date.now() - entry.at < REFETCH_MS) return byKid.get(kid)
    return (await load(iss).byKid).get(kid)
  }

  return async (token) => {
    const parts = token.split('.')
    if (parts.length !== 3) throw new TokenError('not a JWT', 401)
    const [h, p, s] = parts as [string, string, string]
    let header: { alg?: unknown; kid?: unknown }
    let claims: Record<string, unknown>
    let sig: Uint8Array<ArrayBuffer>
    try {
      header = JSON.parse(text(h))
      claims = JSON.parse(text(p))
      sig = bytes(s)
    } catch {
      throw new TokenError('not a JWT', 401)
    }
    if (header.alg !== 'RS256') throw new TokenError('alg is not RS256', 401)
    const iss = claims['iss']
    if (typeof iss !== 'string' || !opts.issuers.includes(iss)) {
      throw new TokenError('untrusted issuer', 401)
    }
    const key = await keyOf(iss, typeof header.kid === 'string' ? header.kid : '').catch(() => {
      throw new TokenError(`could not read ${iss}'s keys`, 401)
    })
    if (key === undefined) throw new TokenError('unknown signing key', 401)
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    )
    if (!ok) throw new TokenError('bad signature', 401)
    const aud = claims['aud']
    if (!(aud === opts.audience || (Array.isArray(aud) && aud.includes(opts.audience)))) {
      throw new TokenError('wrong audience', 401)
    }
    const t = now()
    if (typeof claims['exp'] !== 'number' || claims['exp'] + LEEWAY_S < t) {
      throw new TokenError('expired', 401)
    }
    if (typeof claims['nbf'] === 'number' && claims['nbf'] - LEEWAY_S > t) {
      throw new TokenError('not yet valid', 401)
    }
    if (repositories !== undefined) {
      const claim = repositoryClaimOf(iss)
      const repo = claims[claim]
      if (typeof repo !== 'string') throw new TokenError(`no ${claim} claim`, 403)
      if (!repositories.has(repo.toLowerCase())) {
        throw new TokenError(`repository ${repo} is not one this relay serves`, 403)
      }
    }
    if (workflows !== undefined) {
      const claim = workflowClaimOf(iss)
      const ref = claims[claim]
      if (typeof ref !== 'string') throw new TokenError(`no ${claim} claim`, 403)
      const workflow = ref.replace(/@.*$/, '')
      if (!workflows.has(workflow.toLowerCase())) {
        throw new TokenError(`workflow ${workflow} is not one this relay serves`, 403)
      }
    }
    const run = (opts.runClaims?.[iss] ?? runClaimsOf(iss)).map((c) => {
      const v = claims[c]
      if (typeof v !== 'string' && typeof v !== 'number') {
        throw new TokenError(`no ${c} claim`, 403)
      }
      return String(v)
    })
    const job = jobClaimsOf(iss)
      .map((set) => set.map((c) => claims[c]))
      .find((vs) => vs.every((v) => typeof v === 'string' || typeof v === 'number'))
    return job === undefined ? { iss, run } : { iss, run, job: job.join('\0') }
  }
}

/**
 * The issuer and run claims a token says it has, unchecked: what routes a
 * request to its run's Durable Object, where the token is verified. A
 * forged one reaches an object that refuses it.
 */
export function claimedRun(token: string): VerifiedToken | undefined {
  try {
    const claims = JSON.parse(text(token.split('.')[1] ?? '')) as Record<string, unknown>
    const iss = claims['iss']
    if (typeof iss !== 'string') return undefined
    return { iss, run: runClaimsOf(iss).map((c) => String(claims[c])) }
  } catch {
    return undefined
  }
}

async function loadKeys(
  iss: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<Map<string, CryptoKey>> {
  const config = (await fetchJson(
    `${iss.replace(/\/$/, '')}/.well-known/openid-configuration`,
  )) as {
    jwks_uri?: unknown
  }
  if (typeof config.jwks_uri !== 'string') throw new Error('no jwks_uri')
  const jwks = (await fetchJson(config.jwks_uri)) as { keys?: unknown }
  const out = new Map<string, CryptoKey>()
  type Jwk = { kty?: unknown; kid?: unknown; n?: unknown; e?: unknown }
  for (const jwk of Array.isArray(jwks.keys) ? (jwks.keys as Jwk[]) : []) {
    if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue
    out.set(
      typeof jwk.kid === 'string' ? jwk.kid : '',
      await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    )
  }
  return out
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}

// Not Buffer: a Worker has it only under nodejs_compat. atob's decode
// forgives the padding base64url leaves out.
function bytes(b64url: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64url.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  )
}

function text(b64url: string): string {
  return new TextDecoder().decode(bytes(b64url))
}
