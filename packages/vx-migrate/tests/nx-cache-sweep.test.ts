// Item 815's sweep of nx-cache/index.ts: each row fails with one line of the
// plugin undone. Driven through a stub `fetch`, so a row reads the exact
// request and serves the exact response it is about.
import { describe, expect, it } from 'bun:test'
import { NxRemoteCache, resolveNxCacheConfig } from '../src/index.js'

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

describe('resolveNxCacheConfig, exactly', () => {
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
    })
    expect(resolveNxCacheConfig({ server: SERVER, accessToken: '' }, env)).toEqual({
      server: SERVER,
      timeoutMs: 30_000,
    })
  })
})

describe('the requests', () => {
  it('no token sends no Authorization; an upload declares its length', async () => {
    const { fetchImpl, calls } = stub(() => new Response(null, { status: 200 }))
    await new NxRemoteCache({ server: SERVER, timeoutMs: 1000 }, fetchImpl).put(
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
      new NxRemoteCache({ server: SERVER, timeoutMs: 1000 }, fetchImpl).get('aa'),
    ).rejects.toThrow('HTTP 500')
  })

  it('the probe’s response serves ONE get: the next get fetches again', async () => {
    let n = 0
    const { fetchImpl, calls } = stub(() => new Response(`body ${++n}`))
    const c = new NxRemoteCache({ server: SERVER, timeoutMs: 1000 }, fetchImpl)
    expect(await c.has('aa')).toBe(true)
    const first = await c.get('aa')
    expect(await first!.body.text()).toBe('body 1')
    const second = await c.get('aa')
    expect(await second!.body.text()).toBe('body 2')
    expect(calls.length).toBe(2)
  })
})
