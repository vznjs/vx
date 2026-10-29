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

async function start(bindings: Record<string, unknown>, d1Databases = ['DB']): Promise<Miniflare> {
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
      d1Databases,
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
    [{ ALLOW: '' }, 401, 'ALLOW is empty: set it to the CI workflows this server serves'],
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

// No database bound: every request was a 500 naming "undefined", or a
// capabilities 200 while every upload failed.
it('refuses every request, saying why, while no D1 database is bound as DB', async () => {
  const other = await start({ ALLOW: allowVarOf() }, [])
  try {
    for (const route of ['/v1/capabilities', '/v1/timings/query']) {
      const res = await other.dispatchFetch(new URL(route, await other.ready), {
        method: route === '/v1/capabilities' ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${await iss.sign('read', AUD)}` },
      })
      expect([route, res.status, ((await res.json()) as { message: string }).message]).toEqual([
        route,
        500,
        'DB: bind a D1 database as DB (wrangler.jsonc d1_databases)',
      ])
    }
  } finally {
    await other.dispose()
  }
})

// jose matches aud exactly: a pasted newline refused every token as the
// wrong audience. A blank one is refused above.
it('reads AUDIENCE without the blanks around it', async () => {
  const other = await start({ ALLOW: allowVarOf(), AUDIENCE: ` ${AUD}\n` })
  try {
    const res = await other.dispatchFetch(new URL('/v1/capabilities', await other.ready), {
      headers: { authorization: `Bearer ${await iss.sign('read', AUD)}` },
    })
    expect(res.status).toBe(200)
  } finally {
    await other.dispose()
  }
})
