// src/worker.ts in workerd, the runtime Workers deploy to, with D1.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { conformance } from './conformance.js'
import { allowVarOf, GITHUB, type Issuer, issuer, REPO } from './issuer.js'

/** The Worker's own origin, its tokens' audience. */
const AUD = 'https://history.example.com'

let mf: Miniflare
let base: URL
let iss: Issuer

async function start(bindings: Record<string, unknown>, db = true): Promise<Miniflare> {
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
      d1Databases: db ? ['DB'] : [],
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
  mf = await start({ ALLOW: allowVarOf() })
  base = await mf.ready
})

afterAll(() => mf.dispose())

conformance('Workers with D1', {
  base: () => base.href,
  sign: (job) => iss.sign(job, AUD),
  issuer: GITHUB,
  repository: REPO,
})

it('refuses every request, saying why, while ALLOW, TIMING_DAYS or READ_ACCESS is unset or wrong', async () => {
  for (const [bindings, status, message] of [
    [{ ALLOW: '' }, 401, 'the server admits no CI: set ALLOW'],
    [
      { ALLOW: 'https://gitlab.com:group/app' },
      500,
      'ALLOW: https://gitlab.com:group/app is not issuer:owner/repo:workflow',
    ],
    // wrangler.jsonc may write a var as a JSON list: "list.split is not a function".
    [
      { ALLOW: [allowVarOf()] },
      500,
      'ALLOW: one string of issuer:owner/repo:workflow entries, space separated',
    ],
    [{ ALLOW: allowVarOf(), TIMING_DAYS: '0' }, 500, 'TIMING_DAYS: a whole number of days, got 0'],
    // A blank AUDIENCE was taken: every token was then "wrong audience".
    [
      { ALLOW: allowVarOf(), AUDIENCE: ' ' },
      500,
      'AUDIENCE: the aud CI tokens name, or unset, not blank',
    ],
    [{ ALLOW: allowVarOf(), READ_ACCESS: 'yes' }, 500, 'READ_ACCESS: public, or unset, not yes'],
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

// A deploy that bound no database answered the runtime's TypeError.
it('refuses every request, naming the binding, while no D1 database is bound as DB', async () => {
  const other = await start({ ALLOW: allowVarOf() }, false)
  try {
    const res = await other.dispatchFetch(new URL('/v1/timings/query', await other.ready), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        issuer: GITHUB,
        repository: REPO,
        refs: ['refs/heads/main'],
        hashes: [],
      }),
    })
    expect([res.status, await res.json()]).toEqual([
      500,
      {
        code: 'internal_error',
        message: 'no D1 database is bound as DB: bind one in wrangler.jsonc (d1_databases)',
      },
    ])
  } finally {
    await other.dispose()
  }
})
