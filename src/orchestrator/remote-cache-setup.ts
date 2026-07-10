import {
  Cache,
  type CacheLayer,
  type CachePolicy,
  FULL_CACHE_POLICY,
  LayeredCache,
  RemoteCache,
} from '../cache/index.js'
import type { Logger } from './logger.js'
import { resolveCacheScope } from './run-context.js'

/**
 * Wrap the local cache in a `LayeredCache` when a remote cache is configured
 * via `VX_REMOTE_CACHE_URL` + a token. This is the escape hatch for a
 * THIRD-PARTY, Turbo-compatible cache server. A `cache` plugin can provide a
 * remote cache INTERNALLY instead, in which case this env path isn't
 * needed.
 *
 * **Trust tier follows the token you present** — the server derives
 * trusted/untrusted from the bearer, so the client just presents whichever
 * token it has: `VX_REMOTE_CACHE_TOKEN` for a trusted context, or
 * `VX_REMOTE_CACHE_PR_TOKEN` for a fork PR (reads the trusted cache, writes
 * only the untrusted scope). A fork-PR CI job simply doesn't hold the trusted
 * secret, so "which token you have" IS the tier — no separate trust flag.
 *
 * Optional env: `VX_REMOTE_CACHE_TEAM_ID`, `VX_REMOTE_CACHE_SLUG`
 * (Turbo tenancy query params), `VX_REMOTE_CACHE_TIMEOUT_MS`,
 * `VX_REMOTE_CACHE_SIGNATURE_KEY` (HMAC artifact signing),
 * `VX_REMOTE_CACHE_PREFLIGHT` (Turbo `--preflight`: OPTIONS handshake →
 * pre-signed URL redirect; see docs/design/presigned-artifacts-2026-07.md).
 */
export function wrapWithRemoteCache(
  local: Cache,
  log: Logger,
  policy: CachePolicy = FULL_CACHE_POLICY,
): CacheLayer {
  const url = process.env.VX_REMOTE_CACHE_URL
  const token = process.env.VX_REMOTE_CACHE_TOKEN ?? process.env.VX_REMOTE_CACHE_PR_TOKEN
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
  const preflight = process.env.VX_REMOTE_CACHE_PREFLIGHT
  if (preflight === '1' || preflight === 'true') config.preflight = true
  // Untrusted per-PR isolation: a fork PR's writes land in its own sub-scope.
  const cacheScope = resolveCacheScope(process.env)
  if (cacheScope) config.cacheScope = cacheScope

  log.status(`remote cache: ${url}`)
  return new LayeredCache(local, new RemoteCache(config), {
    onRemoteError: (err) => log.status(`[vx] remote cache: ${err.message}`),
    policy,
  })
}
