// Turbo's outage breaker on both wires: a server that hangs or is down is
// asked three times, then left alone for 30 s, then probed once.

import { afterAll, describe, expect, it } from 'bun:test'
import { OutageBreaker } from '../src/remote-breaker.js'
import { NxRemoteCache, resolveNxCacheConfig } from '../src/nx-cache/index.js'
import { resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

const OPEN = 'unavailable after 3 failures in a row; not asked again for 30 s'

describe('OutageBreaker', () => {
  let t = 0
  const ok = (status: number) => () => Promise.resolve(new Response(null, { status }))
  const down = () => Promise.reject(new Error('ConnectionRefused'))
  const settle = (p: Promise<Response>) =>
    p.then(
      (r) => r.status,
      (e: Error) => e.message,
    )

  it('opens after three outages in a row, and a non-outage answer resets the count', async () => {
    t = 0
    const b = new OutageBreaker(() => t)
    expect(await settle(b.send(down))).toBe('ConnectionRefused')
    expect(await settle(b.send(ok(503)))).toBe(503)
    expect(await settle(b.send(ok(404)))).toBe(404)
    expect(await settle(b.send(down))).toBe('ConnectionRefused')
    expect(await settle(b.send(ok(500)))).toBe(500)
    expect(await settle(b.send(down))).toBe('ConnectionRefused')
    let sent = 0
    const counted = () => {
      sent++
      return Promise.resolve(new Response(null, { status: 200 }))
    }
    expect(await settle(b.send(counted))).toBe(OPEN)
    t = 29_999
    expect(await settle(b.send(counted))).toBe(OPEN)
    expect(sent).toBe(0)
  })

  it('probes once after the cooldown: a failed probe reopens, a good one closes', async () => {
    t = 0
    const b = new OutageBreaker(() => t)
    for (let i = 0; i < 3; i++) await settle(b.send(down))
    t = 30_000
    expect(await settle(b.send(down))).toBe('ConnectionRefused')
    expect(await settle(b.send(ok(200)))).toBe(OPEN)
    t = 60_000
    let release!: (r: Response) => void
    const probe = b.send(() => new Promise<Response>((r) => (release = r)))
    expect(await settle(b.send(ok(200)))).toBe(OPEN)
    release(new Response(null, { status: 200 }))
    expect(await settle(probe)).toBe(200)
    expect(await settle(b.send(ok(200)))).toBe(200)
  })

  it('ignores an answer that lands after the breaker opened', async () => {
    t = 0
    const b = new OutageBreaker(() => t)
    let release!: (r: Response) => void
    const late = b.send(() => new Promise<Response>((r) => (release = r)))
    for (let i = 0; i < 3; i++) await settle(b.send(down))
    release(new Response(null, { status: 200 }))
    await late
    expect(await settle(b.send(ok(200)))).toBe(OPEN)
  })
})

describe('a hung server costs three deadlines, not one per request', () => {
  let seen = 0
  const hung = Bun.serve({
    port: 0,
    fetch: () => {
      seen++
      return new Promise<Response>(() => {})
    },
  })
  afterAll(() => void hung.stop(true))

  async function count(probe: () => Promise<unknown>): Promise<string[]> {
    seen = 0
    const errors: string[] = []
    for (let i = 0; i < 6; i++) await probe().catch((e: Error) => errors.push(e.message))
    expect(seen).toBe(3)
    return errors
  }

  it('turboCache()', async () => {
    const c = new TurboRemoteCache(
      resolveTurboCacheConfig(
        { apiUrl: hung.url.origin, token: 't', timeoutMs: 50, retries: 0 },
        {},
      )!,
    )
    expect(await count(() => c.has('abc'))).toEqual([
      ...Array(3).fill('no answer within 50 ms'),
      ...Array(3).fill(OPEN),
    ])
  })

  it('nxCache()', async () => {
    const c = new NxRemoteCache(
      resolveNxCacheConfig({ server: hung.url.origin, timeoutMs: 50, retries: 0 }, {})!,
    )
    expect(await count(() => c.get('abc'))).toEqual([
      ...Array(3).fill('no answer within 50 ms'),
      ...Array(3).fill(OPEN),
    ])
  })
})
