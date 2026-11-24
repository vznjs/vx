// src/worker.ts in workerd, the runtime Workers deploy to, with D1.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { conformance } from './conformance.js'
import { allowVarOf, GITHUB, type Issuer, issuer, REPO } from './issuer.js'

// Miniflare removes its temp directory unawaited on dispose, so the process
// often ended first and left a `miniflare-*` there: it gets one of ours.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vx-miniflare-'))
const savedTmp = process.env['TMPDIR']
process.env['TMPDIR'] = tmpRoot

/** The Worker's own origin, its tokens' audience. */
const AUD = 'https://history.example.com'

let mf: Miniflare
let base: URL
let iss: Issuer

let script: Promise<string> | undefined
const built = (): Promise<string> =>
  (script ??= Bun.build({
    entrypoints: [path.join(import.meta.dir, '..', 'src', 'worker.ts')],
    target: 'browser',
    format: 'esm',
  }).then((b) => b.outputs[0]!.text()))

async function worker(bindings: Record<string, unknown>, d1Databases = ['DB']) {
  return {
    modules: true,
    script: await built(),
    compatibilityDate: '2026-10-01',
    d1Databases,
    bindings: { AUDIENCE: AUD, ...bindings },
    // The issuer's keys, served to the Worker's fetch without a network.
    outboundService: async (req: Request) =>
      new URL(req.url).origin === GITHUB
        ? Response.json(await iss.fetchJson(req.url))
        : new Response(null, { status: 502 }),
  }
}

async function start(bindings: Record<string, unknown>, d1Databases = ['DB']): Promise<Miniflare> {
  return new Miniflare(convertV4MiniflareOptions(await worker(bindings, d1Databases)))
}

/**
 * One Worker per bindings, all in one workerd: a workerd start per row
 * took 3 s on a loaded machine, so ten rows passed even 30 s.
 */
async function startEach(rows: readonly Record<string, unknown>[]): Promise<Miniflare> {
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: await Promise.all(
        rows.map(async (b, i) => ({ name: `row-${i}`, ...(await worker(b)) })),
      ),
    }),
  )
}

beforeAll(async () => {
  iss = await issuer()
  mf = await start({ ALLOW: allowVarOf() })
  base = await mf.ready
})

afterAll(async () => {
  await mf.dispose()
  if (savedTmp === undefined) delete process.env['TMPDIR']
  else process.env['TMPDIR'] = savedTmp
  // Its unawaited removal may still be writing under it: retry until gone.
  for (let i = 0; i < 40 && existsSync(tmpRoot); i++) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      await Bun.sleep(50)
    }
  }
})

conformance('Workers with D1', {
  base: () => base.href,
  sign: (job) => iss.sign(job, AUD),
  issuer: GITHUB,
  repository: REPO,
})

it('refuses every request, saying why, while ALLOW, TIMING_DAYS or READ_ACCESS is unset or wrong', async () => {
  const rows = [
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
    // wrangler.jsonc may write a var as JSON: `true` was read as 1 day,
    // where the Bun entry refuses TIMING_DAYS=true.
    [
      { ALLOW: allowVarOf(), TIMING_DAYS: true },
      500,
      'TIMING_DAYS: a whole number of days, got true',
    ],
    // A blank AUDIENCE was taken: every token was then "wrong audience".
    [
      { ALLOW: allowVarOf(), AUDIENCE: ' ' },
      500,
      'AUDIENCE: the aud CI tokens name, or unset, not blank',
    ],
    // wrangler.jsonc may write a var as JSON: "env.AUDIENCE.trim is not a function".
    [{ ALLOW: allowVarOf(), AUDIENCE: 42 }, 500, 'AUDIENCE: one string, the aud CI tokens name'],
    [
      { ALLOW: allowVarOf(), AUDIENCE: ['https://a.example'] },
      500,
      'AUDIENCE: one string, the aud CI tokens name',
    ],
    [{ ALLOW: allowVarOf(), READ_ACCESS: 'yes' }, 500, 'READ_ACCESS: public, or unset, not yes'],
    // wrangler.jsonc may write a var as JSON: a list was refused "not public".
    [
      { ALLOW: allowVarOf(), READ_ACCESS: ['public'] },
      500,
      'READ_ACCESS: public, or unset, not ["public"]',
    ],
  ] as const
  const each = await startEach(rows.map(([bindings]) => bindings))
  try {
    const url = await each.ready
    for (const [i, [, status, message]] of rows.entries()) {
      // Miniflare's entry routes by this header to the named Worker.
      const res = await each.dispatchFetch(new URL('/v1/capabilities', url), {
        headers: {
          authorization: `Bearer ${await iss.sign('read', AUD)}`,
          'MF-Route-Override': `row-${i}`,
        },
      })
      expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([
        status,
        message,
      ])
    }
  } finally {
    await each.dispose()
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

// bun.test.ts holds READ_ACCESS=public at the handler; this holds the
// Worker's var to the same answers.
it('reads with no token where READ_ACCESS is public, only a repository ALLOW names, and writes nothing', async () => {
  const open = await start({ ALLOW: allowVarOf(), READ_ACCESS: 'public' })
  try {
    const ready = await open.ready
    const post = (route: string, body: unknown, token?: string) =>
      fetch(new URL(route, ready), {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
      })
    const timings = [{ hash: 'h1', durationMs: 100 }]
    const up = await post('/v1/timings/upload', { timings }, await iss.sign('main', AUD))
    const ask = (issuer: string, repository: string) =>
      post('/v1/timings/query', { issuer, repository, refs: ['refs/heads/main'], hashes: ['h1'] })
    const read = await ask(`${GITHUB}/`, REPO.toUpperCase())
    const other = await ask(GITHUB, 'acme/other')
    const write = await post('/v1/timings/upload', { timings })
    expect([up.status, read.status, other.status, write.status]).toEqual([204, 200, 403, 403])
    expect(((await read.json()) as { timings: object }).timings).toEqual({
      h1: { durationMs: 100, cores: null, rssBytes: null, slowMs: 100, runs: 1 },
    })
  } finally {
    await open.dispose()
  }
})
