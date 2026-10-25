// src/worker.ts in workerd, the runtime Workers deploy to, with D1 and R2.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { sha256 } from '../src/auth.js'
import { conformance } from './conformance.js'

const READ = 'read-token'
const WRITE = 'write-token'
const MAX = 7 * 1024 * 1024

let mf: Miniflare
let base: URL

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
      bindings,
    }),
  )
}

beforeAll(async () => {
  mf = await start({
    TOKENS: `read:${await sha256(READ)} write:${await sha256(WRITE)}`,
    MAX_ARTIFACT_BYTES: String(MAX),
    // jose loads in workerd: CI tokens and static ones share one Authorize.
    TRUST: JSON.stringify([
      {
        iss: 'https://token.actions.githubusercontent.com',
        repository_id: '42',
        ref: 'refs/heads/main',
      },
    ]),
  })
  base = await mf.ready
})

afterAll(() => mf.dispose())

conformance('Workers with D1 and R2', {
  base: () => base.href,
  read: READ,
  write: WRITE,
  maxArtifactBytes: MAX,
})

it('refuses every request, saying why, until TOKENS is set right', async () => {
  for (const [tokens, detail] of [
    ['', 'the server lists no token: set TOKENS'],
    ['write:abc', 'TOKENS: write:abc is not read:<sha256> or write:<sha256>'],
  ]) {
    const other = await start({ TOKENS: tokens! })
    try {
      const res = await fetch(new URL('/v1/artifacts/abc', await other.ready))
      expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([
        tokens === '' ? 401 : 500,
        detail as string,
      ])
    } finally {
      await other.dispose()
    }
  }
})

it('refuses every request, saying why, while TRUST is wrong', async () => {
  const other = await start({ TOKENS: '', TRUST: '[{"iss":"https://gitlab.com"}]' })
  try {
    const res = await fetch(new URL('/v1/artifacts/abc', await other.ready))
    expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([
      500,
      'TRUST: rule 0: names no project_id (one repository, no *)',
    ])
  } finally {
    await other.dispose()
  }
})

it("runs the Cron Trigger's eviction in workerd, over D1 and R2", async () => {
  // A retention of about 0.1 s: what was written before the sweep is old.
  const other = await start({ TOKENS: `write:${await sha256(WRITE)}`, TRUSTED_DAYS: '0.000001' })
  try {
    const at = await other.ready
    const auth = { authorization: `Bearer ${WRITE}` }
    await fetch(new URL('/v1/artifacts/e71c71', at), { method: 'PUT', body: 'x', headers: auth })
    await Bun.sleep(200)
    // miniflare's own types name a Fetcher and an R2 bucket it does not export.
    const worker = (await other.getWorker()) as unknown as {
      scheduled(o: { cron: string }): Promise<{ outcome: string }>
    }
    expect((await worker.scheduled({ cron: '17 3 * * *' })).outcome).toBe('ok')
    const res = await fetch(new URL('/v1/artifacts/e71c71', at), { method: 'HEAD', headers: auth })
    expect(res.status).toBe(404)
    const bucket = (await other.getR2Bucket('BLOBS')) as unknown as {
      head(key: string): Promise<unknown>
    }
    expect(await bucket.head('v1/default/trusted/e71c71')).toBeNull()
  } finally {
    await other.dispose()
  }
})
