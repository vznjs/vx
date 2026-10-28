// The vx-history v1 conformance suite (PROTOCOL.md): what any server that
// speaks it answers. Bun with SQLite (bun.test.ts), workerd with D1
// (worker.test.ts) and the Docker image (docker/) each run it.

import { beforeAll, describe, expect, it } from 'bun:test'

export interface Target {
  /** The server's URL. */
  base(): string
  /** A token for the server: of main, of `feature`, or reading only. */
  sign(job: 'main' | 'branch' | 'read'): Promise<string>
  /** The issuer and repository its tokens name, which every query names. */
  readonly issuer: string
  readonly repository: string
}

/** A fresh task hash per call: every target is shared by the whole suite. */
const hash = (): string => crypto.randomUUID()

export function conformance(name: string, target: Target): void {
  const tokens = { main: '', branch: '', read: '' }
  beforeAll(async () => {
    for (const job of ['main', 'branch', 'read'] as const) tokens[job] = await target.sign(job)
  })
  const call = (path: string, init: RequestInit = {}, token: string | null = tokens.read) => {
    const headers = new Headers(init.headers)
    if (token !== null) headers.set('authorization', `Bearer ${token}`)
    return fetch(new URL(path, target.base()), { ...init, headers })
  }
  const post = (path: string, body: unknown, token?: string | null) =>
    call(
      path,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      },
      token,
    )
  const upload = (timings: unknown[], token = tokens.main) =>
    post('/v1/timings/upload', { timings }, token)
  const named = () => ({ issuer: target.issuer, repository: target.repository })
  const ask = (refs: string[], hashes: unknown, token: string | null = tokens.read) =>
    post('/v1/timings/query', { ...named(), refs, hashes }, token)
  const query = async (hashes: string[], refs = ['refs/heads/main'], token = tokens.read) =>
    ((await (await ask(refs, hashes, token)).json()) as { timings: Record<string, unknown> })
      .timings
  describe(`${name} speaks vx-history v1`, () => {
    it('folds each upload into one row per task', async () => {
      const h = hash()
      expect((await upload([{ hash: h, durationMs: 1000, cores: 2, rssBytes: 1000 }])).status).toBe(
        204,
      )
      expect((await query([h]))[h]).toEqual({ durationMs: 1000, cores: 2, rssBytes: 1000, runs: 1 })
      expect((await upload([{ hash: h, durationMs: 2000, cores: 1, rssBytes: 500 }])).status).toBe(
        204,
      )
      // 70% the old, 30% the new; memory keeps the peak, decayed 10%.
      expect((await query([h]))[h]).toEqual({
        durationMs: 1300,
        cores: 1.7,
        rssBytes: 900,
        runs: 2,
      })
    })

    it('skips a write that would not move the row', async () => {
      const h = hash()
      await upload([{ hash: h, durationMs: 1000, cores: 2, rssBytes: 1000 }])
      // Within 5%, no new memory peak: the row stays as it was.
      expect(
        (await upload([{ hash: h, durationMs: 1040, cores: 2.05, rssBytes: 900 }])).status,
      ).toBe(204)
      expect((await query([h]))[h]).toEqual({ durationMs: 1000, cores: 2, rssBytes: 1000, runs: 1 })
      // A new peak alone moves it.
      await upload([{ hash: h, durationMs: 1000, cores: 2, rssBytes: 1100 }])
      expect((await query([h]))[h]).toEqual({ durationMs: 1000, cores: 2, rssBytes: 1100, runs: 2 })
    })

    it('keeps cores and memory when a report omits them', async () => {
      const h = hash()
      await upload([{ hash: h, durationMs: 100 }])
      expect((await query([h]))[h]).toEqual({
        durationMs: 100,
        cores: null,
        rssBytes: null,
        runs: 1,
      })
      await upload([{ hash: h, durationMs: 100, cores: 1, rssBytes: 10 }])
      expect((await query([h]))[h]).toEqual({
        durationMs: 100,
        cores: 1,
        rssBytes: 10,
        runs: 2,
      })
    })

    it("writes under the key of the token's ref, which a reader builds from its refs", async () => {
      const [a, b] = [hash(), hash()]
      await upload([
        { hash: a, durationMs: 10 },
        { hash: b, durationMs: 20 },
      ])
      await query([a, b])
      await upload([{ hash: a, durationMs: 99 }], tokens.branch)
      const both = ['refs/heads/feature', 'refs/heads/main']
      expect(await query([a, b], both)).toMatchObject({
        [a]: { durationMs: 99 },
        [b]: { durationMs: 20 },
      })
      expect((await query([a, b], ['refs/heads/feature']))[b]).toBeUndefined()
      expect((await query([a], [...both].reverse()))[a]).toMatchObject({ durationMs: 10 })
      expect(await query([hash()])).toEqual({})
    })

    it('takes an upload and a query at its limits: 10 000 tasks, each hash 512 characters', async () => {
      const hashes = Array.from({ length: 10_000 }, (_, i) =>
        `${i}`.padStart(512, crypto.randomUUID()),
      )
      const timings = hashes.map((h) => ({
        hash: h,
        durationMs: 2_147_483_647_000,
        cores: 1.2345678901234567,
        rssBytes: 9_007_199_254_740_991,
      }))
      expect((await upload(timings)).status).toBe(204)
      const got = await query(hashes)
      expect([Object.keys(got).length, got[hashes[9_999]!]]).toEqual([
        10_000,
        {
          durationMs: 2_147_483_647_000,
          cores: 1.2345678901234567,
          rssBytes: 9_007_199_254_740_991,
          runs: 1,
        },
      ])
    })

    it('refuses a write from a token that reads only, and reports that are not some', async () => {
      const ok = { hash: hash(), durationMs: 1 }
      expect((await upload([ok], tokens.read)).status).toBe(403)
      for (const [bad, message] of [
        [[{ ...ok, hash: '' }], 'timings[0].hash: a string of up to 512 characters'],
        [[{ ...ok, durationMs: 1.5 }], 'timings[0].durationMs: whole milliseconds'],
        [[{ ...ok, cores: -1 }], 'timings[0].cores: a number of cores'],
        [[{ ...ok, rssBytes: 'x' }], 'timings[0].rssBytes: a byte count'],
        [[ok, ok], 'timings[1].hash: each task once'],
      ] as const) {
        const res = await upload([...bad])
        expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([
          400,
          message,
        ])
      }
    })

    it('refuses a query that names no repository, refs or hashes, or too many', async () => {
      const main = ['refs/heads/main']
      for (const body of [
        { ...named(), refs: main },
        { ...named(), hashes: ['a'] },
        { ...named(), refs: [], hashes: ['a'] },
        { ...named(), refs: ['main'], hashes: ['a'] },
        { ...named(), refs: Array(9).fill(main[0]), hashes: ['a'] },
        { ...named(), refs: main, hashes: Array.from({ length: 10_001 }, (_, i) => String(i)) },
        { repository: target.repository, refs: main, hashes: ['a'] },
        { issuer: target.issuer, repository: 'nameonly', refs: main, hashes: ['a'] },
      ]) {
        expect((await post('/v1/timings/query', body)).status).toBe(400)
      }
    })

    it('refuses the body a client before plain refs sent, saying what it takes', async () => {
      const res = await post('/v1/timings/query', { scopes: ['refs/heads/main'], hashes: ['a'] })
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).toContain('issuer')
    })

    it('refuses a token of another repository than the query names', async () => {
      const res = await post('/v1/timings/query', {
        ...named(),
        repository: 'acme/other',
        refs: ['refs/heads/main'],
        hashes: ['a'],
      })
      expect(res.status).toBe(403)
      // Names differ in case only: the same repository.
      const upper = await post('/v1/timings/query', {
        ...named(),
        repository: target.repository.toUpperCase(),
        refs: ['refs/heads/main'],
        hashes: ['a'],
      })
      expect(upper.status).toBe(200)
    })

    it('names its limits, refuses no token, a wrong method and an unknown route', async () => {
      expect(await (await call('/v1/capabilities')).json()).toEqual({
        maxUploadTimings: 10_000,
        maxQueryHashes: 10_000,
        maxQueryRefs: 8,
      })
      expect((await call('/v1/capabilities', {}, null)).status).toBe(401)
      const get = await call('/v1/timings/query')
      expect([get.status, get.headers.get('allow'), await get.json()]).toEqual([
        405,
        'POST',
        { code: 'method_not_allowed', message: 'this route takes POST' },
      ])
      const nope = await call('/v1/nope')
      expect([nope.status, await nope.json()]).toEqual([
        404,
        { code: 'not_found', message: 'no such route' },
      ])
    })
  })
}
