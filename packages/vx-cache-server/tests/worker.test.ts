// src/worker.ts in workerd, the runtime Workers deploy to, with D1 and R2.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { conformance } from './conformance.js'
import { GITHUB, type Issuer, issuer, TRUST, TRUSTED_JOB } from './issuer.js'
import { upload } from './upload.js'

const MAX = 7 * 1024 * 1024
/** The Worker's own origin, its tokens' audience. */
const AUD = 'https://cache.example.com'

let mf: Miniflare
let base: URL
let iss: Issuer

async function start(bindings: Record<string, string>): Promise<Miniflare> {
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, '..', 'src', 'worker.ts')],
    target: 'browser',
    format: 'esm',
  })
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await built.outputs[0]!.text(),
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
      r2Buckets: ['BLOBS'],
      bindings: { AUDIENCE: AUD, ...bindings },
      // The issuer's keys, served to the Worker's fetch without a network.
      outboundService: async (req: Request) =>
        new URL(req.url).origin === GITHUB
          ? Response.json(await iss.fetchJson(req.url))
          : new Response(null, { status: 502 }),
    }),
  )
}

beforeAll(async () => {
  iss = await issuer()
  mf = await start({ MAX_UPLOAD_BYTES: String(MAX), TRUST: JSON.stringify(TRUST) })
  base = await mf.ready
})

afterAll(() => mf.dispose())

conformance('Workers with D1 and R2', {
  base: () => base.href,
  sign: (claims) => iss.sign(claims, AUD),
  maxUploadBytes: MAX,
})

it('refuses every request, saying why, while TRUST or MAX_UPLOAD_BYTES is unset or wrong', async () => {
  for (const [bindings, status, detail] of [
    [{ TRUST: '' }, 401, 'the server trusts no CI: set TRUST'],
    [
      { TRUST: '[{"iss":"https://gitlab.com"}]' },
      500,
      'TRUST: rule 0: names no project_id (one repository, no *)',
    ],
    [
      { TRUST: JSON.stringify(TRUST), MAX_UPLOAD_BYTES: '104857600' },
      500,
      'MAX_UPLOAD_BYTES: at most 104241600: Workers take a body of 100 MB',
    ],
  ] as const) {
    const other = await start(bindings)
    try {
      const res = await fetch(new URL('/v1/artifacts/download/abc', await other.ready))
      expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([
        status,
        detail,
      ])
    } finally {
      await other.dispose()
    }
  }
})

it("runs the Cron Trigger's eviction in workerd, over D1 and R2", async () => {
  // A retention of about 0.1 s: what was written before the sweep is old.
  const other = await start({ TRUST: JSON.stringify(TRUST), TRUSTED_DAYS: '0.000001' })
  try {
    const at = await other.ready
    const token = await iss.sign(TRUSTED_JOB, AUD)
    const auth = { authorization: `Bearer ${token}` }
    await fetch(new URL('/v1/artifacts/upload', at), upload([['e71c71', 'x']], token))
    await Bun.sleep(200)
    // miniflare's own types name a Fetcher and an R2 bucket it does not export.
    const worker = (await other.getWorker()) as unknown as {
      scheduled(o: { cron: string }): Promise<{ outcome: string }>
    }
    expect((await worker.scheduled({ cron: '17 3 * * *' })).outcome).toBe('ok')
    const res = await fetch(new URL('/v1/artifacts/download/e71c71', at), { headers: auth })
    expect(res.status).toBe(404)
    const bucket = (await other.getR2Bucket('BLOBS')) as unknown as {
      head(key: string): Promise<unknown>
    }
    expect(await bucket.head('v1/42/trusted/e71c71/1')).toBeNull()
  } finally {
    await other.dispose()
  }
})
