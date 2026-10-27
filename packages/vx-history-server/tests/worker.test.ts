// src/worker.ts in workerd, the runtime Workers deploy to, with D1.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { conformance } from './conformance.js'
import { GITHUB, type Issuer, issuer, REPO, trustOf } from './issuer.js'

/** The Worker's own origin, its tokens' audience. */
const AUD = 'https://history.example.com'

let mf: Miniflare
let base: URL
let iss: Issuer

async function start(bindings: Record<string, unknown>): Promise<Miniflare> {
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
  mf = await start({ TRUST: JSON.stringify(trustOf()) })
  base = await mf.ready
})

afterAll(() => mf.dispose())

conformance('Workers with D1', {
  base: () => base.href,
  sign: (job) => iss.sign(job, AUD),
  issuer: GITHUB,
  repository: REPO,
})

it('refuses every request, saying why, while TRUST, TIMING_DAYS or READ_ACCESS is unset or wrong', async () => {
  for (const [bindings, status, message] of [
    [{ TRUST: '' }, 401, 'the server trusts no CI: set TRUST'],
    [
      { TRUST: '[{"iss":"https://gitlab.com"}]' },
      500,
      'rule 0: names no project_path (one repository, no *)',
    ],
    [
      { TRUST: JSON.stringify(trustOf()), TIMING_DAYS: '0' },
      500,
      'TIMING_DAYS: a whole number of days, got 0',
    ],
    [
      { TRUST: JSON.stringify(trustOf()), READ_ACCESS: 'yes' },
      500,
      'READ_ACCESS: public, or unset, not yes',
    ],
  ] as const) {
    const other = await start(bindings)
    try {
      const res = await other.dispatchFetch(new URL('/v1/capabilities', await other.ready), {
        headers: {
          authorization: `Bearer ${await iss.sign('read', AUD)}`,
        },
      })
      expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([
        status,
        message,
      ])
    } finally {
      await other.dispose()
    }
  }
})

// wrangler hands a var written as a JSON list in wrangler.jsonc to the
// Worker as that list: TRUST.trim threw, and every request was a 500.
it('takes TRUST written as a list in wrangler.jsonc', async () => {
  const other = await start({ TRUST: JSON.parse(JSON.stringify(trustOf())) as unknown })
  try {
    const res = await other.dispatchFetch(new URL('/v1/capabilities', await other.ready), {
      headers: {
        authorization: `Bearer ${await iss.sign('read', AUD)}`,
      },
    })
    expect(res.status).toBe(200)
  } finally {
    await other.dispose()
  }
})
