import {
  Cache,
  type CacheLayer,
  type CachePolicy,
  FULL_CACHE_POLICY,
  LayeredCache,
  RemoteCache,
} from '../cache/index.js'
import type { Logger } from './logger.js'
import { detectForkPr } from './run-context.js'

export type CacheTrust = 'trusted' | 'untrusted'

/**
 * Resolve this run's cache trust tier (docs/design/cache-trust-scopes-2026-07):
 * `VX_CACHE_TRUST` override → fork-PR auto-detect → default `trusted`. The
 * server enforces the tier from the presented token; this only picks safe
 * client defaults.
 */
export function resolveCacheTrust(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CacheTrust {
  const override = env['VX_CACHE_TRUST']
  if (override === 'trusted' || override === 'untrusted') return override
  return detectForkPr(env) ? 'untrusted' : 'trusted'
}

/**
 * If `VX_REMOTE_CACHE_URL` + a usable token are set, wrap the local cache in a
 * `LayeredCache` so cache reads/writes also hit the remote over the Turbo
 * `/v8/artifacts` wire. Otherwise return the local cache unchanged.
 *
 * Trust tiers: a `trusted` run presents `VX_REMOTE_CACHE_TOKEN`. An
 * `untrusted` (fork-PR) run presents `VX_REMOTE_CACHE_PR_TOKEN` when set (the
 * server routes its writes to the untrusted scope); with no PR token it falls
 * back to the normal token but FORCES `remoteWrite=false`, so a fork PR is
 * read-only against the shared cache and can never poison it — the Nx/Turbo
 * "PR is read-only" default, for free.
 *
 * Optional env: `VX_REMOTE_CACHE_TEAM_ID`, `VX_REMOTE_CACHE_SLUG`
 * (tenancy query params), `VX_REMOTE_CACHE_TIMEOUT_MS`,
 * `VX_REMOTE_CACHE_SIGNATURE_KEY` (HMAC artifact signing — see
 * docs/design/remote-cache.md § Authentication).
 */
export function wrapWithRemoteCache(
  local: Cache,
  log: Logger,
  policy: CachePolicy = FULL_CACHE_POLICY,
): CacheLayer {
  const url = process.env.VX_REMOTE_CACHE_URL
  const trustedToken = process.env.VX_REMOTE_CACHE_TOKEN
  const prToken = process.env.VX_REMOTE_CACHE_PR_TOKEN
  const trust = resolveCacheTrust(process.env)

  let token: string | undefined
  let effectivePolicy = policy
  if (trust === 'untrusted') {
    if (prToken) {
      // Read-trusted / write-untrusted: the server maps this token to the
      // untrusted scope and routes writes there — remoteWrite may stay on.
      token = prToken
    } else {
      // No PR token: read-only against the shared cache so a fork PR can warm
      // off the trusted baseline but can never write into it.
      token = trustedToken
      effectivePolicy = { ...policy, remoteWrite: false }
      if (url && token) log.status('[vx] fork PR without a PR token — remote cache is read-only')
    }
  } else {
    token = trustedToken
  }
  if (!url || !token) return local

  const config: ConstructorParameters<typeof RemoteCache>[0] = { baseUrl: url, token }
  const teamId = process.env.VX_REMOTE_CACHE_TEAM_ID
  if (teamId) config.teamId = teamId
  const slug = process.env.VX_REMOTE_CACHE_SLUG
  if (slug) config.slug = slug
  const timeoutMs = process.env.VX_REMOTE_CACHE_TIMEOUT_MS
  if (timeoutMs) {
    const n = Number(timeoutMs)
    if (Number.isFinite(n) && n > 0) config.timeoutMs = n
  }
  const signatureKey = process.env.VX_REMOTE_CACHE_SIGNATURE_KEY
  if (signatureKey) config.signatureKey = signatureKey

  log.status(`remote cache: ${url}`)
  return new LayeredCache(local, new RemoteCache(config), {
    onRemoteError: (err) => log.status(`[vx] remote cache: ${err.message}`),
    policy: effectivePolicy,
  })
}
