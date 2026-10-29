// The vx-cache v1 conformance suite (PROTOCOL.md): what any server that
// speaks it answers. Each backend this package ships runs it: Bun with an
// S3 bucket (bun.test.ts), workerd with R2 (worker.test.ts) and the Docker
// image (docker/smoke.sh). Every request carries a CI
// OIDC token from tests/issuer.ts, whose ALLOW the target serves.

import { beforeAll, describe, expect, it } from 'bun:test'

export type Job = 'main' | 'read' | 'branch' | 'stranger'

export interface Target {
  /** The server's URL. */
  base(): string
  /**
   * A token for the server of a job that writes main, one on main that
   * only reads, one that writes its branch
   * (`refs/heads/feature`), or a main job of a repository the server
   * does not serve.
   */
  sign(job: Job): Promise<string>
  /** The issuer and repository its tokens name, which every request names by their hashes. */
  readonly issuer: string
  readonly repository: string
  /** The limits it was given. */
  readonly maxCheckHashes: number
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
  const call = (
    path: string,
    init: RequestInit & { token?: string | null; named?: boolean } = {},
  ) => {
    const { token = read, named = true, ...rest } = init
    const headers = new Headers(rest.headers)
    if (token !== null) headers.set('authorization', `Bearer ${token}`)
    if (named) {
      headers.set('vx-issuer', scopeOf(target.issuer))
      headers.set('vx-repository', scopeOf(target.repository))
    }
    return fetch(new URL(path, target.base()), { ...rest, headers })
  }
  const MAIN = scopeOf('refs/heads/main')
  const FEATURE = scopeOf('refs/heads/feature')
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
  /** One artifact's bytes, read from `scope`. */
  const get = (k: string, scope = MAIN) =>
    call(`/v1/artifacts/${k}`, { headers: { 'vx-scope': scope } })
  const text = async (k: string, scope = MAIN) => (await get(k, scope)).text()
  /** Turbo's batch query over `scopes`: each hash's `{ size, scope }`, or null. */
  const held = async (hashes: string[], scopes = [MAIN]) =>
    (await (await json('/v1/artifacts', { hashes, scopes })).json()) as Record<
      string,
      { size: number; scope: string } | null
    >

  describe(`${name} speaks vx-cache v1`, () => {
    it('refuses a request with no CI token, a bad one or one of another repository', async () => {
      for (const token of [null, 'nope', 'a.b.c']) {
        const res = await call(`/v1/artifacts/${key()}`, { token })
        expect(res.status).toBe(401)
        expect(res.headers.get('content-type')).toStartWith('application/json')
        expect(await res.json()).toEqual({ code: 'unauthorized', message: expect.any(String) })
      }
      const other = await target.sign('stranger')
      expect((await call(`/v1/artifacts/${key()}`, { token: other })).status).toBe(403)
    })

    it('refuses a request that names no issuer and repository, or another than its token', async () => {
      const res = await call(`/v1/artifacts/${key()}`, { named: false })
      expect(await res.json()).toEqual({
        code: 'bad_request',
        message:
          "vx-issuer and vx-repository: the issuer's and the repository's hashes (PROTOCOL.md § Keys)",
      })
      const other = await call(`/v1/artifacts/${key()}`, {
        named: false,
        headers: { 'vx-issuer': scopeOf(target.issuer), 'vx-repository': scopeOf('acme/other') },
      })
      expect(other.status).toBe(403)
    })

    it('refuses Turbo’s team params: the token names the repository', async () => {
      const res = await call(`/v1/artifacts/${key()}?teamId=t`)
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
      // Immutable: a second upload keeps the stored bytes.
      expect((await put(k, 'second')).status).toBe(204)
      const got = await get(k)
      expect([
        got.status,
        got.headers.get('content-type'),
        got.headers.get('content-length'),
        await got.text(),
      ]).toEqual([200, 'application/octet-stream', '5', 'first'])
    })

    it('answers HEAD with the size the scope holds, and no bytes', async () => {
      const k = key()
      const head = (scope = MAIN) =>
        call(`/v1/artifacts/${k}`, { method: 'HEAD', headers: { 'vx-scope': scope } })
      expect((await head()).status).toBe(404)
      await put(k, 'four')
      const res = await head()
      expect([res.status, res.headers.get('content-length'), await res.text()]).toEqual([
        200,
        '4',
        '',
      ])
      expect((await head(FEATURE)).status).toBe(404)
    })

    it('answers an upload of a held hash before reading its bytes', async () => {
      const a = key()
      await put(a, 'held')
      // Bytes that never end: only an answer before they are read returns.
      const body = new ReadableStream<Uint8Array>({
        start: (c) => c.enqueue(new TextEncoder().encode('x'.repeat(65_536))),
      })
      const res = await call(`/v1/artifacts/${a}`, {
        method: 'PUT',
        body,
        headers: { 'content-length': String(target.maxUploadBytes) },
        token: write,
        duplex: 'half',
        signal: AbortSignal.timeout(5_000),
      } as RequestInit)
      expect(res.status).toBe(204)
      expect(await text(a)).toBe('held')
    })

    it('has no batch upload', async () => {
      const res = await call('/v1/artifacts/upload', { method: 'POST', body: '{}', token: write })
      expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET, HEAD, PUT'])
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
        expect(await held([k])).toEqual({ [k]: { size: got.length, scope: MAIN } })
      }
    })

    it('refuses a write by a read-only token, a bad hash and an upload too large', async () => {
      const res = await put(key(), 'x', read)
      expect([res.status, await res.json()]).toEqual([
        403,
        { code: 'forbidden', message: 'this request reads only' },
      ])
      expect((await put('a-b', 'x')).status).toBe(400)
      expect((await put('f'.repeat(129), 'x')).status).toBe(400)
      const big = await put(key(), new Uint8Array(target.maxUploadBytes + 1))
      expect([big.status, await big.json()]).toEqual([
        413,
        {
          code: 'payload_too_large',
          message: `an upload is at most ${target.maxUploadBytes} bytes`,
        },
      ])
    })

    it('names its limits on every check, and at /v1/capabilities', async () => {
      const res = await json('/v1/artifacts', { hashes: [], scopes: [MAIN] })
      const limits = {
        maxCheckHashes: target.maxCheckHashes,
        maxUploadBytes: target.maxUploadBytes,
      }
      expect([
        Number(res.headers.get('vx-max-check-hashes')),
        Number(res.headers.get('vx-max-upload-bytes')),
      ]).toEqual(Object.values(limits))
      expect(await (await call('/v1/capabilities')).json()).toEqual(limits)
      expect((await call('/v1/capabilities', { token: null })).status).toBe(401)
    })

    // A check refused for its size, or an upload for its, named no limits:
    // a client holding older ones (a server restarted with new ones, a
    // Worker's rollout) was refused every check of the run.
    it('names its limits on every /v1/artifacts answer, a refusal too', async () => {
      const named = (res: Response) => [
        res.status,
        Number(res.headers.get('vx-max-check-hashes')),
        Number(res.headers.get('vx-max-upload-bytes')),
      ]
      const too = Array.from({ length: target.maxCheckHashes + 1 }, key)
      const answers = [
        await json('/v1/artifacts', { hashes: too, scopes: [MAIN] }),
        await put(key(), new Uint8Array(target.maxUploadBytes + 1)),
        await put(key(), 'x'),
        await get(key()),
      ]
      expect(answers.map(named)).toEqual(
        [400, 413, 204, 404].map((s) => [s, target.maxCheckHashes, target.maxUploadBytes]),
      )
    })

    it('answers each hash of a check with the first scope asked that holds it, or null', async () => {
      for (const n of [1, 12]) {
        const hashes = Array.from({ length: n }, key)
        await put(hashes[0]!, 'main')
        await put(hashes[0]!, 'mine', branch)
        await put(hashes.at(-1)!, 'only main')
        const got = await held(hashes, [FEATURE, MAIN])
        expect(got[hashes[0]!]).toEqual({ size: 4, scope: FEATURE })
        if (n > 1) expect(got[hashes.at(-1)!]).toEqual({ size: 9, scope: MAIN })
        expect(Object.values(got).filter((v) => v === null)).toHaveLength(Math.max(0, n - 2))
        expect((await held(hashes, [MAIN, FEATURE]))[hashes[0]!]).toEqual({ size: 4, scope: MAIN })
      }
    })

    it('answers each hash of a check in the exact scope named, null for one it does not hold', async () => {
      const [a, b] = [key(), key()]
      await put(a, 'abc')
      expect(await held([a, b])).toEqual({ [a]: { size: 3, scope: MAIN }, [b]: null })
      expect(await held([a], [FEATURE])).toEqual({ [a]: null })
      const many = Array(target.maxCheckHashes + 1).fill(a)
      expect((await json('/v1/artifacts', { hashes: many, scopes: [MAIN] })).status).toBe(400)
      const half = Array(Math.floor(target.maxCheckHashes / 2) + 1).fill(a)
      const both = await json('/v1/artifacts', { hashes: half, scopes: [MAIN, FEATURE] })
      expect(both.status).toBe(400)
      for (const body of [
        { hashes: ['a-b'], scopes: [MAIN] },
        { hashes: [1], scopes: [MAIN] },
        { hashes: 'a', scopes: [MAIN] },
        { hashes: [a] },
        { hashes: [a], scopes: [] },
        { hashes: [a], scopes: ['refs/heads/main'] },
      ]) {
        expect((await json('/v1/artifacts', body)).status).toBe(400)
      }
      const plain = await call('/v1/artifacts', { method: 'POST', body: '{"hashes":[]}' })
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
      expect((await call(`/v1/artifacts/${k}`)).status).toBe(400)
      // A plain ref never goes on the wire: it is refused, not hashed.
      for (const bad of ['refs/heads/main', MAIN.toUpperCase(), MAIN.slice(1)]) {
        expect([bad, (await get(k, bad)).status]).toEqual([bad, 400])
      }
    })

    it('has no batch download', async () => {
      const res = await json('/v1/artifacts/download', { hashes: [] })
      expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET, HEAD, PUT'])
    })

    it('answers an unknown route 404 and a wrong method 405', async () => {
      const nope = await call('/v2/artifacts/abc')
      expect([nope.status, await nope.json()]).toEqual([
        404,
        {
          code: 'not_found',
          message: `no route GET /v2/artifacts/abc: name the server's base URL; it serves /v1/ (PROTOCOL.md)`,
        },
      ])
      const text = await call('/v1/artifacts', {
        method: 'POST',
        body: '{"hashes":[],"scopes":[]}',
        headers: { 'content-type': 'text/plain' },
      })
      expect([text.status, await text.json()]).toEqual([
        400,
        { code: 'bad_request', message: 'send the body as Content-Type: application/json' },
      ])
      const res = await call('/v1/artifacts', { method: 'DELETE' })
      expect([res.status, res.headers.get('allow'), await res.json()]).toEqual([
        405,
        'POST',
        { code: 'method_not_allowed', message: 'this route takes POST' },
      ])
      const one = await call(`/v1/artifacts/${key()}`, { method: 'DELETE', token: write })
      expect([one.status, one.headers.get('allow')]).toEqual([405, 'GET, HEAD, PUT'])
    })
  })
}
