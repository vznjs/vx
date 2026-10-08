// Turbo's preflight (`TURBO_PREFLIGHT`, `remoteCache.preflight`): an
// OPTIONS before each artifact request, whose `Location` is where the
// request goes and whose `Access-Control-Allow-Headers` decides whether the
// token goes along. A server that hands out signed storage URLs needs it.

import { afterAll, describe, expect, it } from 'bun:test'
import { resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

const TOKEN = 'secret-token'
const HASH = 'abc123'

interface Seen {
  method: string
  url: URL
  headers: Headers
}

// Storage that accepts only its own signed URL and refuses any token: the
// shape of a presigned bucket.
const storeSeen: Seen[] = []
const blobs = new Map<string, Uint8Array>()
const storage = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    storeSeen.push({ method: req.method, url, headers: req.headers })
    if (url.searchParams.get('sig') !== 'ok' || url.search.includes('slug'))
      return new Response('bad signature', { status: 400 })
    if (req.headers.has('authorization')) return new Response('foreign token', { status: 400 })
    const key = url.pathname
    if (req.method === 'PUT') {
      blobs.set(key, new Uint8Array(await req.arrayBuffer()))
      return new Response(null, { status: 200 })
    }
    const b = blobs.get(key)
    return b === undefined ? new Response('', { status: 404 }) : new Response(b)
  },
})

// The cache API: answers OPTIONS with a Location (relative for its own
// paths, absolute for the bucket) and serves its own `/own/` path.
const apiSeen: Seen[] = []
let toBucket = false
const own = new Map<string, Uint8Array>()
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    apiSeen.push({ method: req.method, url, headers: req.headers })
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`)
      return new Response('no token', { status: 401 })
    if (req.method === 'OPTIONS') {
      const hash = url.pathname.split('/').pop()!
      if (url.searchParams.get('slug') !== 'team') return new Response('no team', { status: 400 })
      return toBucket
        ? new Response(null, {
            headers: { Location: `${storage.url.origin}/b/${hash}?sig=ok` },
          })
        : new Response(null, {
            headers: {
              Location: `/own/${hash}`,
              'Access-Control-Allow-Headers': 'Content-Type, authorization',
            },
          })
    }
    if (!url.pathname.startsWith('/own/')) return new Response('', { status: 404 })
    if (req.method === 'PUT') {
      own.set(url.pathname, new Uint8Array(await req.arrayBuffer()))
      return new Response(null, { status: 202 })
    }
    const b = own.get(url.pathname)
    return b === undefined ? new Response('', { status: 404 }) : new Response(b)
  },
})

afterAll(() => {
  void api.stop(true)
  void storage.stop(true)
})

function cache(preflight: boolean): TurboRemoteCache {
  const config = resolveTurboCacheConfig(
    { apiUrl: `${api.url.origin}/api`, token: TOKEN, teamSlug: 'team', retries: 0, preflight },
    {},
  )!
  return new TurboRemoteCache(config)
}

describe('resolveTurboCacheConfig: preflight', () => {
  const base = { TURBO_API: 'http://cache', TURBO_TOKEN: 't' }
  it('is off by default, on from TURBO_PREFLIGHT or remoteCache.preflight, env over file', () => {
    expect(resolveTurboCacheConfig({}, base)!.preflight).toBe(false)
    expect(resolveTurboCacheConfig({}, { ...base, TURBO_PREFLIGHT: '1' })!.preflight).toBe(true)
    expect(resolveTurboCacheConfig({}, { ...base, TURBO_PREFLIGHT: 'true' })!.preflight).toBe(true)
    expect(resolveTurboCacheConfig({}, base, { preflight: true })!.preflight).toBe(true)
    expect(
      resolveTurboCacheConfig({}, { ...base, TURBO_PREFLIGHT: '0' }, { preflight: true })!
        .preflight,
    ).toBe(false)
    expect(
      resolveTurboCacheConfig({ preflight: false }, { ...base, TURBO_PREFLIGHT: '1' })!.preflight,
    ).toBe(false)
  })
  it('refuses a TURBO_PREFLIGHT Turbo would refuse', () => {
    expect(() => resolveTurboCacheConfig({}, { ...base, TURBO_PREFLIGHT: 'yes' })).toThrow(
      'vx/turbo-cache: TURBO_PREFLIGHT should be 1 or 0, got "yes"',
    )
  })
})

describe('TurboRemoteCache with preflight', () => {
  it('follows a relative Location, resolved against apiUrl, with the token it admits', async () => {
    toBucket = false
    apiSeen.length = 0
    const c = cache(true)
    await c.put(HASH, new Blob(['own bytes']), { durationMs: 5 })
    expect(await c.has(HASH)).toBe(true)
    const got = await c.get(HASH)
    expect(await got!.body.text()).toBe('own bytes')
    expect(apiSeen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([
      `OPTIONS /api/v8/artifacts/${HASH}`,
      `PUT /own/${HASH}`,
      `OPTIONS /api/v8/artifacts/${HASH}`,
      `HEAD /own/${HASH}`,
      `OPTIONS /api/v8/artifacts/${HASH}`,
      `GET /own/${HASH}`,
    ])
    const [put, , head] = apiSeen
    expect(put!.headers.get('access-control-request-method')).toBe('PUT')
    expect(head!.headers.get('access-control-request-method')).toBe('GET')
    expect(put!.headers.get('access-control-request-headers')).toContain('x-artifact-duration')
  })

  it('sends no token to a Location whose preflight does not admit Authorization', async () => {
    toBucket = true
    storeSeen.length = 0
    const c = cache(true)
    await c.put(HASH, new Blob(['bucket bytes']), { durationMs: 5 })
    const got = await c.get(HASH)
    expect(await got!.body.text()).toBe('bucket bytes')
    expect(storeSeen.map((s) => `${s.method} ${s.url.pathname}${s.url.search}`)).toEqual([
      `PUT /b/${HASH}?sig=ok`,
      `GET /b/${HASH}?sig=ok`,
    ])
  })

  it('sends no OPTIONS without preflight', async () => {
    apiSeen.length = 0
    await cache(false).has(HASH)
    expect(apiSeen.map((s) => s.method)).toEqual(['HEAD'])
  })
})
