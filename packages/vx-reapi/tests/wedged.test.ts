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

describe('adaptive chunk downgrade', () => {
  it('a deadline on a multi-chunk write retries once at SAFE_CHUNK_BYTES, warned', async () => {
    // The Bun flow-control defect is a RACE, not a boundary — 128 KB chunks
    // pass hundreds of times and then wedge once (observed on CI, same Bun).
    // The downgrade turns that lost coin-flip into a warned retry at the size
    // never observed hanging. Against a fully wedged server BOTH attempts
    // deadline — what this pins is that the second attempt HAPPENS (elapsed
    // covers two deadlines, the warn names the downgrade) and that the final
    // error is still the honest DEADLINE_EXCEEDED.
    const warns: string[] = []
    const client = new (await import('../src/wire.js')).ReapiClient({
      endpoint: `127.0.0.1:${port}`,
      callTimeoutMs: 900,
      onWarn: (m) => warns.push(m),
    })
    try {
      const body = new Uint8Array(512 * 1024) // 4 chunks at the 128 KB default
      const digest = (await import('../src/cache.js')).digestOf(body)
      const t0 = Date.now()
      let code: number | undefined
      try {
        await client.writeBlob(digest, body)
      } catch (err) {
        code = (err as { code?: number }).code
      }
      const elapsed = Date.now() - t0
      expect(code).toBe(4)
      expect(elapsed).toBeGreaterThanOrEqual(1700) // two deadlines ran
      expect(warns.some((w) => w.includes('retrying at 65535'))).toBe(true)
    } finally {
      client.close()
    }
  }, 15_000)

  it('a single-chunk write does NOT downgrade-retry (nothing to downgrade)', async () => {
    // Control: at or below SAFE_CHUNK_BYTES there is no smaller safe size,
    // so the deadline surfaces after ONE wait, not two.
    const warns: string[] = []
    const client = new (await import('../src/wire.js')).ReapiClient({
      endpoint: `127.0.0.1:${port}`,
      callTimeoutMs: 900,
      onWarn: (m) => warns.push(m),
    })
    try {
      const body = new Uint8Array(1024)
      const digest = (await import('../src/cache.js')).digestOf(body)
      const t0 = Date.now()
      try {
        await client.writeBlob(digest, body)
      } catch {
        /* expected */
      }
      expect(Date.now() - t0).toBeLessThan(1700)
      expect(warns).toEqual([])
    } finally {
      client.close()
    }
  }, 10_000)
})

describe('control-plane calls are bounded separately from bulk transfers', () => {
  // One knob for both classes is a trap. A `node_modules` capture legitimately
  // needs minutes, so a real deployment raises `callTimeoutMs` — and with a
  // single deadline that also buys every metadata probe the same minutes
  // before it can degrade to a miss, which is the opposite of what the
  // deadline is for. Observed against a NativeLink that had degraded into
  // never answering an AC HIT (misses still returned in 3ms): every task
  // burned the full 180s upload deadline on a lookup.
  it('a metadata probe gives up on the SHORT deadline, not the bulk one', async () => {
    const cache = new ReapiRemoteCache({
      endpoint: `127.0.0.1:${port}`,
      callTimeoutMs: 60_000,
      metaTimeoutMs: 700,
    })
    try {
      const t0 = Date.now()
      await expect(cache.has('deadbeef'.repeat(8))).rejects.toMatchObject({ code: 4 })
      const waited = Date.now() - t0
      expect(waited).toBeGreaterThanOrEqual(600)
      // The point of the split: nowhere near the 60s bulk deadline.
      expect(waited).toBeLessThan(5_000)
    } finally {
      cache.close()
    }
  }, 20_000)

  it('defaults derive from callTimeoutMs and cap at 15s, so raising it never lengthens a probe', async () => {
    // No metaTimeoutMs given, and a bulk deadline far above the cap.
    const cache = new ReapiRemoteCache({ endpoint: `127.0.0.1:${port}`, callTimeoutMs: 600_000 })
    try {
      const t0 = Date.now()
      await expect(cache.has('deadbeef'.repeat(8))).rejects.toMatchObject({ code: 4 })
      expect(Date.now() - t0).toBeLessThan(20_000)
    } finally {
      cache.close()
    }
  }, 30_000)

  // CONTROL: the cap must not clamp a deliberately SHORT bulk deadline, or
  // `min()` would silently lengthen a probe that was already tighter.
  it('a bulk deadline below the cap still governs the probe', async () => {
    const cache = new ReapiRemoteCache({ endpoint: `127.0.0.1:${port}`, callTimeoutMs: 800 })
    try {
      const t0 = Date.now()
      await expect(cache.has('deadbeef'.repeat(8))).rejects.toMatchObject({ code: 4 })
      expect(Date.now() - t0).toBeLessThan(5_000)
    } finally {
      cache.close()
    }
  }, 20_000)
})
