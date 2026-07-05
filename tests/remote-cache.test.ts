import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  readBodyBounded,
  RemoteCache,
  RemoteCacheError,
} from '../src/cache/remote-cache.js'

interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  authorization: string | null
  headers: Record<string, string>
  body: ArrayBuffer
}

interface Fixture {
  server: ReturnType<typeof Bun.serve>
  baseUrl: string
  requests: RecordedRequest[]
  /** Per-test handler — overrides the default 404. */
  setHandler(fn: (req: RecordedRequest) => Response | Promise<Response>): void
}

let fixture: Fixture

function startServer(): Fixture {
  const requests: RecordedRequest[] = []
  let handler: (req: RecordedRequest) => Response | Promise<Response> = () =>
    new Response('not found', { status: 404 })
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.arrayBuffer()
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
      const recorded: RecordedRequest = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: req.headers.get('authorization'),
        headers,
        body,
      }
      requests.push(recorded)
      return handler(recorded)
    },
  })
  return {
    server,
    baseUrl: `http://localhost:${server.port}`,
    requests,
    setHandler(fn) {
      handler = fn
    },
  }
}

describe('RemoteCache', () => {
  beforeEach(() => {
    fixture = startServer()
  })

  afterEach(async () => {
    await fixture.server.stop(true)
  })

  it('get(): returns body + duration header; null on 404', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })

    const payload = new TextEncoder().encode('artifact-bytes').buffer
    fixture.setHandler(
      () =>
        new Response(payload, {
          status: 200,
          headers: { 'x-artifact-duration': '1234' },
        }),
    )
    const got = await cache.get('h')
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got!.body)).toBe('artifact-bytes')
    expect(got!.durationMs).toBe(1234)

    fixture.setHandler(() => new Response(null, { status: 404 }))
    expect(await cache.get('missing')).toBeNull()
  })

  it('get(): sends GET with bearer auth and tenancy query params', async () => {
    const cache = new RemoteCache({
      baseUrl: fixture.baseUrl,
      token: 'secret',
      teamId: 'team_abc',
      slug: 'my-project',
    })
    fixture.setHandler(() => new Response(null, { status: 404 }))
    await cache.get('abc123')

    expect(fixture.requests).toHaveLength(1)
    const r = fixture.requests[0]!
    expect(r.method).toBe('GET')
    expect(r.path).toBe('/v8/artifacts/abc123')
    expect(r.query).toEqual({ teamId: 'team_abc', slug: 'my-project' })
    expect(r.authorization).toBe('Bearer secret')
  })

  it('put(): sends PUT with Authorization, Content-Type, Content-Length, x-artifact-duration', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
    const body = new TextEncoder().encode('tarball-bytes').buffer
    fixture.setHandler(() => new Response(null, { status: 201 }))

    await cache.put('h', body, { durationMs: 42 })

    expect(fixture.requests).toHaveLength(1)
    const r = fixture.requests[0]!
    expect(r.method).toBe('PUT')
    expect(r.path).toBe('/v8/artifacts/h')
    expect(r.headers['content-type']).toBe('application/octet-stream')
    expect(r.headers['content-length']).toBe(String(body.byteLength))
    expect(r.headers['x-artifact-duration']).toBe('42')
    expect(new TextDecoder().decode(r.body)).toBe('tarball-bytes')
  })

  it('get(): wraps a truncated body in RemoteCacheError', async () => {
    // Bun.serve normalizes content-length to the real body size, so lie
    // at the TCP level: declare 100 bytes, send 3, close. Bun's fetch
    // surfaces the truncation as a throw from res.arrayBuffer(); the
    // client must map it to RemoteCacheError so the layered cache
    // degrades it to onRemoteError + miss instead of crashing the run.
    const resp = 'HTTP/1.1 200 OK\r\ncontent-length: 100\r\nx-artifact-duration: 5\r\n\r\nabc'
    const tcp = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(sock) {
          sock.write(resp)
          sock.flush()
          setTimeout(() => sock.end(), 20)
        },
      },
    })
    try {
      const cache = new RemoteCache({ baseUrl: `http://127.0.0.1:${tcp.port}`, token: 'tok' })
      await expect(cache.get('h')).rejects.toThrow(RemoteCacheError)
    } finally {
      tcp.stop(true)
    }
  })

  it('put(): accepts any 2xx — 202 Accepted does not throw', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
    fixture.setHandler(() => new Response(null, { status: 202 }))
    await expect(cache.put('h', new ArrayBuffer(0), { durationMs: 0 })).resolves.toBeUndefined()
  })

  it('put(): throws on non-2xx response', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
    fixture.setHandler(() => new Response('unauthorized', { status: 401 }))
    await expect(cache.put('h', new ArrayBuffer(0), { durationMs: 0 })).rejects.toThrow(
      RemoteCacheError,
    )
  })

  it('wraps fetch errors in RemoteCacheError', async () => {
    // Point at a port that's almost certainly not listening; fetch should
    // reject with ECONNREFUSED, which we wrap as RemoteCacheError.
    const cache = new RemoteCache({ baseUrl: 'http://127.0.0.1:1', token: 'tok' })
    await expect(cache.get('h')).rejects.toThrow(RemoteCacheError)
  })

  it('aborts requests that exceed the configured timeout', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok', timeoutMs: 50 })
    fixture.setHandler(
      async () =>
        await new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(null, { status: 200 })), 500)
        }),
    )
    await expect(cache.get('h')).rejects.toThrow(/timed out after 50ms/)
  })

  it('get(): refuses an honestly-declared oversize content-length before reading the body', async () => {
    // Bun.serve normalizes content-length to the real body size, so declare
    // the oversize length at the TCP level. get() throws on the header check
    // BEFORE reading a byte (fetch resolves on headers), so no body is sent.
    const big = MAX_REMOTE_ARTIFACT_BYTES + 1
    const resp = `HTTP/1.1 200 OK\r\ncontent-length: ${big}\r\nx-artifact-duration: 5\r\n\r\n`
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
      const cache = new RemoteCache({ baseUrl: `http://127.0.0.1:${tcp.port}`, token: 'tok' })
      await expect(cache.get('h')).rejects.toThrow(RemoteCacheError)
      await expect(cache.get('h')).rejects.toThrow(/too large/)
    } finally {
      tcp.stop(true)
    }
  })

  it('readBodyBounded aborts a streamed body once cumulative bytes cross the cap', async () => {
    // Three 40-byte chunks (120 total) against a 100-byte cap: the reader must
    // abort mid-stream on the chunk that crosses it, WITHOUT buffering the rest
    // — the defense against a lying/absent content-length. Uses a tiny cap so a
    // 512 MiB body isn't needed to exercise it.
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

  it('readBodyBounded returns the whole body when it stays under the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.enqueue(new Uint8Array([4, 5]))
        c.close()
      },
    })
    const buf = await readBodyBounded(new Response(stream), 100)
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  describe('has() existence probe', () => {
    it('sends a HEAD; true on 2xx, false on 404', async () => {
      const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
      fixture.setHandler(() => new Response(null, { status: 200 }))
      expect(await cache.has('abc')).toBe(true)
      const r = fixture.requests.at(-1)!
      expect(r.method).toBe('HEAD')
      expect(r.path).toBe('/v8/artifacts/abc')

      fixture.setHandler(() => new Response(null, { status: 404 }))
      expect(await cache.has('missing')).toBe(false)
    })

    it('throws RemoteCacheError carrying the status on a non-404 error (503)', async () => {
      const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
      fixture.setHandler(() => new Response('overloaded', { status: 503 }))
      await expect(cache.has('h')).rejects.toThrow(RemoteCacheError)
      let caught: unknown
      try {
        await cache.has('h')
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(RemoteCacheError)
      expect((caught as RemoteCacheError).status).toBe(503)
    })
  })

  describe('artifact signing (x-artifact-tag)', () => {
    const key = 'vx-test-signature-key-0123456789abcdef'

    // Turbo's construction: base64(HMAC-SHA256(key, hash || teamId || body)).
    // Computed here with node:crypto directly so the test pins the exact
    // byte concatenation independently of the implementation.
    function tagFor(hash: string, teamId: string, body: Uint8Array): string {
      return createHmac('sha256', key).update(hash).update(teamId).update(body).digest('base64')
    }

    it('put(): sends x-artifact-tag = HMAC-SHA256(key, hash + teamId + body)', async () => {
      const cache = new RemoteCache({
        baseUrl: fixture.baseUrl,
        token: 'tok',
        teamId: 'team_abc',
        signatureKey: key,
      })
      const body = new TextEncoder().encode('tarball-bytes')
      fixture.setHandler(() => new Response(null, { status: 201 }))

      await cache.put('h1', body, { durationMs: 7 })

      expect(fixture.requests[0]!.headers['x-artifact-tag']).toBe(tagFor('h1', 'team_abc', body))
    })

    it('put(): unset teamId folds as the empty string', async () => {
      const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok', signatureKey: key })
      const body = new TextEncoder().encode('tarball-bytes')
      fixture.setHandler(() => new Response(null, { status: 201 }))

      await cache.put('h1', body, { durationMs: 7 })

      expect(fixture.requests[0]!.headers['x-artifact-tag']).toBe(tagFor('h1', '', body))
    })

    it('put(): no signatureKey → no x-artifact-tag header', async () => {
      const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
      fixture.setHandler(() => new Response(null, { status: 201 }))

      await cache.put('h1', new TextEncoder().encode('b'), { durationMs: 0 })

      expect(fixture.requests[0]!.headers['x-artifact-tag']).toBeUndefined()
    })

    it('get(): accepts a response whose tag matches the body', async () => {
      const cache = new RemoteCache({
        baseUrl: fixture.baseUrl,
        token: 'tok',
        teamId: 'team_abc',
        signatureKey: key,
      })
      const body = new TextEncoder().encode('artifact-bytes')
      fixture.setHandler(
        () =>
          new Response(body, {
            status: 200,
            headers: { 'x-artifact-tag': tagFor('h2', 'team_abc', body) },
          }),
      )

      const got = await cache.get('h2')
      expect(new TextDecoder().decode(got!.body)).toBe('artifact-bytes')
    })

    it('get(): rejects a tampered body with RemoteCacheError', async () => {
      const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok', signatureKey: key })
      const original = new TextEncoder().encode('artifact-bytes')
      const tampered = new TextEncoder().encode('artifact-bytEs')
      fixture.setHandler(
        () =>
          new Response(tampered, {
            status: 200,
            headers: { 'x-artifact-tag': tagFor('h3', '', original) },
          }),
      )

      await expect(cache.get('h3')).rejects.toThrow(RemoteCacheError)
      await expect(cache.get('h3')).rejects.toThrow(/signature mismatch/)
    })

    it('get(): rejects a missing tag when signing is enabled', async () => {
      const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok', signatureKey: key })
      fixture.setHandler(() => new Response(new TextEncoder().encode('b'), { status: 200 }))

      await expect(cache.get('h4')).rejects.toThrow(RemoteCacheError)
      await expect(cache.get('h4')).rejects.toThrow(/x-artifact-tag/)
    })

    it('get(): ignores x-artifact-tag entirely when no key is configured', async () => {
      const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
      fixture.setHandler(
        () =>
          new Response(new TextEncoder().encode('artifact-bytes'), {
            status: 200,
            headers: { 'x-artifact-tag': 'garbage-not-a-real-tag' },
          }),
      )

      const got = await cache.get('h5')
      expect(new TextDecoder().decode(got!.body)).toBe('artifact-bytes')
    })
  })
})
