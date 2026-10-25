// The vx-cache v1 conformance suite (PROTOCOL.md): what any server that
// speaks it answers. Each backend this package ships runs it: Bun with an
// S3 bucket (bun.test.ts), workerd with R2 (worker.test.ts) and the Docker
// image (docker/smoke.sh). Every request carries a CI
// OIDC token from tests/issuer.ts, whose TRUST the target serves.

import { beforeAll, describe, expect, it } from 'bun:test'
import { upload as uploadInit } from './upload.js'

export type Job = 'main' | 'read' | 'branch' | 'stranger'

export interface Target {
  /** The server's URL. */
  base(): string
  /**
   * A token for the server of a job that writes main (a ref a trust rule
   * protects), one on main that only reads, one that writes its branch
   * (`refs/heads/feature`), or a main job of a repository the server
   * does not serve.
   */
  sign(job: Job): Promise<string>
  /** The limits it was given. */
  readonly maxCheckKeys: number
  readonly maxBatchArtifacts: number
  readonly maxUploadBytes: number
}

/** A ref's scope on the wire, by an implementation apart from the server's. */
export const scopeOf = (ref: string): string =>
  new Bun.CryptoHasher('sha256').update(ref).digest('hex').slice(0, 32)

/** A fresh key per call: every target is shared by the whole suite. */
const key = (): string => crypto.randomUUID().replaceAll('-', '')

export function conformance(name: string, target: Target): void {
  let read = ''
  let write = ''
  let branch = ''
  beforeAll(async () => {
    ;[read, write, branch] = await Promise.all([
      target.sign('read'),
      target.sign('main'),
      target.sign('branch'),
    ])
  })
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = read, ...rest } = init
    const headers = new Headers(rest.headers)
    if (token !== null) headers.set('authorization', `Bearer ${token}`)
    return fetch(new URL(path, target.base()), { ...rest, headers })
  }
  const upload = (items: [string, Blob | Uint8Array | string][], token = write) => {
    const { headers, ...init } = uploadInit(items, token)
    delete headers.authorization
    return call('/v1/artifacts/upload', { ...init, headers, token })
  }
  /** One artifact alone, its bytes the body. */
  const put = (k: string, body: Blob | Uint8Array | string, token = write) =>
    call(`/v1/artifacts/${k}`, {
      method: 'PUT',
      body,
      headers: { 'content-type': 'application/octet-stream' },
      token,
    })
  const json = (path: string, body: unknown, token = read) =>
    call(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      token,
    })
  const MAIN = scopeOf('refs/heads/main')
  const FEATURE = scopeOf('refs/heads/feature')
  /** One artifact's bytes, read from `scope`. */
  const get = (k: string, scope = MAIN) =>
    call(`/v1/artifacts/download/${k}`, { headers: { 'x-vx-scope': scope } })
  const text = async (k: string, scope = MAIN) => (await get(k, scope)).text()
  const sizes = async (keys: [string, string][]) =>
    (
      (await (
        await json('/v1/artifacts/check', { keys: keys.map(([scope, hash]) => ({ scope, hash })) })
      ).json()) as { sizes: (number | null)[] }
    ).sizes

  describe(`${name} speaks vx-cache v1`, () => {
    it('refuses a request with no CI token, a bad one or one of another repository', async () => {
      for (const token of [null, 'nope', 'a.b.c']) {
        const res = await call(`/v1/artifacts/download/${key()}`, { token })
        expect(res.status).toBe(401)
        expect(res.headers.get('content-type')).toStartWith('application/json')
        expect(await res.json()).toEqual({ code: 'unauthorized', message: expect.any(String) })
      }
      const other = await target.sign('stranger')
      expect((await call(`/v1/artifacts/download/${key()}`, { token: other })).status).toBe(403)
    })

    it('refuses Turbo’s team params: the token names the repository', async () => {
      const res = await call(`/v1/artifacts/download/${key()}?teamId=t`)
      expect(res.status).toBe(400)
    })

    it('stores an artifact once and reads it back', async () => {
      const k = key()
      const missing = await get(k)
      expect([missing.status, await missing.json()]).toEqual([
        404,
        { code: 'not_found', message: 'no artifact under this key' },
      ])
      expect((await put(k, 'first')).status).toBe(204)
      // Immutable: a second upload, alone or in a batch, keeps the stored bytes.
      expect((await put(k, 'second')).status).toBe(204)
      expect((await upload([[k, 'third']])).status).toBe(204)
      const got = await get(k)
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
      expect(await text(a)).toBe('held')
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
      expect([await text(a), await text(b), (await text(c)).length]).toEqual([
        'first',
        'held',
        70_000,
      ])
    })

    it('stores an empty artifact and one of many megabytes', async () => {
      const empty = key()
      expect((await put(empty, new Uint8Array(0))).status).toBe(204)
      expect(await text(empty)).toBe('')
      const big = key()
      const bytes = crypto.getRandomValues(new Uint8Array(65_536)).map((_, i) => i)
      const body = new Uint8Array(6 * 1024 * 1024)
      for (let i = 0; i < body.length; i += bytes.length) body.set(bytes, i)
      expect((await put(big, body)).status).toBe(204)
      const got = new Uint8Array(await (await get(big)).arrayBuffer())
      expect(Bun.hash(got)).toBe(Bun.hash(body))
    })

    it('keeps one whole artifact when writes of the same hash race, from any node', async () => {
      for (let round = 0; round < 5; round++) {
        const k = key()
        const bodies = ['a', 'b', 'bb'.repeat(500), 'cc'.repeat(500), 'd'.repeat(70_000)]
        await Promise.all(bodies.map((b) => put(k, b)))
        const got = await text(k)
        expect(bodies).toContain(got)
        // The size a check names is the bytes'.
        expect(await sizes([[MAIN, k]])).toEqual([got.length])
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

    it('names its limits on every check, and at /v1/capabilities', async () => {
      const res = await json('/v1/artifacts/check', { keys: [] })
      const limits = {
        maxCheckKeys: target.maxCheckKeys,
        maxBatchArtifacts: target.maxBatchArtifacts,
        maxUploadBytes: target.maxUploadBytes,
      }
      expect([
        Number(res.headers.get('x-vx-max-check-keys')),
        Number(res.headers.get('x-vx-max-batch-artifacts')),
        Number(res.headers.get('x-vx-max-upload-bytes')),
      ]).toEqual(Object.values(limits))
      expect(await (await call('/v1/capabilities')).json()).toEqual(limits)
      expect((await call('/v1/capabilities', { token: null })).status).toBe(401)
    })

    it('answers each exact key of a check in order, null for one it does not hold', async () => {
      const [a, b] = [key(), key()]
      await put(a, 'abc')
      expect(
        await sizes([
          [MAIN, a],
          [MAIN, b],
          [FEATURE, a],
        ]),
      ).toEqual([3, null, null])
      const many = Array(target.maxCheckKeys + 1).fill({ scope: MAIN, hash: a })
      expect((await json('/v1/artifacts/check', { keys: many })).status).toBe(400)
      for (const bad of [{ scope: MAIN, hash: 'a-b' }, { hash: a }, { scope: 'main', hash: a }]) {
        expect((await json('/v1/artifacts/check', { keys: [bad] })).status).toBe(400)
      }
      const plain = await call('/v1/artifacts/check', { method: 'POST', body: '{"keys":[]}' })
      expect(plain.status).toBe(400)
    })

    it("writes a branch's job to its branch, read only by naming that ref", async () => {
      const k = key()
      expect((await put(k, 'branch', branch)).status).toBe(204)
      expect((await get(k)).status).toBe(404)
      expect(await text(k, FEATURE)).toBe('branch')
      // Exact: main's bytes never answer for the branch, nor the branch's for main.
      await put(k, 'main')
      expect([await text(k), await text(k, FEATURE)]).toEqual(['main', 'branch'])
    })

    it("reads only the exact ref named, and refuses a read naming no ref's hash", async () => {
      const k = key()
      await put(k, 'abc')
      expect((await get(k, scopeOf('refs/heads/gh-readonly-queue/main/pr-1'))).status).toBe(404)
      expect((await call(`/v1/artifacts/download/${k}`)).status).toBe(400)
      // A plain ref never goes on the wire: it is refused, not hashed.
      for (const bad of ['refs/heads/main', MAIN.toUpperCase(), MAIN.slice(1)]) {
        expect([bad, (await get(k, bad)).status]).toEqual([bad, 400])
      }
    })

    it('downloads many exact keys in one answer, the held ones in the order asked', async () => {
      const [a, b, c] = [key(), key(), key()]
      await upload([
        [a, 'first'],
        [c, new Uint8Array(70_000).fill(7)],
      ])
      await put(b, 'mine', branch)
      const keys = [
        { scope: MAIN, hash: c },
        { scope: MAIN, hash: b },
        { scope: FEATURE, hash: b },
        { scope: MAIN, hash: a },
      ]
      const res = await json('/v1/artifacts/download', { keys })
      expect(res.headers.get('content-type')).toBe('application/vnd.vx-cache.batch')
      const bytes = new Uint8Array(await res.arrayBuffer())
      const nl = bytes.indexOf(10)
      expect(JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)))).toEqual({
        artifacts: [
          { scope: MAIN, hash: c, size: 70_000 },
          { scope: FEATURE, hash: b, size: 4 },
          { scope: MAIN, hash: a, size: 5 },
        ],
      })
      expect(bytes.length).toBe(nl + 1 + 70_009)
      expect(bytes.subarray(nl + 1, nl + 70_001).every((x) => x === 7)).toBe(true)
      expect(new TextDecoder().decode(bytes.subarray(nl + 70_001))).toBe('minefirst')
      const many = Array(target.maxBatchArtifacts + 1).fill({ scope: MAIN, hash: a })
      expect((await json('/v1/artifacts/download', { keys: many })).status).toBe(400)
    })

    it('answers an unknown route 404 and a wrong method 405', async () => {
      expect((await call('/v2/artifacts/abc')).status).toBe(404)
      const head = await call(`/v1/artifacts/download/${key()}`, { method: 'HEAD' })
      expect([head.status, head.headers.get('allow')]).toEqual([405, 'GET'])
      const res = await call('/v1/artifacts/check', { method: 'DELETE' })
      expect([res.status, res.headers.get('allow')]).toEqual([405, 'POST'])
      const one = await call(`/v1/artifacts/${key()}`)
      expect([one.status, one.headers.get('allow')]).toEqual([405, 'PUT'])
    })
  })
}
