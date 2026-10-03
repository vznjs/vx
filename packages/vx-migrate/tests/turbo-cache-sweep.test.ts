// Item 814's sweep of turbo-cache/index.ts: each row fails with one line of
// the plugin undone. Driven through a stub `fetch`, so a row can read the
// exact request and serve the exact response it is about.
import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { artifactTag, resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

const TOKEN = 't'
const BASE = { apiUrl: 'http://turbo.invalid', token: TOKEN, retries: 0 }

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

const refusal = (f: () => unknown): string => {
  try {
    f()
    return '(no refusal)'
  } catch (err) {
    return (err as Error).message
  }
}

describe('resolveTurboCacheConfig, exactly', () => {
  // Item 928: fetch refuses a token no header can carry and QUOTES it in its
  // error, which every degrade warning printed.
  it('a token no header can carry is refused, and not printed', () => {
    const msg = (token: string) => refusal(() => resolveTurboCacheConfig({ ...BASE, token }, {}))
    expect([
      msg('ghp_SECRET\nline2'),
      msg('ghp_SECRET€'),
      msg('ghp_SECRET\n'),
      msg('sécret'),
      // A CR alone, and U+00FF, Latin-1's last: Bun's Headers refuses the one, takes the other.
      msg('ghp_SECRET\rline2'),
      msg('secretÿ'),
    ]).toEqual([
      'vx/turbo-cache: the token holds a line break or NUL, which no HTTP header can carry — check the secret (it is not printed)',
      'vx/turbo-cache: the token holds a character past Latin-1, which no HTTP header can carry — check the secret (it is not printed)',
      '(no refusal)',
      '(no refusal)',
      'vx/turbo-cache: the token holds a line break or NUL, which no HTTP header can carry — check the secret (it is not printed)',
      '(no refusal)',
    ])
  })

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

  // Item 929: the batch query answers each hash with ArtifactInfo, null, or
  // an error entry, and an error entry was counted as present.
  it('a batch query holds only the hashes answered with artifact info', async () => {
    const { fetchImpl } = stub(() =>
      Response.json({
        aa: { size: 1, taskDurationMs: 2, tag: '' },
        bb: null,
        cc: { error: { message: 'not found' } },
        dd: 'nonsense',
      }),
    )
    expect(await cacheWith(fetchImpl).hasMany(['aa', 'bb', 'cc', 'dd', 'ee'])).toEqual(
      new Set(['aa']),
    )
  })

  it('a batch reply past its bound is no answer, read no further (L-9)', async () => {
    let pulled = 0
    const chunk = new Uint8Array(64 * 1024).fill(32)
    const { fetchImpl } = stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (pulled >= 64 * 1024 * 1024) return c.close()
              pulled += chunk.byteLength
              c.enqueue(chunk)
            },
          }),
        ),
    )
    expect({
      answer: await cacheWith(fetchImpl).hasMany(['aa']),
      stopped: pulled < 1024 * 1024,
    }).toEqual({ answer: null, stopped: true })
    // A length header past the bound is not read at all.
    const { fetchImpl: declared } = stub(
      () => new Response('{}', { headers: { 'content-length': String(1024 * 1024) } }),
    )
    expect(await cacheWith(declared).hasMany(['aa'])).toBeNull()
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
  it('a body past the bound is refused as it passes it, and its temp removed (L-8)', async () => {
    // Written whole before its tag is checked, a body that never ended
    // filled the temp's disk. The source counts what it gave.
    const key = 'k'.repeat(40)
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-l8-'))
    let pulled = 0
    const chunk = new Uint8Array(64 * 1024)
    const { fetchImpl } = stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (pulled >= 64 * 1024 * 1024) return c.close()
              pulled += chunk.byteLength
              c.enqueue(chunk)
            },
          }),
          { headers: { 'x-artifact-tag': 'x' } },
        ),
    )
    const cache = new TurboRemoteCache(
      resolveTurboCacheConfig({ ...BASE, teamId: 'team_1', signatureKey: key }, {})!,
      fetchImpl,
      dir,
      Bun.sleep,
      1024 * 1024,
    )
    try {
      const got = await cache.get('aa').then(
        () => 'resolved',
        (e: Error) => e.message,
      )
      expect({ got, stopped: pulled < 8 * 1024 * 1024, left: await readdir(dir) }).toEqual({
        got: 'the signed artifact runs past 1048576 bytes — treated as a miss',
        stopped: true,
        left: [],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

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
