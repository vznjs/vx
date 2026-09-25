// The playground's xxh3 (src/playground/shim/xxh3.ts, a pure-TS port of
// the reference XXH3-64) is byte-identical to `Bun.hash.xxHash3`, the hash
// every cache key folds. The oracle is the running Bun, so a Bun release
// that changes its hash, or how much of the seed it reads (32 bits in
// 1.4.2, item 682), turns this red instead of silently re-keying the
// site's plan away from the CLI's (spike item 676, rows item 695; design:
// packages/vx/docs/design/playground-spike-2026-09.md § xxh3).
import { describe, expect, it } from 'bun:test'
import { bunXxHash3, xxHash3 } from '../src/playground/shim/xxh3.js'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The spike's seed, so these rows are the design note's table.
const rand = mulberry32(676)
const int = (n: number): number => Math.floor(rand() * n)
const u64 = (): bigint => (BigInt(int(2 ** 32)) << 32n) | BigInt(int(2 ** 32))

// Every boundary the algorithm branches on, then random lengths per band.
const EDGES = [0, 1, 2, 3, 4, 5, 8, 9, 15, 16, 17, 32, 33, 64, 65, 96, 97, 127, 128, 129, 239, 240]
const LONG_EDGES = [241, 255, 256, 1023, 1024, 1025, 1088, 2047, 2048, 2049, 4096, 10_000]

function lengthFor(i: number): number {
  if (i < EDGES.length) return EDGES[i]!
  if (i < EDGES.length + LONG_EDGES.length) return LONG_EDGES[i - EDGES.length]!
  const band = i % 4
  if (band === 0) return int(17)
  if (band === 1) return 17 + int(112)
  if (band === 2) return 129 + int(112)
  return 241 + int(6000)
}

function bytesOf(len: number): Uint8Array {
  const b = new Uint8Array(len)
  for (let i = 0; i < len; i++) b[i] = int(256)
  return b
}

// A fifth of the seeds carry high bits, which Bun 1.4.2 does not read.
function seedFor(i: number): bigint {
  const k = i % 5
  if (k === 0) return 0n
  if (k === 1) return BigInt(int(1000))
  if (k === 2 || k === 3) return BigInt(int(2 ** 32))
  return u64()
}

// Non-ASCII too: core hashes strings far more often than bytes.
function stringOf(len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    s += String.fromCodePoint(int(3) === 0 ? 0x4e00 + int(500) : 32 + int(90))
  }
  return s
}

const INPUTS = 1000
const inputs = Array.from({ length: INPUTS }, (_, i) => ({
  i,
  input: i % 7 === 6 ? stringOf(int(300)) : bytesOf(lengthFor(i)),
  seed: seedFor(i),
}))

// Chains shaped like the key fold: each step seeded by the digest before it,
// so every seed after the first is a full 64-bit value.
const CHAINS = 200
const chains = Array.from({ length: CHAINS }, () =>
  Array.from({ length: 1 + int(40) }, (_, k) =>
    k % 3 === 0
      ? `inputs:${int(5000)}`
      : `packages/p${int(9)}/src/f${int(99)}.ts\0${u64().toString(16)}`,
  ),
)

function chain(hash: (s: string, seed?: bigint) => bigint, parts: string[]): bigint {
  let h = hash('vx-cache')
  for (const p of parts) h = hash(p, h)
  return h
}

const bun = (s: string | Uint8Array, seed?: bigint): bigint => Bun.hash.xxHash3(s, seed)

describe('the playground xxh3 equals Bun.hash.xxHash3', () => {
  it('on 1,000 inputs across every length branch, under 0, small, 32- and 64-bit seeds', () => {
    const differ = inputs
      .filter(({ input, seed }) => bunXxHash3(input, seed) !== bun(input, seed))
      .map(({ i, input, seed }) => `#${i} len ${input.length} seed ${seed}`)
    expect(differ).toEqual([])
  })

  it('on 200 seed chains shaped like the key fold', () => {
    const differ = chains.flatMap((parts, c) =>
      chain(bunXxHash3, parts) === chain(bun, parts) ? [] : [c],
    )
    expect(differ).toEqual([])
  })

  // Item 832: a view into a larger buffer (a pooled Buffer, a subarray)
  // hashes its own bytes, not the buffer's from offset 0.
  it('on views that start past their buffer’s first byte, in every length branch', () => {
    const differ = [...EDGES, ...LONG_EDGES].flatMap((len) => {
      const view = bytesOf(len + 13).subarray(13)
      return bunXxHash3(view, 7n) === bun(view, 7n) ? [] : [len]
    })
    expect(differ).toEqual([])
  })

  // The control: the reference read of the seed (all 64 bits) misses on
  // exactly the inputs whose seed has high bits, and on every chain. So the
  // fixture reaches the seeds that matter, and the port matches because it
  // reads the seed as Bun does.
  it("the full 64-bit seed misses exactly where the seed exceeds 32 bits: Bun's read is the port's", () => {
    const high = inputs.filter(({ seed }) => seed >> 32n !== 0n).map(({ i }) => i)
    const differ = inputs
      .filter(({ input, seed }) => xxHash3(input, seed) !== bun(input, seed))
      .map(({ i }) => i)
    expect(high.length).toBe(200)
    expect(differ).toEqual(high)
    const chainsDiffer = chains.filter((parts) => chain(xxHash3, parts) !== chain(bun, parts))
    expect(chainsDiffer.length).toBe(CHAINS)
  })
})
