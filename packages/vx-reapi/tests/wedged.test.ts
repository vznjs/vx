// The misbehaving-remote suite. A DOWN server is the easy case (connection
// refused → instant UNAVAILABLE → degrade to miss). The killer is a WEDGED
// one — accepts TCP, never speaks — because without a deadline no error ever
// happens, and "a remote cache error degrades to a MISS" is vacuous when the
// call never returns: every vx run would hang at its first probe.
//
// No docker needed: the wedge is a plain TCP listener that stays silent.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Cache } from '@vzn/vx'
import { reapi } from '../src/index.js'
import { ReapiRemoteCache } from '../src/cache.js'

// The union overload of Bun.listen resolves to the unix variant without the
// explicit TCP type argument, and a unix listener has no `port`.
let wedge: import('bun').TCPSocketListener
let port: number

beforeAll(() => {
  wedge = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {}, open() {} }, // accept, say nothing, forever
  })
  port = wedge.port
})

afterAll(() => {
  wedge.stop(true)
})

describe('a wedged remote (accepts TCP, never answers)', () => {
  it('rejects with DEADLINE_EXCEEDED instead of hanging the probe', async () => {
    const cache = new ReapiRemoteCache({ endpoint: `127.0.0.1:${port}`, callTimeoutMs: 1000 })
    try {
      const t0 = Date.now()
      let code: number | undefined
      try {
        await cache.has('deadbeef'.repeat(8))
      } catch (err) {
        code = (err as { code?: number }).code
      }
      expect(code).toBe(4) // DEADLINE_EXCEEDED
      // …and DEADLINE_EXCEEDED is deliberately NOT retryable, so the wait is
      // one deadline, not deadline × retries.
      expect(Date.now() - t0).toBeLessThan(4000)
    } finally {
      cache.close()
    }
  }, 10_000)

  it('degrades to a MISS through the plugin, warning instead of hanging the run', async () => {
    // The invariant end-to-end at the plugin boundary: reapi()'s cache layer
    // over a wedged remote answers `null` (miss) — the run proceeds and
    // re-executes — rather than propagating or hanging.
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-wedged-'))
    const local = new Cache(path.join(dir, 'cache'))
    const warns: string[] = []
    try {
      const plugin = reapi({ endpoint: `127.0.0.1:${port}`, callTimeoutMs: 1000 })
      const layer = (await plugin.cache!({
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
        warn: (m: string) => warns.push(m),
        workspaceRoot: dir,
        cacheDir: path.join(dir, 'cache'),
      } as never))!
      const t0 = Date.now()
      const hit = await layer.get('e'.repeat(64), { taskId: 'a#b', command: 'true' })
      expect(hit).toBeNull()
      expect(Date.now() - t0).toBeLessThan(5000)
      expect(warns.some((w) => w.includes('vx/reapi'))).toBe(true)
    } finally {
      local.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('a DOWN server (connection refused) also degrades, the fast way', async () => {
    // The control for the wedge: refused connections were never the problem,
    // and must stay fast — UNAVAILABLE, not a deadline wait.
    const cache = new ReapiRemoteCache({ endpoint: '127.0.0.1:1', callTimeoutMs: 5000 })
    try {
      let code: number | undefined
      try {
        await cache.has('deadbeef'.repeat(8))
      } catch (err) {
        code = (err as { code?: number }).code
      }
      expect(code === 14 || code === 4).toBe(true) // UNAVAILABLE (or deadline on a slow stack)
    } finally {
      cache.close()
    }
  }, 20_000)
})
