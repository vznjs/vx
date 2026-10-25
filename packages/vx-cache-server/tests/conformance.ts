// The vx-cache v1 conformance suite (PROTOCOL.md): what any server that
// speaks it answers. Each backend this package ships runs it: Bun with an
// S3 bucket (bun.test.ts), many Bun nodes over Postgres (nodes.test.ts) and
// workerd with D1 and R2 (worker.test.ts). Every request carries a CI
// OIDC token from tests/issuer.ts, whose TRUST the target serves.

import { beforeAll, describe, expect, it } from 'bun:test'
import type { JWTPayload } from 'jose'
import { BRANCH_JOB, READ_JOB, TRUSTED_JOB } from './issuer.js'
import { upload as uploadInit } from './upload.js'

export interface Target {
  /** The server's URL. */
  base(): string
  /** A token of `claims` for the server. */
  sign(claims: JWTPayload): Promise<string>
  /** The largest artifact it stores. */
  readonly maxUploadBytes: number
}

/** A fresh key per call: every target is shared by the whole suite. */
const key = (): string => crypto.randomUUID().replaceAll('-', '')

export function conformance(name: string, target: Target): void {
  let read = ''
  let write = ''
  let branch = ''
  beforeAll(async () => {
    ;[read, write, branch] = await Promise.all([
      target.sign(READ_JOB),
      target.sign(TRUSTED_JOB),
      target.sign(BRANCH_JOB),
    ])
  })
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = read, ...rest } = init
    const headers = new Headers(rest.headers)
    if (token !== null) headers.set('authorization', `Bearer ${token}`)
    return fetch(new URL(path, target.base()), { ...rest, headers })
  }
  const upload = (
    items: [string, Blob | Uint8Array | string][],
    token = write,
    timings?: unknown[],
  ) => {
    const { headers, ...init } = uploadInit(items, token, timings)
    delete headers.authorization
    return call('/v1/artifacts/upload', { ...init, headers, token })
  }
  const put = (k: string, body: Blob | Uint8Array | string, token = write) =>
    upload([[k, body]], token)
  const json = (path: string, body: unknown, token = read, headers: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
      token,
    })
  const scopes = (value: string) => ({ 'x-artifact-read-scopes': value })

  describe(`${name} speaks vx-cache v1`, () => {
    it('refuses a request with no CI token, a bad one or one of another repository', async () => {
      for (const token of [null, 'nope', 'a.b.c']) {
        const res = await call(`/v1/artifacts/download/${key()}`, { token })
        expect(res.status).toBe(401)
        expect(res.headers.get('content-type')).toStartWith('application/json')
        expect(await res.json()).toEqual({ code: 'unauthorized', message: expect.any(String) })
      }
      const other = await target.sign({ ...TRUSTED_JOB, repository_id: '7' })
      expect((await call(`/v1/artifacts/download/${key()}`, { token: other })).status).toBe(403)
    })

    it('refuses Turbo’s team params: the token names the repository', async () => {
      const res = await call(`/v1/artifacts/download/${key()}?teamId=t`)
      expect(res.status).toBe(400)
    })

    it('stores an artifact once and reads it back', async () => {
      const k = key()
      const missing = await call(`/v1/artifacts/download/${k}`)
      expect([missing.status, await missing.json()]).toEqual([
        404,
        { code: 'not_found', message: 'no artifact under this key' },
      ])
      expect((await put(k, 'first')).status).toBe(204)
      // Immutable: a second upload keeps the stored bytes.
      expect((await put(k, 'second')).status).toBe(204)
      const got = await call(`/v1/artifacts/download/${k}`)
      expect([
        got.status,
        got.headers.get('content-type'),
        got.headers.get('content-length'),
        await got.text(),
      ]).toEqual([200, 'application/octet-stream', '5', 'first'])
    })

    it('answers an upload of held hashes before reading its bytes', async () => {
      const [a, b] = [key(), key()]
      await upload([
        [a, 'held'],
        [b, 'too'],
      ])
      const line = JSON.stringify({
        artifacts: [
          { hash: a, size: 4 },
          { hash: b, size: target.maxUploadBytes - 4 },
        ],
      })
      // Bytes that never end: only an answer before they are read returns.
      const body = new ReadableStream<Uint8Array>({
        start: (c) => c.enqueue(new TextEncoder().encode(`${line}\n${'x'.repeat(65_536)}`)),
      })
      const res = await call('/v1/artifacts/upload', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/vnd.vx-cache.batch',
          'content-length': String(line.length + 1 + target.maxUploadBytes),
        },
        token: write,
        duplex: 'half',
        signal: AbortSignal.timeout(5_000),
      } as RequestInit)
      expect(res.status).toBe(204)
      expect(await (await call(`/v1/artifacts/download/${a}`)).text()).toBe('held')
    })

    it('stores many artifacts of one upload, skipping the bytes of held ones', async () => {
      const [a, b, c] = [key(), key(), key()]
      await put(b, 'held')
      const res = await upload([
        [a, 'first'],
        [b, 'over'],
        [c, new Uint8Array(70_000).fill(7)],
      ])
      expect(res.status).toBe(204)
      const text = async (k: string) => (await call(`/v1/artifacts/download/${k}`)).text()
      expect([await text(a), await text(b), (await text(c)).length]).toEqual([
        'first',
        'held',
        70_000,
      ])
    })

    it('stores an empty artifact and one of many megabytes', async () => {
      const empty = key()
      expect((await put(empty, new Uint8Array(0))).status).toBe(204)
      expect(await (await call(`/v1/artifacts/download/${empty}`)).text()).toBe('')
      const big = key()
      const bytes = crypto.getRandomValues(new Uint8Array(65_536)).map((_, i) => i)
      const body = new Uint8Array(6 * 1024 * 1024)
      for (let i = 0; i < body.length; i += bytes.length) body.set(bytes, i)
      expect((await put(big, body)).status).toBe(204)
      const got = new Uint8Array(await (await call(`/v1/artifacts/download/${big}`)).arrayBuffer())
      expect(Bun.hash(got)).toBe(Bun.hash(body))
    })

    it('keeps one whole artifact when writes of the same hash race, from any node', async () => {
      for (let round = 0; round < 5; round++) {
        const k = key()
        const bodies = ['a', 'b', 'bb'.repeat(500), 'cc'.repeat(500), 'd'.repeat(70_000)]
        await Promise.all(bodies.map((b) => put(k, b)))
        const text = await (await call(`/v1/artifacts/download/${k}`)).text()
        expect(bodies).toContain(text)
        // The row's size is the blob's.
        const res = await json('/v1/artifacts/check', { hashes: [k] })
        expect(await res.json()).toEqual({ [k]: { size: text.length } })
      }
    })

    it('refuses a write by a read-only token, a bad list and an upload too large', async () => {
      const res = await put(key(), 'x', read)
      expect([res.status, await res.json()]).toEqual([
        403,
        { code: 'forbidden', message: 'this token reads only' },
      ])
      expect((await put('a-b', 'x')).status).toBe(400)
      expect((await put('f'.repeat(129), 'x')).status).toBe(400)
      expect((await upload([])).status).toBe(400)
      const k = key()
      expect(
        (
          await upload([
            [k, 'a'],
            [k, 'b'],
          ])
        ).status,
      ).toBe(400)
      expect((await put(key(), new Uint8Array(target.maxUploadBytes + 1))).status).toBe(413)
      const short = await call('/v1/artifacts/upload', {
        method: 'POST',
        body: `${JSON.stringify({ artifacts: [{ hash: key(), size: 5 }] })}\nabc`,
        headers: { 'content-type': 'application/vnd.vx-cache.batch' },
        token: write,
      })
      expect([short.status, ((await short.json()) as { message: string }).message]).toEqual([
        400,
        'Content-Length is not the line and the sizes it names',
      ])
    })

    it('names its limits on every check, and all of them at /v1/capabilities', async () => {
      const res = await json('/v1/artifacts/check', { hashes: [] })
      const limits = {
        maxBatchArtifacts: 100,
        maxUploadBytes: target.maxUploadBytes,
      }
      expect([
        Number(res.headers.get('x-vx-max-batch-artifacts')),
        Number(res.headers.get('x-vx-max-upload-bytes')),
      ]).toEqual(Object.values(limits))
      const caps = await call('/v1/capabilities')
      expect(await caps.json()).toEqual({
        ...limits,
        maxUploadTimings: 1000,
        maxCheckHashes: 1000,
        maxTimingsUploaded: 20_000,
        maxQueryHashes: 1000,
        maxQueryLimit: 20,
      })
      expect((await call('/v1/capabilities', { token: null })).status).toBe(401)
    })

    it('answers every hash of a batch lookup, null for one it does not hold', async () => {
      const [a, b] = [key(), key()]
      await put(a, 'abc')
      const res = await json('/v1/artifacts/check', { hashes: [a, b] })
      expect(await res.json()).toEqual({ [a]: { size: 3 }, [b]: null })
      expect((await json('/v1/artifacts/check', { hashes: Array(1001).fill(a) })).status).toBe(400)
      expect((await json('/v1/artifacts/check', { hashes: ['a-b'] })).status).toBe(400)
      const plain = await call('/v1/artifacts/check', {
        method: 'POST',
        body: '{"hashes":[]}',
      })
      expect(plain.status).toBe(400)
    })

    it("writes a branch's job to its branch, read only by a run naming that ref", async () => {
      const k = key()
      expect((await put(k, 'branch', branch)).status).toBe(204)
      expect((await call(`/v1/artifacts/download/${k}`)).status).toBe(404)
      const named = await call(`/v1/artifacts/download/${k}`, {
        headers: scopes('"refs/heads/feature", "refs/heads/main"'),
      })
      expect([named.status, await named.text()]).toEqual([200, 'branch'])
      // Its own scope first, then trusted.
      await put(k, 'trusted')
      expect(await (await call(`/v1/artifacts/download/${k}`)).text()).toBe('trusted')
      const first = await call(`/v1/artifacts/download/${k}`, {
        headers: scopes('"refs/heads/feature"'),
      })
      expect(await first.text()).toBe('branch')
    })

    it('reads a ref a trust rule names as trusted, and refuses a bad list', async () => {
      const k = key()
      await put(k, 'abc')
      const scoped = (value: string) =>
        call(`/v1/artifacts/download/${k}`, { headers: scopes(value) })
      expect((await scoped('"refs/heads/gh-readonly-queue/main/pr-1"')).status).toBe(200)
      for (const bad of ['refs/heads/x', '"heads/x"', '"refs/x', '"refs/x" "refs/y"']) {
        expect([bad, (await scoped(bad)).status]).toEqual([bad, 400])
      }
      const nine = Array.from({ length: 9 }, (_, i) => `"refs/heads/${i}"`).join(', ')
      expect((await scoped(nine)).status).toBe(400)
    })

    it('keeps timings and answers the newest, trusted first, then the refs in order', async () => {
      const h = key()
      const timing = (durationMs: number) => ({ hash: h, durationMs, cores: 1.5, rssBytes: 1000 })
      for (const ms of [10, 20, 30]) {
        expect((await json('/v1/timings/upload', { timings: [timing(ms)] }, write)).status).toBe(
          204,
        )
        // A timing's time is the server's: the next write is a later one.
        await Bun.sleep(5)
      }
      expect((await json('/v1/timings/upload', { timings: [timing(99)] }, branch)).status).toBe(204)
      const ask = async (body: unknown, headers: Record<string, string> = {}) =>
        ((await (await json('/v1/timings/query', body, read, headers)).json()) as any).timings
      const ms = (list: { durationMs: number }[]) => list.map((s) => s.durationMs)
      expect(ms((await ask({ hashes: [h] }))[h])).toEqual([30, 20, 10])
      expect((await ask({ hashes: [h], limit: 1 }))[h]).toEqual([
        { durationMs: 30, cores: 1.5, rssBytes: 1000 },
      ])
      const both = await ask({ hashes: [h, 'none'], limit: 4 }, scopes('"refs/heads/feature"'))
      expect([ms(both[h]), both['none']]).toEqual([[30, 20, 10, 99], []])
    })

    it('keeps the timings an upload carries, also when it answers before the bytes', async () => {
      const [a, h1, h2] = [key(), key(), key()]
      const res = await upload([[a, 'x']], write, [{ hash: h1, durationMs: 7 }])
      expect(res.status).toBe(204)
      // Held: answered early, and its timings kept.
      expect((await upload([[a, 'x']], write, [{ hash: h2, durationMs: 9 }])).status).toBe(204)
      const got = await json('/v1/timings/query', { hashes: [h1, h2] })
      expect(((await got.json()) as any).timings).toEqual({
        [h1]: [{ durationMs: 7, cores: null, rssBytes: null }],
        [h2]: [{ durationMs: 9, cores: null, rssBytes: null }],
      })
      const bad = await upload([[key(), 'x']], write, [{ hash: h1 }])
      expect(bad.status).toBe(400)
    })

    it('refuses timings from a read-only token and timings that are not some', async () => {
      const ok = { hash: 'a', durationMs: 1 }
      expect((await json('/v1/timings/upload', { timings: [ok] })).status).toBe(403)
      for (const [bad, detail] of [
        [{ ...ok, hash: '' }, 'timings[0].hash: a string of up to 512 characters'],
        [{ ...ok, durationMs: 1.5 }, 'timings[0].durationMs: whole milliseconds'],
        [{ ...ok, cores: -1 }, 'timings[0].cores: a number of cores'],
        [{ ...ok, rssBytes: 'x' }, 'timings[0].rssBytes: a byte count'],
      ] as const) {
        const res = await json('/v1/timings/upload', { timings: [bad] }, write)
        expect([res.status, await res.json()]).toEqual([
          400,
          { code: 'bad_request', message: detail },
        ])
      }
      expect((await json('/v1/timings/query', { hashes: ['a'], limit: 21 })).status).toBe(400)
      expect((await json('/v1/timings/query', { hashes: [1] })).status).toBe(400)
    })

    it('downloads many artifacts in one answer, the held ones in the order asked', async () => {
      const [a, b, c] = [key(), key(), key()]
      await upload([
        [a, 'first'],
        [c, new Uint8Array(70_000).fill(7)],
      ])
      const res = await json('/v1/artifacts/download', { hashes: [c, b, a] })
      expect(res.headers.get('content-type')).toBe('application/vnd.vx-cache.batch')
      const bytes = new Uint8Array(await res.arrayBuffer())
      const nl = bytes.indexOf(10)
      expect(JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)))).toEqual({
        artifacts: [
          { hash: c, size: 70_000 },
          { hash: a, size: 5 },
        ],
      })
      expect(bytes.length).toBe(nl + 1 + 70_005)
      expect(bytes.subarray(nl + 1, nl + 70_001).every((x) => x === 7)).toBe(true)
      expect(new TextDecoder().decode(bytes.subarray(nl + 70_001))).toBe('first')
      expect((await json('/v1/artifacts/download', { hashes: Array(101).fill(a) })).status).toBe(
        400,
      )
    })

    it('answers an unknown route 404 and a wrong method 405', async () => {
      expect((await call('/v2/artifacts/abc')).status).toBe(404)
      const head = await call(`/v1/artifacts/download/${key()}`, { method: 'HEAD' })
      expect([head.status, head.headers.get('allow')]).toEqual([405, 'GET'])
      const res = await call('/v1/timings/query', { method: 'DELETE' })
      expect([res.status, res.headers.get('allow')]).toEqual([405, 'POST'])
    })
  })
}
