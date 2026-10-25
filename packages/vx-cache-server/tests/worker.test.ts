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
      expect([res.status, ((await res.json()) as { detail: string }).detail]).toEqual([
        tokens === '' ? 401 : 500,
        detail as string,
      ])
    } finally {
      await other.dispose()
    }
  }
})
