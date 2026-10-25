// src/worker.ts in workerd, the runtime Workers deploy to, with R2.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { conformance } from './conformance.js'
import { GITHUB, type Issuer, issuer, JOBS, TRUST } from './issuer.js'

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
  mf = await start({
    MAX_UPLOAD_BYTES: String(MAX),
    MAX_BATCH_ARTIFACTS: '1000',
    TRUST: JSON.stringify(TRUST),
  })
  base = await mf.ready
})

afterAll(() => mf.dispose())

// MAX_BATCH_ARTIFACTS 1000 is clamped to what a request's 1000 service calls fit.
conformance('Workers with R2', {
  base: () => base.href,
  sign: (job) => iss.sign(JOBS[job], AUD),
  maxCheckKeys: 500,
  maxBatchArtifacts: 330,
  maxUploadBytes: MAX,
})

it('refuses every request, saying why, while TRUST or a limit is unset or wrong', async () => {
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
      'MAX_UPLOAD_BYTES: at most 104841536: Workers take a body of 100 MB',
    ],
    [
      { TRUST: JSON.stringify(TRUST), MAX_CHECK_KEYS: '0' },
      500,
      'MAX_CHECK_KEYS: not a whole number above 0: 0',
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
