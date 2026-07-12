// NativeCacheClient — the vx-native RemoteCacheLayer over /v1/cache
// (docs/design/native-cache-wire-2026-07.md). Wire behaviors + defenses:
// happy paths, digest verification, bounded downloads (content-length
// required + capped, mid-stream cumulative cap), the one-hop redirect with
// auth-dropping on a cross-origin target, immutability-409-as-success,
// header carriage, and timeouts.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  NativeCacheClient,
  readBodyBounded,
} from '../src/native-cache.js'

interface RecordedRequest {
  method: string
  path: string
  headers: Headers
  body: Uint8Array
}

interface StubServe {
  server: ReturnType<typeof Bun.serve>
  baseUrl: string
  requests: RecordedRequest[]
  setHandler(h: (req: Request) => Response | Promise<Response>): void
}

function startStub(): StubServe {
  const requests: RecordedRequest[] = []
  let handler: (req: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 404 })
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: new Uint8Array(await req.arrayBuffer()),
      })
      return await handler(req)
    },
  })
  return {
    server,
    baseUrl: `http://localhost:${server.port}`,
    requests,
    setHandler: (h) => {
      handler = h
    },
  }
}

const digestOf = (bytes: Uint8Array): string =>
  `xxh3:${Bun.hash.xxHash3(bytes).toString(16).padStart(16, '0')}`

describe('NativeCacheClient', () => {
  let stub: StubServe

  beforeEach(() => {
    stub = startStub()
  })
  afterEach(() => {
    void stub.server.stop(true)
  })

  it('put() sends the bytes with content headers + duration + digest; 200 succeeds', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    stub.setHandler(() => Response.json({ ok: true }))
    const body = new TextEncoder().encode('artifact')
    await client.put('a1b2c3d4e5f60718', body, { durationMs: 42 })

    const r = stub.requests.at(-1)!
    expect(r.method).toBe('PUT')
    expect(r.path).toBe('/v1/cache/a1b2c3d4e5f60718')
    expect(r.headers.get('authorization')).toBe('Bearer tok')
    expect(r.headers.get('content-type')).toBe('application/octet-stream')
    expect(r.headers.get('x-vx-duration-ms')).toBe('42')
    expect(r.headers.get('x-vx-digest')).toBe(digestOf(body))
    expect(r.body).toEqual(body)
  })

  it('put() treats 409 (immutable, hash exists) as success', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    stub.setHandler(() => Response.json({ ok: true, immutable: true }, { status: 409 }))
    await expect(client.put('h', new Uint8Array([1]), { durationMs: 1 })).resolves.toBeUndefined()
  })

  it('put() throws on other non-2xx', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    stub.setHandler(() => new Response(null, { status: 401 }))
    await expect(client.put('h', new Uint8Array([1]), { durationMs: 1 })).rejects.toThrow(
      /PUT h → 401/,
    )
  })

  it('get() returns the bytes + durationMs on a hit, null on 404', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    const body = new TextEncoder().encode('cached-bytes')
    stub.setHandler(
      () =>
        new Response(body, {
          headers: { 'x-vx-duration-ms': '17', 'x-vx-digest': digestOf(body) },
        }),
    )
    const hit = await client.get('cafebabecafebabe')
    expect(hit).not.toBeNull()
    expect(new Uint8Array(hit!.body)).toEqual(body)
    expect(hit!.durationMs).toBe(17)

    stub.setHandler(() => new Response(null, { status: 404 }))
    expect(await client.get('0000000000000000')).toBeNull()
  })

  it('get() throws on a 500 (LayeredCache degrades the throw to a miss)', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    stub.setHandler(() => new Response('boom', { status: 500 }))
    await expect(client.get('h')).rejects.toThrow(/GET h → 500/)
  })

  it('get() verifies x-vx-digest — a tampered body throws', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    const original = new TextEncoder().encode('the-original-artifact')
    const tampered = new TextEncoder().encode('the-tampered-artifact')
    stub.setHandler(
      () => new Response(tampered, { headers: { 'x-vx-digest': digestOf(original) } }),
    )
    await expect(client.get('h')).rejects.toThrow(/digest mismatch/)
  })

  it('get() falls back to the S3 user-metadata headers on an offloaded response', async () => {
    // An offloaded GET (a 307 followed to the bucket) carries the metadata as
    // x-amz-meta-vx-* instead of the vx headers — same validation applies.
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    const body = new TextEncoder().encode('offloaded-artifact')
    stub.setHandler(
      () =>
        new Response(body, {
          headers: {
            'x-amz-meta-vx-digest': digestOf(body),
            'x-amz-meta-vx-duration-ms': '33',
          },
        }),
    )
    const hit = await client.get('h')
    expect(new Uint8Array(hit!.body)).toEqual(body)
    expect(hit!.durationMs).toBe(33)

    // A tampered body still throws — the fallback digest is verified too.
    const tampered = new TextEncoder().encode('tampered-artifact!')
    stub.setHandler(
      () => new Response(tampered, { headers: { 'x-amz-meta-vx-digest': digestOf(body) } }),
    )
    await expect(client.get('h')).rejects.toThrow(/digest mismatch/)
  })

  it('get() refuses a response with no content-length (chunked body)', async () => {
    // Bun.serve always reports a content-length once it has the body, so a
    // genuinely chunked (sizeless) response needs the raw TCP form.
    const resp = 'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n'
    const tcp = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(sock) {
          sock.write(resp)
          sock.flush()
        },
      },
    })
    try {
      const client = new NativeCacheClient({ baseUrl: `http://127.0.0.1:${tcp.port}`, token: 't' })
      await expect(client.get('h')).rejects.toThrow(/no content-length/)
    } finally {
      tcp.stop(true)
    }
  })

  it('get() refuses an honestly-declared oversize content-length before reading the body', async () => {
    // Bun.serve normalizes content-length to the real body size, so declare
    // the oversize length at the TCP level. get() throws on the header check
    // BEFORE reading a byte (fetch resolves on headers).
    const big = MAX_REMOTE_ARTIFACT_BYTES + 1
    const resp = `HTTP/1.1 200 OK\r\ncontent-length: ${big}\r\n\r\n`
    const tcp = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(sock) {
          sock.write(resp)
          sock.flush()
        },
      },
    })
    try {
      const client = new NativeCacheClient({ baseUrl: `http://127.0.0.1:${tcp.port}`, token: 't' })
      await expect(client.get('h')).rejects.toThrow(/too large/)
    } finally {
      tcp.stop(true)
    }
  })

  it('readBodyBounded aborts a streamed body once cumulative bytes cross the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(40))
        c.enqueue(new Uint8Array(40))
        c.enqueue(new Uint8Array(40))
        c.close()
      },
    })
    await expect(readBodyBounded(new Response(stream), 100)).rejects.toThrow(
      /100-byte download cap/,
    )
  })

  it('has() sends a HEAD: true on 200, false on 404, throws otherwise', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    stub.setHandler(() => new Response(null, { status: 200 }))
    expect(await client.has('abc123')).toBe(true)
    expect(stub.requests.at(-1)!.method).toBe('HEAD')

    stub.setHandler(() => new Response(null, { status: 404 }))
    expect(await client.has('abc123')).toBe(false)

    stub.setHandler(() => new Response(null, { status: 503 }))
    await expect(client.has('abc123')).rejects.toThrow(/HEAD abc123 → 503/)
  })

  it('hasMany() POSTs /v1/cache/batch and returns the present subset', async () => {
    // Inline server so the handler can READ the request body (the shared stub
    // consumes it for recording before the handler runs).
    const paths: string[] = []
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        paths.push(`${req.method} ${new URL(req.url).pathname}`)
        const { hashes } = (await req.json()) as { hashes: string[] }
        return Response.json({ present: hashes.filter((_, i) => i % 2 === 0) })
      },
    })
    try {
      const client = new NativeCacheClient({
        baseUrl: `http://localhost:${srv.port}`,
        token: 'tok',
      })
      const present = await client.hasMany(['h0', 'h1', 'h2', 'h3'])
      expect([...(present ?? [])].sort()).toEqual(['h0', 'h2'])
      expect(paths).toEqual(['POST /v1/cache/batch'])
    } finally {
      await srv.stop(true)
    }
  })

  it('hasMany() chunks a list larger than the batch cap into multiple requests', async () => {
    let posts = 0
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        posts++
        const { hashes } = (await req.json()) as { hashes: string[] }
        return Response.json({ present: hashes })
      },
    })
    try {
      const client = new NativeCacheClient({
        baseUrl: `http://localhost:${srv.port}`,
        token: 'tok',
      })
      const many = Array.from({ length: 1025 }, (_, i) => `h${i}`)
      const present = await client.hasMany(many)
      expect(posts).toBe(2) // 1024 + 1
      expect(present?.size).toBe(1025)
    } finally {
      await srv.stop(true)
    }
  })

  it('hasMany() returns null on an older serve (404/405) and remembers it', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    let calls = 0
    stub.setHandler(() => {
      calls++
      return new Response(null, { status: 404 })
    })
    expect(await client.hasMany(['a', 'b'])).toBeNull()
    expect(calls).toBe(1)
    // The "unsupported" verdict is cached — no second probe.
    expect(await client.hasMany(['c'])).toBeNull()
    expect(calls).toBe(1)
  })

  it('hasMany() throws on other non-2xx and on a malformed response', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    stub.setHandler(() => new Response('boom', { status: 500 }))
    await expect(client.hasMany(['a'])).rejects.toThrow(/batch → 500/)

    const ok = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    stub.setHandler(() => Response.json({ nope: [] }))
    await expect(ok.hasMany(['a'])).rejects.toThrow(/missing present/)
  })

  it('carries x-vx-cache-scope on every request when configured; omits the bearer with no token', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, cacheScope: 'pr-42' })
    stub.setHandler(() => new Response(null, { status: 404 }))
    await client.get('h')
    await client.has('h')
    stub.setHandler(() => Response.json({ ok: true }))
    await client.put('h', new Uint8Array([1]), { durationMs: 1 })
    for (const r of stub.requests) {
      expect(r.headers.get('x-vx-cache-scope')).toBe('pr-42')
      expect(r.headers.get('authorization')).toBeNull()
    }
  })

  it('get() follows ONE same-origin redirect, keeping the bearer', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    const body = new TextEncoder().encode('redirected')
    stub.setHandler((req) => {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/v1/cache/')) {
        return new Response(null, { status: 307, headers: { location: '/blob/h1' } })
      }
      return new Response(body, { headers: { 'x-vx-digest': digestOf(body) } })
    })
    const hit = await client.get('h1')
    expect(new Uint8Array(hit!.body)).toEqual(body)
    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[1]!.path).toBe('/blob/h1')
    // Same origin → the bearer rides to the redirect target.
    expect(stub.requests[1]!.headers.get('authorization')).toBe('Bearer tok')
  })

  it('get() DROPS the bearer AND the scope header on a cross-origin redirect (query-signed blob URL)', async () => {
    const blob = startStub()
    try {
      const body = new TextEncoder().encode('offloaded-bytes')
      blob.setHandler(() => new Response(body))
      const client = new NativeCacheClient({
        baseUrl: stub.baseUrl,
        token: 'tok',
        cacheScope: 'pr-42',
      })
      stub.setHandler(
        () =>
          new Response(null, {
            status: 307,
            headers: { location: `${blob.baseUrl}/signed/h2?sig=abc` },
          }),
      )
      const hit = await client.get('h2')
      expect(new Uint8Array(hit!.body)).toEqual(body)
      // The serve saw the credentials; the blob origin must see NEITHER the
      // bearer nor the serve-facing cache-scope identity.
      expect(stub.requests[0]!.headers.get('authorization')).toBe('Bearer tok')
      expect(stub.requests[0]!.headers.get('x-vx-cache-scope')).toBe('pr-42')
      expect(blob.requests[0]!.headers.get('authorization')).toBeNull()
      expect(blob.requests[0]!.headers.get('x-vx-cache-scope')).toBeNull()
      expect(blob.requests[0]!.path).toBe('/signed/h2')
    } finally {
      void blob.server.stop(true)
    }
  })

  it('get() follows AT MOST one redirect — a second hop is an error', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok' })
    stub.setHandler(() => new Response(null, { status: 307, headers: { location: '/hop' } }))
    // The redirect target answers 307 again; the client does not loop.
    await expect(client.get('h')).rejects.toThrow(/307/)
  })

  it('aborts requests that exceed the configured timeout', async () => {
    const client = new NativeCacheClient({ baseUrl: stub.baseUrl, token: 'tok', timeoutMs: 50 })
    stub.setHandler(
      async () =>
        await new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(null, { status: 200 })), 500)
        }),
    )
    await expect(client.get('h')).rejects.toThrow(/timed out after 50ms/)
  })

  it('wraps connection failures in a clear error', async () => {
    const client = new NativeCacheClient({ baseUrl: 'http://127.0.0.1:1', token: 'tok' })
    await expect(client.get('h')).rejects.toThrow(/failed/)
  })
})
