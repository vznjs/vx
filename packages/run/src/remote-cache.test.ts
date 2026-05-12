import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RemoteCache, RemoteCacheError } from './remote-cache.js'

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

  it('has(): true on 200, false on 404, throws on 5xx', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })

    fixture.setHandler(() => new Response(null, { status: 200 }))
    expect(await cache.has('abc')).toBe(true)

    fixture.setHandler(() => new Response(null, { status: 404 }))
    expect(await cache.has('def')).toBe(false)

    fixture.setHandler(() => new Response('boom', { status: 503 }))
    await expect(cache.has('xyz')).rejects.toThrow(RemoteCacheError)
  })

  it('has(): sends HEAD with bearer auth and tenancy query params', async () => {
    const cache = new RemoteCache({
      baseUrl: fixture.baseUrl,
      token: 'secret',
      teamId: 'team_abc',
      slug: 'my-project',
    })
    fixture.setHandler(() => new Response(null, { status: 200 }))
    await cache.has('abc123')

    expect(fixture.requests).toHaveLength(1)
    const r = fixture.requests[0]!
    expect(r.method).toBe('HEAD')
    expect(r.path).toBe('/v8/artifacts/abc123')
    expect(r.query).toEqual({ teamId: 'team_abc', slug: 'my-project' })
    expect(r.authorization).toBe('Bearer secret')
  })

  it('get(): returns body + metadata headers; null on 404', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })

    const payload = new TextEncoder().encode('artifact-bytes').buffer
    fixture.setHandler(
      () =>
        new Response(payload, {
          status: 200,
          headers: {
            'x-artifact-duration': '1234',
            'x-artifact-tag': 'hmac-abc',
          },
        }),
    )
    const got = await cache.get('h')
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got!.body)).toBe('artifact-bytes')
    expect(got!.durationMs).toBe(1234)
    expect(got!.tag).toBe('hmac-abc')

    fixture.setHandler(() => new Response(null, { status: 404 }))
    expect(await cache.get('missing')).toBeNull()
  })

  it('put(): sends PUT with Authorization, Content-Type, Content-Length, x-artifact-duration', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
    const body = new TextEncoder().encode('tarball-bytes').buffer
    fixture.setHandler(() => new Response(null, { status: 201 }))

    await cache.put('h', body, { durationMs: 42, ci: 'github', interactive: true })

    expect(fixture.requests).toHaveLength(1)
    const r = fixture.requests[0]!
    expect(r.method).toBe('PUT')
    expect(r.path).toBe('/v8/artifacts/h')
    expect(r.headers['content-type']).toBe('application/octet-stream')
    expect(r.headers['content-length']).toBe(String(body.byteLength))
    expect(r.headers['x-artifact-duration']).toBe('42')
    expect(r.headers['x-artifact-client-ci']).toBe('github')
    expect(r.headers['x-artifact-client-interactive']).toBe('1')
    expect(new TextDecoder().decode(r.body)).toBe('tarball-bytes')
  })

  it('put(): includes optional tag when provided', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
    fixture.setHandler(() => new Response(null, { status: 200 }))
    await cache.put('h', new ArrayBuffer(0), { durationMs: 1, tag: 'sig' })
    expect(fixture.requests[0]!.headers['x-artifact-tag']).toBe('sig')
  })

  it('put(): throws on non-2xx response', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
    fixture.setHandler(() => new Response('unauthorized', { status: 401 }))
    await expect(cache.put('h', new ArrayBuffer(0), { durationMs: 0 })).rejects.toThrow(
      RemoteCacheError,
    )
  })

  it('batchExistence(): posts hashes and parses the per-hash metadata response', async () => {
    const cache = new RemoteCache({
      baseUrl: fixture.baseUrl,
      token: 'tok',
      teamId: 't',
      slug: 's',
    })
    fixture.setHandler((req) => {
      // Server only returns rows for the hashes the client asked about.
      expect(req.path).toBe('/v8/artifacts')
      expect(req.query).toEqual({ teamId: 't', slug: 's' })
      const body = JSON.parse(new TextDecoder().decode(req.body)) as { hashes: string[] }
      expect(body.hashes).toEqual(['a', 'b'])
      return Response.json({
        a: { size: 1024, taskDurationMs: 500, tag: 'sigA' },
        // b is missing → client should report a miss
      })
    })

    const result = await cache.batchExistence(['a', 'b'])
    expect(result).toEqual({
      a: { size: 1024, taskDurationMs: 500, tag: 'sigA' },
    })
  })

  it('batchExistence(): empty input short-circuits with no request', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok' })
    const result = await cache.batchExistence([])
    expect(result).toEqual({})
    expect(fixture.requests).toHaveLength(0)
  })

  it('wraps fetch errors in RemoteCacheError', async () => {
    // Point at a port that's almost certainly not listening; fetch should
    // reject with ECONNREFUSED, which we wrap as RemoteCacheError.
    const cache = new RemoteCache({ baseUrl: 'http://127.0.0.1:1', token: 'tok' })
    await expect(cache.has('h')).rejects.toThrow(RemoteCacheError)
  })

  it('aborts requests that exceed the configured timeout', async () => {
    const cache = new RemoteCache({ baseUrl: fixture.baseUrl, token: 'tok', timeoutMs: 50 })
    fixture.setHandler(
      async () =>
        await new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(null, { status: 200 })), 500)
        }),
    )
    await expect(cache.has('h')).rejects.toThrow(/timed out after 50ms/)
  })
})
