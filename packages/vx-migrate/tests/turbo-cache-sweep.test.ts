// Item 814's sweep of turbo-cache/index.ts: each row fails with one line of
// the plugin undone. Driven through a stub `fetch`, so a row can read the
// exact request and serve the exact response it is about.
import { describe, expect, it } from 'bun:test'
import { artifactTag, resolveTurboCacheConfig, TurboRemoteCache } from '../src/index.js'

const TOKEN = 't'
const BASE = { apiUrl: 'http://turbo.invalid', token: TOKEN }

interface Call {
  method: string
  headers: Record<string, string>
}

function stub(respond: (method: string, signal: AbortSignal) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ method: init.method!, headers: init.headers as Record<string, string> })
    return respond(init.method!, init.signal!)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const cacheWith = (
  fetchImpl: typeof fetch,
  extra: Parameters<typeof resolveTurboCacheConfig>[0] = {},
) => new TurboRemoteCache(resolveTurboCacheConfig({ ...BASE, ...extra }, {})!, fetchImpl)

describe('resolveTurboCacheConfig, exactly', () => {
  it('a signature key is measured in bytes, and exactly 32 is enough', () => {
    for (const signatureKey of ['€'.repeat(11), 'k'.repeat(32)]) {
      expect(
        resolveTurboCacheConfig({ ...BASE, teamId: 'x', signatureKey }, {})?.signatureKey,
      ).toBe(signatureKey)
    }
  })

  it('the teamId option wins over TURBO_TEAMID', () => {
    expect(
      resolveTurboCacheConfig({ ...BASE, teamId: 'opt' }, { TURBO_TEAMID: 'env' })?.teamId,
    ).toBe('opt')
  })

  it('every trailing slash of the URL is stripped', () => {
    expect(resolveTurboCacheConfig({ ...BASE, apiUrl: 'http://c.invalid//' }, {})?.apiUrl).toBe(
      'http://c.invalid',
    )
  })
})

describe('what a status means', () => {
  it('403 is a refused token too: thrown once, then the layer is off', async () => {
    const { fetchImpl, calls } = stub(() => new Response(null, { status: 403 }))
    const c = cacheWith(fetchImpl)
    await expect(c.has('aa')).rejects.toThrow(
      'HTTP 403: the token was refused; remote cache off for this run',
    )
    expect(await c.has('aa')).toBe(false)
    expect(calls.length).toBe(1)
  })

  it('HEAD and GET answering 500 are errors, not misses', async () => {
    const { fetchImpl } = stub(() => new Response(null, { status: 500 }))
    const c = cacheWith(fetchImpl)
    await expect(c.has('aa')).rejects.toThrow('HTTP 500')
    await expect(c.get('aa')).rejects.toThrow('HTTP 500')
  })

  it('a batch query answering other than 200 is no answer, so each hash is asked', async () => {
    const { fetchImpl } = stub(() => new Response(null, { status: 404 }))
    expect(await cacheWith(fetchImpl).hasMany(['aa'])).toBeNull()
  })

  it('a duration header of 0 or Infinity is no duration', async () => {
    for (const d of ['0', 'Infinity']) {
      const { fetchImpl } = stub(() => new Response('x', { headers: { 'x-artifact-duration': d } }))
      expect((await cacheWith(fetchImpl).get('aa'))?.durationMs).toBeUndefined()
    }
  })
})

describe('the upload', () => {
  it('declares its length and a whole, non-negative duration', async () => {
    const { fetchImpl, calls } = stub(() => new Response(null, { status: 200 }))
    const c = cacheWith(fetchImpl)
    await c.put('aa', new Blob(['12345']), { durationMs: 12.6 })
    await c.put('bb', new Blob(['1']), { durationMs: -5 })
    expect(
      calls.map((x) => [x.headers['Content-Length'], x.headers['x-artifact-duration']]),
    ).toEqual([
      ['5', '13'],
      ['1', '0'],
    ])
  })

  it('runs under the upload deadline, not the request one', async () => {
    // A server that answers after 300 ms: past the 50 ms request deadline,
    // inside the 10 s upload one. The HEAD is the control: same server,
    // same config, and it is the request deadline that ends it.
    const { fetchImpl } = stub(
      (_m, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response(null, { status: 200 })), 300)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(signal.reason as Error)
          })
        }),
    )
    const c = cacheWith(fetchImpl, { timeoutMs: 50, uploadTimeoutMs: 10_000 })
    await expect(c.has('aa')).rejects.toThrow()
    await c.put('aa', new Blob(['x']), { durationMs: 1 })
  })
})

describe('the signed download', () => {
  it('a tag of the wrong length is a refusal, not a RangeError', async () => {
    const key = 'k'.repeat(40)
    const good = await artifactTag(Buffer.from(key), 'aa', 'team_1', new Blob(['x']))
    const { fetchImpl } = stub(
      () => new Response('x', { headers: { 'x-artifact-tag': good.slice(0, 8) } }),
    )
    await expect(
      cacheWith(fetchImpl, { teamId: 'team_1', signatureKey: key }).get('aa'),
    ).rejects.toThrow('the artifact signature did not verify — treated as a miss')
  })
})
