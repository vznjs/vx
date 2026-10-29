// Item 815's sweep of nx-cache/index.ts: each row fails with one line of the
// plugin undone. Driven through a stub `fetch`, so a row reads the exact
// request and serves the exact response it is about.
import { describe, expect, it } from 'bun:test'
import { NxRemoteCache, resolveNxCacheConfig } from '../src/nx-cache/index.js'

interface Call {
  method: string
  headers: Record<string, string>
}

function stub(respond: () => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ method: init.method!, headers: init.headers as Record<string, string> })
    return respond()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const SERVER = 'http://nx.invalid'

const refusal = (f: () => unknown): string => {
  try {
    f()
    return '(no refusal)'
  } catch (err) {
    return (err as Error).message
  }
}

describe('resolveNxCacheConfig, exactly', () => {
  // Item 928: the same token leak as turboCache's.
  it('an access token no header can carry is refused, and not printed', () => {
    const msg = (token: string) => refusal(() => resolveNxCacheConfig({ url: SERVER, token }, {}))
    expect([msg('SECRET\r\nX: y'), msg('SECRET\0'), msg('SECRET')]).toEqual([
      'vx/nx-cache: the access token holds a line break or NUL, which no HTTP header can carry — check the secret (it is not printed)',
      'vx/nx-cache: the access token holds a line break or NUL, which no HTTP header can carry — check the secret (it is not printed)',
      '(no refusal)',
    ])
  })

  it('every trailing slash is stripped, and a server of only slashes or nothing declines', () => {
    expect(resolveNxCacheConfig({ url: `${SERVER}//` }, {})?.url).toBe(SERVER)
    expect(resolveNxCacheConfig({ url: '' }, {})).toBeUndefined()
    expect(resolveNxCacheConfig({ url: '/' }, {})).toBeUndefined()
  })

  it('a password with no user name is refused too', () => {
    expect(() => resolveNxCacheConfig({ url: 'http://:pw@nx.invalid' }, {})).toThrow(
      'nxCache() option "url" carries credentials (user:pass@); pass them as the token instead',
    )
  })

  it('the token option wins over the env; an empty one is an open server', () => {
    const env = { NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'env' }
    expect(resolveNxCacheConfig({ url: SERVER, token: 'opt' }, env)).toEqual({
      url: SERVER,
      token: 'opt',
      timeoutMs: 30_000,
      retries: 1,
    })
    expect(resolveNxCacheConfig({ url: SERVER, token: '' }, env)).toEqual({
      url: SERVER,
      token: '',
      timeoutMs: 30_000,
      retries: 1,
    })
  })
})

describe('the requests', () => {
  it('no token sends no Authorization; an upload declares its length', async () => {
    const { fetchImpl, calls } = stub(() => new Response(null, { status: 200 }))
    await new NxRemoteCache({ url: SERVER, token: '', timeoutMs: 1000, retries: 0 }, fetchImpl).put(
      'aa',
      new Blob(['12345']),
    )
    expect(calls.map((c) => c.headers)).toEqual([
      {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '5',
      },
    ])
  })

  // A store behind the spec answering 201 or 204 was warned about as a failed upload.
  it('an upload any 2xx answers is stored, not a refusal', async () => {
    for (const status of [201, 204]) {
      const { fetchImpl } = stub(() => new Response(null, { status }))
      await new NxRemoteCache(
        { url: SERVER, token: '', timeoutMs: 1000, retries: 0 },
        fetchImpl,
      ).put('aa', new Blob(['x']))
    }
  })

  it('a GET answering 500 is an error, not a miss', async () => {
    const { fetchImpl } = stub(() => new Response(null, { status: 500 }))
    await expect(
      new NxRemoteCache({ url: SERVER, token: '', timeoutMs: 1000, retries: 0 }, fetchImpl).get(
        'aa',
      ),
    ).rejects.toThrow('HTTP 500')
  })
  // "HTTP 500" alone said nothing of why (2026-10-23).
  it('a refused GET or PUT says the server’s own words', async () => {
    const { fetchImpl } = stub(() => new Response('disk full', { status: 507 }))
    const c = new NxRemoteCache({ url: SERVER, token: '', timeoutMs: 1000, retries: 0 }, fetchImpl)
    await expect(c.get('aa')).rejects.toThrow('HTTP 507: disk full')
    await expect(c.put('aa', new Blob(['x']))).rejects.toThrow('HTTP 507: disk full')
  })
  // A refused token said only its status: an expired token and a wrong
  // workspace read alike.
  it('a refused token or upload says the server’s own words too', async () => {
    const c = (status: number, body: string): NxRemoteCache =>
      new NxRemoteCache(
        { url: SERVER, token: '', timeoutMs: 1000, retries: 0 },
        stub(() => new Response(body, { status })).fetchImpl,
      )
    await expect(c(401, 'token expired').get('aa')).rejects.toThrow(
      'HTTP 401: token expired: missing or invalid token; remote cache off for this run',
    )
    await expect(c(403, 'read-only token').put('aa', new Blob(['x']))).rejects.toThrow(
      'HTTP 403: read-only token: access forbidden (a read-only token cannot write)',
    )
  })
  it('a GET answering 403 says a read was refused, not a write', async () => {
    const { fetchImpl } = stub(() => new Response(null, { status: 403 }))
    const err = await new NxRemoteCache(
      { url: SERVER, token: '', timeoutMs: 1000, retries: 0 },
      fetchImpl,
    )
      .get('aa')
      .then(
        () => null,
        (e: unknown) => (e as Error).message,
      )
    expect(err).toBe(
      'HTTP 403: access forbidden (the token may not read); remote cache off for this run',
    )
  })
})
