// Item 682: every cache key, the workspace fingerprint and the config-eval
// key are seed-chained xxHash3 folds (`h = xxh3(part, h)`), and Bun's
// xxHash3 reads only the LOW 32 bits of its seed. A bare chain therefore
// carried 32 bits of state from step to step: two input sets whose running
// digests shared their low halves merged at the next step. A birthday
// search over ~2^17 values finds such a pair in well under a second — a
// stale hit at ~2^-32 per step. `xxh3` now feeds the seed forward.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Cache, type CacheKeyInput } from '../src/cache/index.js'
import { xxh3 } from '../src/util/index.js'

const LOW = 0xffffffffn

/** Two distinct values whose one-step states from `base` share their low 32 bits. */
function lowHalfPair(base: bigint, value: (i: number) => string): [string, string] {
  const seen = new Map<number, string>()
  for (let i = 0; i < 1 << 20; i++) {
    const v = value(i)
    const low = Number(xxh3(v, base) & LOW)
    const prev = seen.get(low)
    if (prev !== undefined) return [prev, v]
    seen.set(low, v)
  }
  throw new Error('no low-half pair in 2^20 values')
}

describe('the seed-chained fold carries 64 bits of state (item 682)', () => {
  it("Bun's xxHash3 reads only the low 32 bits of its seed — the premise of the fix", () => {
    // If a Bun release starts reading all 64 bits, every chained digest
    // moves at once (a mass miss, not a stale hit): this row goes red so the
    // upgrade is a decision, with a CACHE_VERSION bump for the notice.
    const d = 'vx'
    const seed = 0x1234_5678_9abc_def0n
    expect([
      Bun.hash.xxHash3(d, seed) === Bun.hash.xxHash3(d, seed & LOW),
      Bun.hash.xxHash3(d, seed) === Bun.hash.xxHash3(d, seed ^ 1n),
    ]).toEqual([true, false])
  })

  it('two states that share their low half do not merge after a common tail', () => {
    const base = xxh3('prefix')
    const [a, b] = lowHalfPair(base, (i) => `API_URL\0https://x/${i}`)
    const sa = xxh3(a, base)
    const sb = xxh3(b, base)
    // Positive first: the pair really does share the half the seed reads.
    expect([sa !== sb, (sa & LOW) === (sb & LOW)]).toEqual([true, true])
    const tail = (s: bigint) => xxh3('src/a.ts\0abc', xxh3('inputs:1', s))
    expect(tail(sa)).not.toBe(tail(sb))
  })

  it('a seed of 0 changes nothing, so single-shot digests keep their values', () => {
    expect(xxh3('vx')).toBe(Bun.hash.xxHash3('vx'))
  })
})

describe('Cache.key over env values a 32-bit chain would merge (item 682)', () => {
  let dir: string
  let cache: Cache
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-hashchain-'))
    cache = new Cache(path.join(dir, 'cache'))
  })
  afterAll(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('no two of 2^17 env values share a key', async () => {
    // Under the 32-bit chain, 2^17 keys that differ only in one env value
    // hold about as many merged pairs as there are steps after the env step
    // (N^2/2 x 2^-32 each); with 64 bits of state the expected count is ~0.
    const input = (v: string): CacheKeyInput => ({
      taskId: 'pkg#build',
      taskConfigHash: 'config',
      projectPackageJsonHash: 'pkg',
      envValues: [['API_URL', v]],
      inputFiles: [],
      workspaceRoot: dir,
      upstreamHashes: ['u1', 'u2'],
      workspaceFingerprint: 'ws',
    })
    const keys = new Set<string>()
    const n = 1 << 17
    for (let i = 0; i < n; i++) keys.add(await cache.key(input(`https://x/${i}`)))
    expect(keys.size).toBe(n)
  })
})
