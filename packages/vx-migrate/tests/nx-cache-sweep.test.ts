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
    const msg = (accessToken: string) =>
      refusal(() => resolveNxCacheConfig({ server: SERVER, accessToken }, {}))
    expect([msg('SECRET\r\nX: y'), msg('SECRET\0'), msg('SECRET')]).toEqual([
      'vx/nx-cache: the access token holds a line break or NUL, which no HTTP header can carry — check the secret (it is not printed)',
      'vx/nx-cache: the access token holds a line break or NUL, which no HTTP header can carry — check the secret (it is not printed)',
      '(no refusal)',
    ])
  })

  it('every trailing slash is stripped, and a server of only slashes or nothing declines', () => {
    expect(resolveNxCacheConfig({ server: `${SERVER}//` }, {})?.server).toBe(SERVER)
    expect(resolveNxCacheConfig({ server: '' }, {})).toBeUndefined()
    expect(resolveNxCacheConfig({ server: '/' }, {})).toBeUndefined()
  })

  it('a password with no user name is refused too', () => {
    expect(() => resolveNxCacheConfig({ server: 'http://:pw@nx.invalid' }, {})).toThrow(
      'vx/nx-cache: server carries credentials (user:pass@); pass them as the accessToken instead',
    )
  })

  it('the accessToken option wins over the env; an empty one is no token', () => {
    const env = { NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'env' }
    expect(resolveNxCacheConfig({ server: SERVER, accessToken: 'opt' }, env)).toEqual({
      server: SERVER,
      accessToken: 'opt',
      timeoutMs: 30_000,
      retries: 1,
    })
    expect(resolveNxCacheConfig({ server: SERVER, accessToken: '' }, env)).toEqual({
      server: SERVER,
      timeoutMs: 30_000,
      retries: 1,
    })
  })
})

describe('the requests', () => {
  it('no token sends no Authorization; an upload declares its length', async () => {
    const { fetchImpl, calls } = stub(() => new Response(null, { status: 200 }))
    await new NxRemoteCache({ server: SERVER, timeoutMs: 1000, retries: 0 }, fetchImpl).put(
      'aa',
      new Blob(['12345']),
      { durationMs: 1 },
    )
    expect(calls.map((c) => c.headers)).toEqual([
      { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' },
    ])
  })

  it('a GET answering 500 is an error, not a miss', async () => {
    const { fetchImpl } = stub(() => new Response(null, { status: 500 }))
    await expect(
      new NxRemoteCache({ server: SERVER, timeoutMs: 1000, retries: 0 }, fetchImpl).get('aa'),
    ).rejects.toThrow('HTTP 500')
  })
  it('a GET answering 403 says a read was refused, not a write', async () => {
    const { fetchImpl } = stub(() => new Response(null, { status: 403 }))
    const err = await new NxRemoteCache({ server: SERVER, timeoutMs: 1000, retries: 0 }, fetchImpl)
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
