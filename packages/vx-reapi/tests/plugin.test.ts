// The plugin's own wiring: what it contributes, what it DECLINES, and what it
// releases. No server needed — these are the decisions made before any wire
// traffic, and the decline path is the one a user hits by leaving the plugin
// declared in a workspace that has no REAPI server at all.

import { describe, expect, it } from 'bun:test'
import type { CacheLayer } from '@vzn/vx'
import { reapi } from '../src/index.js'
import { ReapiRemoteCache } from '../src/cache.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'

/** Run `fn` with the plugin's env vars cleared, whatever CI has set. */
function withoutReapiEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of ['VX_REAPI_ENDPOINT', 'VX_REAPI_INSTANCE', 'VX_REAPI_EXECUTE']) {
    saved[k] = Bun.env[k]
    delete Bun.env[k]
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) Bun.env[k] = v
  }
}

const ctx = (warns: string[]) =>
  ({
    warn: (m: string) => warns.push(m),
    localCache: {} as never,
    policy: {} as never,
  }) as never

describe('reapi(): the decline path costs nothing', () => {
  it('with no endpoint, both capabilities decline SILENTLY', async () => {
    // The README's promise — "safe to leave declared" — and the reason it has
    // to be silent: a warning on every run of every workspace that has not
    // configured a remote is noise the user cannot act on.
    await withoutReapiEnv(async () => {
      const warns: string[] = []
      const p = reapi()
      expect(p.cache?.(ctx(warns))).toBeUndefined()
      expect(await p.executor?.(ctx(warns))).toBeUndefined()
      expect(warns).toEqual([])
      await p.teardown?.()
    })
  })

  it.skipIf(!CHUNKING_SUPPORTED)(
    'an endpoint configured ONLY by env still contributes a cache',
    async () => {
      // The documented alternative to passing `endpoint` — worth pinning
      // separately, since the decline test above would also pass if the env
      // path were broken and everything simply declined.
      await withoutReapiEnv(async () => {
        Bun.env['VX_REAPI_ENDPOINT'] = '127.0.0.1:1'
        const warns: string[] = []
        const p = reapi()
        expect(p.cache?.(ctx(warns))).toBeDefined()
        await p.teardown?.()
      })
    },
  )

  it('execute stays OFF unless asked, even with an endpoint', async () => {
    // Remote execution changes where a build runs; configuring a CACHE must
    // not switch it on. Declining here needs no connection, so no server.
    await withoutReapiEnv(async () => {
      Bun.env['VX_REAPI_ENDPOINT'] = '127.0.0.1:1'
      const warns: string[] = []
      const p = reapi()
      expect(await p.executor?.(ctx(warns))).toBeUndefined()
      await p.teardown?.()
    })
  })
})

describe('reapi(): lifecycle and failure messages', () => {
  it.skipIf(!CHUNKING_SUPPORTED)('teardown closes the cache client it created', async () => {
    // `RemoteCacheLayer` has no close hook and `LayeredCache.close()` closes
    // only the local handle, so if the plugin does not release this, nothing
    // does. Spied on the prototype because the client is created internally.
    await withoutReapiEnv(async () => {
      Bun.env['VX_REAPI_ENDPOINT'] = '127.0.0.1:1'
      const original = ReapiRemoteCache.prototype.close
      let closed = 0
      ReapiRemoteCache.prototype.close = function patched(this: ReapiRemoteCache) {
        closed++
        original.call(this)
      }
      try {
        const p = reapi()
        expect(p.cache?.(ctx([]))).toBeDefined()
        expect(closed).toBe(0) // precondition: not closed merely by being made
        await p.teardown?.()
        expect(closed).toBe(1)
      } finally {
        ReapiRemoteCache.prototype.close = original
      }
    })
  })

  it.skipIf(!CHUNKING_SUPPORTED)(
    'an unreachable endpoint names the endpoint and what to do',
    async () => {
      // Core aborts the run on a throwing executor factory (deliberately — an
      // executor is load-bearing), so this string is what the user acts on. The
      // raw gRPC "14 UNAVAILABLE … Resolution note:" named neither the setting
      // nor a remedy.
      await withoutReapiEnv(async () => {
        const p = reapi({ endpoint: '127.0.0.1:59999', execute: true })
        expect(p.executor).toBeDefined() // precondition, not an assumption
        let err: unknown
        try {
          await p.executor?.(ctx([]))
        } catch (e) {
          err = e
        }
        expect(err).toBeInstanceOf(Error)
        const msg = (err as Error).message
        expect(msg).toContain('127.0.0.1:59999')
        expect(msg).toMatch(/check the endpoint/)
        expect(msg).toMatch(/UNAVAILABLE|ECONNREFUSED/) // the cause survives
        await p.teardown?.()
      })
    },
    30_000,
  )

  it.skipIf(!CHUNKING_SUPPORTED)(
    'a cache that cannot reach its server names the probe, the artifact and the endpoint, once',
    async () => {
      // A gRPC status names no server and no key, and writes the elapsed time
      // into its message, so two deadlines never read alike (item 749). Core
      // names the request from the layer's `endpoint` and keys the class on
      // the status code: the second probe is a count, not a second line.
      await withoutReapiEnv(async () => {
        const warns: string[] = []
        const local = { has: async () => null, close: () => {} }
        const p = reapi({ endpoint: '127.0.0.1:1', callTimeoutMs: 300 })
        const policy = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }
        const layer = (await p.cache?.({
          warn: (m: string) => warns.push(m),
          localCache: local,
          policy,
        } as never)) as CacheLayer
        expect(await layer.has('h1')).toBeNull()
        expect(await layer.has('h2')).toBeNull()
        layer.close()
        await p.teardown?.()
        const cause = warns[0]?.split(' failed: ')[1] ?? ''
        expect(cause).toMatch(/^\d+ [A-Z_]+: /)
        expect(warns).toEqual([
          `vx/reapi: probe h1 at 127.0.0.1:1 failed: ${cause}`,
          `vx/reapi: 1 more request failed the same way: ${cause}`,
        ])
      })
    },
    30_000,
  )
})
