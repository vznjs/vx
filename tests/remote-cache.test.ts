import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RemoteCache, RemoteCacheError } from '../src/cache/remote-cache.js'

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
})
