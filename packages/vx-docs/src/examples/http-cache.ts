import { definePlugin, LayeredCache, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

// A toy HTTP store: HEAD, GET and PUT on <url>/<hash>. A throw is not fatal:
// the layer reports it through onRemoteError and treats it as a miss.
function httpStore(url: string): RemoteCacheLayer {
  return {
    async has(hash) {
      const res = await fetch(`${url}/${hash}`, { method: 'HEAD' })
      if (res.status === 404) return false
      if (!res.ok) throw new Error(`HEAD ${hash}: ${res.status}`)
      return true
    },
    async get(hash) {
      const res = await fetch(`${url}/${hash}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`GET ${hash}: ${res.status}`)
      // The response itself: core streams the body to disk.
      return { body: res, durationMs: undefined }
    },
    async put(hash, body) {
      const res = await fetch(`${url}/${hash}`, { method: 'PUT', body })
      if (!res.ok) throw new Error(`PUT ${hash}: ${res.status}`)
    },
  }
}

export function httpCache(): VxPlugin {
  return definePlugin(import.meta, {
    cache(ctx) {
      const url = process.env['CACHE_URL']
      // Declining leaves the local store as the only layer.
      if (url === undefined) return undefined
      return new LayeredCache(ctx.localCache, httpStore(url), {
        policy: ctx.policy,
        onRemoteError: (err) => ctx.warn(`http cache: ${err.message}`),
      })
    },
  })
}
