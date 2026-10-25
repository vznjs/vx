// The vx-history v1 conformance suite (PROTOCOL.md): what any server that
// speaks it answers. Bun with SQLite (bun.test.ts), workerd with D1
// (worker.test.ts) and the Docker image (docker/) each run it.

import { beforeAll, describe, expect, it } from 'bun:test'

export interface Target {
  /** The server's URL. */
  base(): string
  /** A token for the server: of main (the ref TRUST protects), of `feature`, or reading only. */
  sign(job: 'main' | 'branch' | 'read'): Promise<string>
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
  const query = async (hashes: string[], scopes = ['refs/heads/main'], token = tokens.read) =>
    (
      (await (await post('/v1/timings/query', { scopes, hashes }, token)).json()) as {
        timings: Record<string, unknown>
      }
    ).timings
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

    it('reads each hash from the first scope asked that holds it', async () => {
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

    it('refuses a query without ref scopes, or with too many scopes or hashes', async () => {
      const main = ['refs/heads/main']
      for (const scopes of [undefined, [], ['main'], 'refs/heads/main', Array(9).fill(main[0])]) {
        expect((await post('/v1/timings/query', { scopes, hashes: ['a'] })).status).toBe(400)
      }
      const many = Array.from({ length: 10_001 }, (_, i) => String(i))
      expect((await post('/v1/timings/query', { scopes: main, hashes: many })).status).toBe(400)
    })

    it('names its limits, refuses no token, a wrong method and an unknown route', async () => {
      expect(await (await call('/v1/capabilities')).json()).toEqual({
        maxUploadTimings: 10_000,
        maxQueryHashes: 10_000,
        maxQueryScopes: 8,
      })
      expect((await call('/v1/capabilities', {}, null)).status).toBe(401)
      const get = await call('/v1/timings/query')
      expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
      expect((await call('/v1/nope')).status).toBe(404)
    })
  })
}
