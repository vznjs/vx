// The plugin's own wiring: what it contributes, what it DECLINES, and what it
// releases. No server needed — these are the decisions made before any wire
// traffic, and the decline path is the one a user hits by leaving the plugin
// declared in a workspace that has no REAPI server at all.

import { describe, expect, it } from 'bun:test'
import { reapi } from '../src/index.js'
import { ReapiRemoteCache } from '../src/cache.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'

/**
 * Run `fn` with the env vars the plugin once fell back to set: every
 * setting is an option now, and none of these may reach it.
 */
function withOldEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  const old = {
    VX_REAPI_ENDPOINT: 'grpc://127.0.0.1:1',
    VX_REAPI_INSTANCE: 'old',
    VX_REAPI_EXECUTE: '1',
  }
  for (const [k, v] of Object.entries(old)) {
    saved[k] = Bun.env[k]
    Bun.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete Bun.env[k]
      else Bun.env[k] = v
    }
  }
}

const ctx = (warns: string[]) =>
  ({
    warn: (m: string) => warns.push(m),
    workspaceRoot: '/ws',
    cacheDir: '/ws/.vx/cache',
  }) as never

describe('reapi(): the decline path costs nothing', () => {
  it('with no endpoint option, both capabilities decline SILENTLY, whatever the env says', async () => {
    // The README's promise — "safe to leave declared" — and the reason it has
    // to be silent: a warning on every run of every workspace that has not
    // configured a remote is noise the user cannot act on.
    await withOldEnv(async () => {
      const warns: string[] = []
      const p = reapi()
      expect(p.cache?.(ctx(warns))).toBeUndefined()
      expect(await p.executor?.(ctx(warns))).toBeUndefined()
      expect(warns).toEqual([])
      await p.teardown?.()
    })
  })

  it('execute stays OFF unless asked, even with an endpoint', async () => {
    // Remote execution changes where a build runs; configuring a CACHE must
    // not switch it on. Declining here needs no connection, so no server.
    await withOldEnv(async () => {
      const warns: string[] = []
      const p = reapi({ endpoint: 'grpc://127.0.0.1:1' })
      expect(await p.executor?.(ctx(warns))).toBeUndefined()
      await p.teardown?.()
    })
  })
})

describe('reapi(): lifecycle and failure messages', () => {
  it.skipIf(!CHUNKING_SUPPORTED)('teardown closes the cache client it created', async () => {
    // `RemoteCacheLayer` has no close hook and core closes only its local
    // store, so if the plugin does not release this, nothing does. Spied on the prototype because the client is created internally.
    await withOldEnv(async () => {
      const original = ReapiRemoteCache.prototype.close
      let closed = 0
      ReapiRemoteCache.prototype.close = function patched(this: ReapiRemoteCache) {
        closed++
        original.call(this)
      }
      try {
        const p = reapi({ endpoint: 'grpc://127.0.0.1:1' })
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
      await withOldEnv(async () => {
        const p = reapi({ endpoint: 'grpc://127.0.0.1:59999', execute: true })
        expect(p.executor).toBeDefined() // precondition, not an assumption
        let err: unknown
        try {
          await p.executor?.(ctx([]))
        } catch (e) {
          err = e
        }
        expect(err).toBeInstanceOf(Error)
        const msg = (err as Error).message
        expect(msg).toContain('grpc://127.0.0.1:59999')
        expect(msg).toMatch(/check the endpoint/)
        expect(msg).toMatch(/UNAVAILABLE|ECONNREFUSED/) // the cause survives
        await p.teardown?.()
      })
    },
    30_000,
  )

  it.skipIf(!CHUNKING_SUPPORTED)(
    'a remote that cannot reach its server throws the status and names its endpoint',
    async () => {
      // A gRPC status names no server and no key: core names the request
      // from the remote's `endpoint` and keys the class on the status code,
      // so the throw must carry the code and the remote its endpoint.
      await withOldEnv(async () => {
        const p = reapi({ endpoint: 'grpc://127.0.0.1:1', callTimeoutMs: 300 })
        const remote = (await p.cache?.(ctx([])))!
        const err = await remote.has('h1').then(
          () => undefined,
          (e: unknown) => e as Error,
        )
        await p.teardown?.()
        expect({
          endpoint: remote.endpoint,
          status: /^\d+ [A-Z_]+: /.test(err?.message ?? ''),
        }).toEqual({
          endpoint: 'grpc://127.0.0.1:1',
          status: true,
        })
      })
    },
    30_000,
  )

  it.skipIf(!CHUNKING_SUPPORTED)(
    'a refused port says so without the empty tail grpc-js leaves',
    async () => {
      await withOldEnv(async () => {
        const p = reapi({ endpoint: 'grpc://127.0.0.1:1' })
        const remote = (await p.cache?.(ctx([])))!
        const err = await remote.has('h1').then(
          () => undefined,
          (e: unknown) => e as Error,
        )
        await p.teardown?.()
        expect(err?.message).toMatch(/^14 UNAVAILABLE: .*ECONNREFUSED 127\.0\.0\.1:1\.$/)
      })
    },
    30_000,
  )
})

// F-14: a malformed endpoint failed each request far from the setting —
// `http://` failed the run with grpc's `Could not parse target name ""`, a
// lone space or `host:notaport` degraded every request to a miss.
describe('reapi(): the endpoint is checked where it is set', () => {
  const outcome = (endpoint: string | undefined): string =>
    withOldEnv(() => {
      const p = reapi(endpoint === undefined ? {} : { endpoint })
      try {
        const layer = p.cache?.(ctx([]))
        return layer === undefined ? 'declined' : 'accepted'
      } catch (e) {
        return (e as Error).message
      } finally {
        void p.teardown?.()
      }
    })

  it('refuses one that is not host[:port], naming the option', () => {
    expect([
      outcome('http://'),
      outcome('127.0.0.1:notaport'),
      outcome('cache.test:99999'),
      outcome('a b:1'),
    ]).toEqual([
      'vx/reapi: `reapi({ endpoint })` is "http://", which is not host[:port] (e.g. grpcs://cache.example.com:443)',
      'vx/reapi: `reapi({ endpoint })` is "127.0.0.1:notaport", which is not host[:port] (e.g. grpcs://cache.example.com:443)',
      'vx/reapi: `reapi({ endpoint })` is "cache.test:99999", which is not host[:port] (e.g. grpcs://cache.example.com:443)',
      'vx/reapi: `reapi({ endpoint })` is "a b:1", which is not host[:port] (e.g. grpcs://cache.example.com:443)',
    ])
  })

  // Bun's TLS refuses an IP address as the server name, so a TLS endpoint
  // at an IP failed every request ("Setting the TLS ServerName to an IP
  // address is not permitted") and the remote was never reached.
  it('refuses a TLS endpoint at an IP address, naming the way out', () => {
    expect([
      outcome('10.0.0.5:9092'),
      outcome('grpcs://[::1]:8980'),
      outcome('ipv4:10.0.0.5:443'),
    ]).toEqual([
      'vx/reapi: `reapi({ endpoint })` is "10.0.0.5:9092", TLS to an IP address, which Bun cannot open (it refuses an IP as the TLS server name) — name the server by host name, or use grpc:// for plaintext',
      'vx/reapi: `reapi({ endpoint })` is "grpcs://[::1]:8980", TLS to an IP address, which Bun cannot open (it refuses an IP as the TLS server name) — name the server by host name, or use grpc:// for plaintext',
      'vx/reapi: `reapi({ endpoint })` is "ipv4:10.0.0.5:443", TLS to an IP address, which Bun cannot open (it refuses an IP as the TLS server name) — name the server by host name, or use grpc:// for plaintext',
    ])
  })

  it.skipIf(!CHUNKING_SUPPORTED)(
    'a blank one declines as an unset one does; well-formed ones are taken',
    () => {
      expect([
        outcome('  '),
        outcome('cache.test:443'),
        outcome('grpcs://cache.test'),
        outcome('https://cache.test:8443'),
        outcome('grpc://[::1]:8980'),
        outcome('grpc://10.0.0.5:9092'),
        outcome('localhost'),
        outcome('unix:/run/cas.sock'),
      ]).toEqual([
        'declined',
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'accepted',
      ])
    },
  )
})
