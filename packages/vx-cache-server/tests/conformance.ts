// The vx-cache v1 conformance suite (PROTOCOL.md): what any server that
// speaks it answers, the artifact routes held to the request and response
// shapes of Turbo's remote cache spec (turborepo.com/api/remote-cache-spec). Each backend this package ships runs it: Bun with an
// S3 bucket (bun.test.ts) and workerd with D1 and R2 (worker.test.ts).

import { describe, expect, it } from 'bun:test'

export interface Target {
  /** The server's URL. */
  base(): string
  /** Tokens it lists: one that reads, one that writes. */
  readonly read: string
  readonly write: string
  /** The largest artifact it stores. */
  readonly maxArtifactBytes: number
}

/** A fresh key per call: every target is shared by the whole suite. */
const key = (): string => crypto.randomUUID().replaceAll('-', '')

export function conformance(name: string, target: Target): void {
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = target.read, ...rest } = init
    const headers = new Headers(rest.headers)
    if (token !== null) headers.set('authorization', `Bearer ${token}`)
    return fetch(new URL(path, target.base()), { ...rest, headers })
  }
  const put = (k: string, body: Blob | Uint8Array | string, headers: Record<string, string> = {}) =>
    call(`/v1/artifacts/${k}`, { method: 'PUT', body, headers, token: target.write })
  const json = (path: string, body: unknown, token = target.read) =>
    call(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      token,
    })

  describe(`${name} speaks vx-cache v1`, () => {
    it("refuses a request with no token or an unknown one, as the spec's Error", async () => {
      for (const token of [null, 'nope']) {
        const res = await call(`/v1/artifacts/${key()}`, { token })
        expect(res.status).toBe(401)
        expect(res.headers.get('content-type')).toStartWith('application/json')
        expect(await res.json()).toEqual({ code: 'unauthorized', message: expect.any(String) })
      }
    })

    it('stores an artifact once and reads it back with its duration, tag, sha and dirty hash', async () => {
      const k = key()
      expect((await call(`/v1/artifacts/${k}`, { method: 'HEAD' })).status).toBe(404)
      const missing = await call(`/v1/artifacts/${k}`)
      expect([missing.status, await missing.json()]).toEqual([
        404,
        { code: 'not_found', message: 'no artifact under this key' },
      ])
      const first = await put(k, 'first', {
        'x-artifact-duration': '1234',
        'x-artifact-tag': 'c2lnbmVk',
        'x-artifact-sha': 'abc123',
        'x-artifact-dirty-hash': 'def456',
      })
      const urls = { urls: [new URL(`/v1/artifacts/${k}`, target.base()).href] }
      expect([first.status, await first.json()]).toEqual([202, urls])
      // Immutable: a second PUT keeps the stored bytes.
      const again = await put(k, 'second', { 'x-artifact-duration': '1' })
      expect([again.status, await again.json()]).toEqual([202, urls])
      const head = await call(`/v1/artifacts/${k}`, { method: 'HEAD' })
      expect([
        head.status,
        head.headers.get('content-length'),
        head.headers.get('x-artifact-duration'),
        head.headers.get('x-artifact-sha'),
        head.headers.get('x-artifact-dirty-hash'),
      ]).toEqual([200, '5', '1234', 'abc123', 'def456'])
      const got = await call(`/v1/artifacts/${k}`)
      expect([
        got.status,
        got.headers.get('content-type'),
        got.headers.get('x-artifact-duration'),
        got.headers.get('x-artifact-tag'),
        await got.text(),
      ]).toEqual([200, 'application/octet-stream', '1234', 'c2lnbmVk', 'first'])
    })

    it('stores an empty artifact and one of many megabytes', async () => {
      const empty = key()
      expect((await put(empty, new Uint8Array(0))).status).toBe(202)
      expect(await (await call(`/v1/artifacts/${empty}`)).text()).toBe('')
      const big = key()
      const bytes = crypto.getRandomValues(new Uint8Array(65_536)).map((_, i) => i)
      const body = new Uint8Array(6 * 1024 * 1024)
      for (let i = 0; i < body.length; i += bytes.length) body.set(bytes, i)
      expect((await put(big, body)).status).toBe(202)
      const got = new Uint8Array(await (await call(`/v1/artifacts/${big}`)).arrayBuffer())
      expect(Bun.hash(got)).toBe(Bun.hash(body))
    })

    it('refuses a write by a read token, a hash that is not hex and an artifact too large', async () => {
      const res = await call(`/v1/artifacts/${key()}`, { method: 'PUT', body: 'x' })
      expect([res.status, await res.json()]).toEqual([
        403,
        { code: 'forbidden', message: 'this token reads only' },
      ])
      expect((await put('a-b', 'x')).status).toBe(400)
      expect((await put('f'.repeat(129), 'x')).status).toBe(400)
      expect((await put(key(), new Uint8Array(target.maxArtifactBytes + 1))).status).toBe(413)
      expect((await put(key(), 'x', { 'x-artifact-duration': '-1' })).status).toBe(400)
      expect((await put(key(), 'x', { 'x-artifact-duration': '1.5' })).status).toBe(400)
      expect((await put(key(), 'x', { 'x-artifact-tag': 't'.repeat(601) })).status).toBe(400)
    })

    it('answers every hash of a batch query, null for one it does not hold', async () => {
      const [a, b] = [key(), key()]
      await put(a, 'abc', { 'x-artifact-duration': '7', 'x-artifact-tag': 'dGFn' })
      const res = await json('/v1/artifacts', { hashes: [a, b] })
      expect(await res.json()).toEqual({
        [a]: { size: 3, taskDurationMs: 7, tag: 'dGFn' },
        [b]: null,
      })
      expect((await json('/v1/artifacts', { hashes: Array(1001).fill(a) })).status).toBe(400)
      expect((await json('/v1/artifacts', { hashes: ['a-b'] })).status).toBe(400)
      const plain = await call('/v1/artifacts', { method: 'POST', body: '{"hashes":[]}' })
      expect(plain.status).toBe(400)
    })

    it('answers the status and takes cache events', async () => {
      const status = await call('/v1/artifacts/status?teamId=t&slug=s')
      expect([status.status, await status.json()]).toEqual([200, { status: 'enabled' }])
      expect((await call('/v1/artifacts/status', { token: null })).status).toBe(401)
      const event = { sessionId: crypto.randomUUID(), source: 'REMOTE', event: 'HIT', hash: key() }
      expect((await json('/v1/artifacts/events', [event])).status).toBe(200)
      expect((await json('/v1/artifacts/events', { event })).status).toBe(400)
    })

    it('reads the trusted scope after the refs it is sent, and refuses a bad list', async () => {
      const k = key()
      await put(k, 'abc')
      const scoped = (value: string) =>
        call(`/v1/artifacts/${k}`, { headers: { 'x-artifact-read-scopes': value } })
      expect((await scoped('"refs/heads/feature", "refs/heads/main"')).status).toBe(200)
      for (const bad of ['refs/heads/x', '"heads/x"', '"refs/x', '"refs/x" "refs/y"']) {
        expect([bad, (await scoped(bad)).status]).toEqual([bad, 400])
      }
      const nine = Array.from({ length: 9 }, (_, i) => `"refs/heads/${i}"`).join(', ')
      expect((await scoped(nine)).status).toBe(400)
    })

    it('records runs once and lists the newest first', async () => {
      const id = key()
      const run = (startedAt: number, tasks: unknown[]) => ({
        id: `${id}-${startedAt}`,
        startedAt,
        durationMs: 50,
        tasks,
      })
      const t = `${id}#build`
      expect(
        (await json('/v1/runs', run(1, [{ task: t, durationMs: 10 }]), target.write)).status,
      ).toBe(201)
      expect(
        (await json('/v1/runs', run(1, [{ task: t, durationMs: 10 }]), target.write)).status,
      ).toBe(200)
      const second = run(2, [
        {
          task: t,
          durationMs: 20,
          exitCode: 1,
          startedAt: 5,
          key: 'abc',
          cached: false,
          extra: 'dropped',
        },
        { task: `${id}#test`, durationMs: 30, cached: true },
      ])
      expect((await json('/v1/runs', second, target.write)).status).toBe(201)
      const listed = (await (await call('/v1/runs?limit=100')).json()) as { runs: any[] }
      const ours = listed.runs.filter((r) => r.id.startsWith(id))
      expect(ours).toEqual([
        {
          id: `${id}-2`,
          scope: 'trusted',
          startedAt: 2,
          durationMs: 50,
          taskCount: 2,
          failedCount: 1,
        },
        {
          id: `${id}-1`,
          scope: 'trusted',
          startedAt: 1,
          durationMs: 50,
          taskCount: 1,
          failedCount: 0,
        },
      ])
      const samples = await (await json('/v1/tasks/query', { tasks: [t, `${id}#lint`] })).json()
      expect(samples).toEqual({
        tasks: {
          [t]: [
            {
              run: `${id}-2`,
              scope: 'trusted',
              key: 'abc',
              durationMs: 20,
              exitCode: 1,
              cached: false,
              startedAt: 5,
            },
            { run: `${id}-1`, scope: 'trusted', durationMs: 10 },
          ],
          [`${id}#lint`]: [],
        },
      })
      const one = (await (await json('/v1/tasks/query', { tasks: [t], limit: 1 })).json()) as any
      expect(one.tasks[t].map((s: any) => s.run)).toEqual([`${id}-2`])
    })

    it('refuses a run from a read token and a run that is not one', async () => {
      const ok = { id: key(), startedAt: 1, durationMs: 1, tasks: [] }
      expect((await json('/v1/runs', ok)).status).toBe(403)
      for (const [bad, detail] of [
        [{ ...ok, id: '' }, 'id: a string of up to 512 characters'],
        [{ ...ok, startedAt: -1 }, 'startedAt: milliseconds since the epoch'],
        [
          { ...ok, tasks: [{ task: 'a', durationMs: 'x' }] },
          'tasks[0].durationMs: whole milliseconds',
        ],
        [{ ...ok, tasks: [{ task: 'a', durationMs: 1, cached: 1 }] }, 'tasks[0].cached: a boolean'],
      ] as const) {
        const res = await json('/v1/runs', bad, target.write)
        expect([res.status, await res.json()]).toEqual([
          400,
          { code: 'bad_request', message: detail },
        ])
      }
      expect((await json('/v1/tasks/query', { tasks: ['a'], limit: 21 })).status).toBe(400)
      expect((await call('/v1/runs?limit=0')).status).toBe(400)
    })

    it('answers an unknown route 404 and a wrong method 405', async () => {
      expect((await call('/v2/artifacts/abc')).status).toBe(404)
      const res = await call('/v1/runs', { method: 'DELETE' })
      expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET, POST'])
    })
  })
}
