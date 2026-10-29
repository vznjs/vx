// Item 814's sweep of turbo-cache/index.ts: each row fails with one line of
// the plugin undone. Driven through a stub `fetch`, so a row can read the
// exact request and serve the exact response it is about.
import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { artifactTag, resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

const TOKEN = 't'
const BASE = { url: 'http://turbo.invalid', token: TOKEN, retries: 0 }

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
      'turboCache(): the token holds a line break or NUL, which no HTTP header can carry — check the secret (it is not printed)',
      'turboCache(): the token holds a character past Latin-1, which no HTTP header can carry — check the secret (it is not printed)',
      '(no refusal)',
      '(no refusal)',
      'turboCache(): the token holds a line break or NUL, which no HTTP header can carry — check the secret (it is not printed)',
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
    expect(resolveTurboCacheConfig({ ...BASE, url: 'http://c.invalid//' }, {})?.url).toBe(
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
    expect(await c.has('aa')).toBeNull()
    expect(calls.length).toBe(1)
  })

  it('HEAD and GET answering 500 are errors, not misses', async () => {
    const { fetchImpl } = stub(() => new Response(null, { status: 500 }))
    const c = cacheWith(fetchImpl)
    await expect(c.has('aa')).rejects.toThrow('HTTP 500')
    await expect(c.get('aa')).rejects.toThrow('HTTP 500')
  })

  // "HTTP 500" alone said nothing of why (2026-10-23).
  it('a refused GET or PUT says the server’s own words', async () => {
    const { fetchImpl } = stub(() => new Response('quota exceeded\n', { status: 507 }))
    const c = cacheWith(fetchImpl)
    await expect(c.get('aa')).rejects.toThrow('HTTP 507: quota exceeded')
    await expect(c.put('aa', new Blob(['x']), { durationMs: 1 })).rejects.toThrow(
      'HTTP 507: quota exceeded',
    )
  })

  it('a server with no batch query is no answer, so each hash is asked', async () => {
    for (const status of [404, 405, 501]) {
      const { fetchImpl } = stub(() => new Response(null, { status }))
      expect(await cacheWith(fetchImpl).hasMany(['aa'])).toBeNull()
    }
  })

  // Main f71b377 asked Vercel for 107 hashes at once: "Too many hashes. Limit is 100."
  it('a batch query carries at most 100 hashes', async () => {
    const sizes: number[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { hashes } = JSON.parse(init.body as string) as { hashes: string[] }
      sizes.push(hashes.length)
      if (hashes.length > 100) return Response.json({ error: {} }, { status: 400 })
      return Response.json(Object.fromEntries(hashes.map((h) => [h, { size: 1 }])))
    }) as unknown as typeof fetch
    const hashes = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(4, '0'))
    const held = await cacheWith(fetchImpl).hasMany(hashes)
    expect({ sizes: sizes.sort((a, b) => b - a), held: held?.size }).toEqual({
      sizes: [100, 100, 50],
      held: 250,
    })
  })

  // Main f71b377: the batch query gave no answer and nothing said why.
  it('a batch query refused for another reason says its status and body', async () => {
    const { fetchImpl } = stub(() =>
      Response.json({ error: { code: 'bad_request' } }, { status: 400 }),
    )
    await expect(cacheWith(fetchImpl).hasMany(['aa'])).rejects.toThrow(
      'batch query answered HTTP 400: {"error":{"code":"bad_request"}}',
    )
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
      new Map([['aa', { size: 1, durationMs: 2 }]]),
    )
  })

  // A 200 that was no JSON object threw a parser's line naming no query
  // (`null`, a proxy page), or read as every hash absent (`[]`, `"x"`).
  it('a batch answer that is no JSON object is a refusal that says what came', async () => {
    const said: string[] = []
    for (const body of ['null', '[]', '"x"', '<html> proxy </html>', '']) {
      const { fetchImpl } = stub(() => new Response(body))
      said.push(
        await cacheWith(fetchImpl)
          .hasMany(['aa'])
          .then(
            (m) => `answered ${m?.size}`,
            (err: Error) => err.message,
          ),
      )
    }
    const no = 'batch query answered HTTP 200 with no JSON object'
    expect(said).toEqual([
      `${no}: null`,
      `${no}: []`,
      `${no}: "x"`,
      `${no}: <html> proxy </html>`,
      no,
    ])
  })

  it('a batch reply past its bound is a refusal that says so, read no further (L-9)', async () => {
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
    const said = await cacheWith(fetchImpl)
      .hasMany(['aa'])
      .catch((err: Error) => err.message)
    expect({ said, stopped: pulled < 1024 * 1024 }).toEqual({
      said: 'batch query answered past 69632 bytes; read no further',
      stopped: true,
    })
    // A length header past the bound is not read at all.
    const { fetchImpl: declared } = stub(
      () => new Response('{}', { headers: { 'content-length': String(1024 * 1024) } }),
    )
    await expect(cacheWith(declared).hasMany(['aa'])).rejects.toThrow('past 69632 bytes')
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
    const { fetchImpl, calls } = stub(
      (method) => new Response(null, { status: method === 'HEAD' ? 404 : 200 }),
    )
    const c = cacheWith(fetchImpl)
    await c.put('aa', new Blob(['12345']), { durationMs: 12.6 })
    await c.put('bb', new Blob(['1']), { durationMs: -5 })
    expect(
      calls
        .filter((x) => x.method === 'PUT')
        .map((x) => [x.headers['Content-Length'], x.headers['x-artifact-duration']]),
    ).toEqual([
      ['5', '13'],
      ['1', '0'],
    ])
  })

  it('any 2xx is stored, as for turbo; a 3xx or 4xx is not', async () => {
    // Turbo's client takes any 2xx (`error_for_status`); a server answering
    // 201 or 204 stored the artifact and vx counted a failed upload.
    const verdict = async (status: number) => {
      const { fetchImpl } = stub(
        (method) => new Response(null, { status: method === 'HEAD' ? 404 : status }),
      )
      return cacheWith(fetchImpl)
        .put('aa', new Blob(['x']), { durationMs: 1 })
        .then(
          () => 'ok',
          (err: Error) => err.message,
        )
    }
    expect(await Promise.all([200, 201, 202, 204, 299, 304, 400].map(verdict))).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'HTTP 304',
      'HTTP 400',
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

describe('a put never replaces a stored artifact (2026-10-15)', () => {
  // Turbo's PUT overwrites; an entry is immutable, and core asks no `has`
  // before a put, so the wire asks.
  it('asks HEAD first and sends nothing for a key the server holds', async () => {
    const { fetchImpl, calls } = stub((method) =>
      method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(null),
    )
    await cacheWith(fetchImpl).put('aa', new Blob(['x']), { durationMs: 1 })
    expect(calls.map((r) => r.method)).toEqual(['HEAD'])
  })

  it('asks nothing first for a key a 404 or a batch answer said is absent', async () => {
    const { fetchImpl, calls } = stub((method) =>
      method === 'POST'
        ? new Response(JSON.stringify({ bb: null }))
        : new Response(null, { status: method === 'PUT' ? 200 : 404 }),
    )
    const c = cacheWith(fetchImpl)
    expect(await c.get('aa')).toBeNull()
    expect(await c.hasMany(['bb'])).toEqual(new Map())
    await c.put('aa', new Blob(['x']), { durationMs: 1 })
    await c.put('bb', new Blob(['x']), { durationMs: 1 })
    expect(calls.map((r) => r.method)).toEqual(['GET', 'POST', 'PUT', 'PUT'])
  })

  // A DTE worker never saw the run's probe: it HEADed every upload (2026-10-25).
  it('asks nothing first for a key the run says is absent', async () => {
    const { fetchImpl, calls } = stub(() => new Response(null))
    const c = cacheWith(fetchImpl)
    c.missing('aa')
    await c.put('aa', new Blob(['x']), { durationMs: 1 })
    expect(calls.map((r) => r.method)).toEqual(['PUT'])
  })

  it('a HEAD that fails uploads, as before', async () => {
    const { fetchImpl, calls } = stub((method) =>
      method === 'HEAD' ? new Response(null, { status: 500 }) : new Response(null),
    )
    await cacheWith(fetchImpl).put('aa', new Blob(['x']), { durationMs: 1 })
    expect(calls.map((r) => r.method)).toEqual(['HEAD', 'PUT'])
  })
})

describe('a read-only token or server', () => {
  // turborepo-remote-cache under READ_ONLY (or a JWT without the write
  // scope) answers an upload 403 and still serves reads.
  it("an upload's 403 turns off uploads alone, said once; reads go on", async () => {
    let stored = false
    const { fetchImpl, calls } = stub((method) =>
      method === 'PUT'
        ? new Response(null, { status: 403 })
        : stored
          ? new Response('bytes')
          : new Response(null, { status: 404 }),
    )
    const c = cacheWith(fetchImpl)
    await expect(c.put('aa', new Blob(['x']), { durationMs: 1 })).rejects.toThrow(
      'HTTP 403: the upload was refused (a read-only token or server); uploads off for this run, reads go on',
    )
    expect(await c.put('bb', new Blob(['x']), { durationMs: 1 })).toBe(false)
    stored = true
    expect(await c.has('aa')).not.toBeNull()
    expect(await (await c.get('aa'))!.body.text()).toBe('bytes')
    expect(calls.map((r) => r.method)).toEqual(['HEAD', 'PUT', 'HEAD', 'GET'])
  })
})
