import { Cache, type CacheLayer } from '../cache/cache.js'
import { LayeredCache, type LayeredCacheOptions } from '../cache/layered-cache.js'
import { RemoteCache } from '../cache/remote-cache.js'
import type { Logger } from './logger.js'
import type { Observer } from './observer.js'

/**
 * If `VX_REMOTE_CACHE_URL` + `VX_REMOTE_CACHE_TOKEN` are both set,
 * wrap the local cache in a `LayeredCache` so cache reads/writes also
 * hit the remote over the Turbo `/v8/artifacts` wire. Otherwise return
 * the local cache unchanged.
 *
 * Optional env: `VX_REMOTE_CACHE_TEAM_ID`, `VX_REMOTE_CACHE_SLUG`
 * (tenancy query params), `VX_REMOTE_CACHE_TIMEOUT_MS`.
 *
 * When an `observer` is supplied, every remote request (`GET` /
 * `PUT` / `HEAD`) emits a `remoteCache` event so the TUI's RemoteCache
 * panel can render hit/miss/throughput sparklines.
 */
export function wrapWithRemoteCache(local: Cache, log: Logger, observer?: Observer): CacheLayer {
  const url = process.env.VX_REMOTE_CACHE_URL
  const token = process.env.VX_REMOTE_CACHE_TOKEN
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

  log.status(`remote cache: ${url}`)
  const layeredOpts: LayeredCacheOptions = {
    onRemoteError: (err) => log.status(`[vx] remote cache: ${err.message}`),
  }
  if (observer) {
    layeredOpts.onRemoteRequest = (ev) => observer.emit({ kind: 'remoteCache', ...ev })
  }
  return new LayeredCache(local, new RemoteCache(config), layeredOpts)
}
