// W9 spike (item 676): is a browser xxh3 byte-identical to Bun.hash.xxHash3?
//
//   bun packages/vx-bench/playground-spike/xxh3-equiv.ts
//
// Three candidates against the oracle, on the same inputs:
//   - `bunXxHash3` (shim/xxh3.ts), the pure-TS port the bundle uses, with
//     Bun's 32-bit seed truncation (`seed-probe.ts`);
//   - `xxHash3`, the same port under the reference's full 64-bit seed —
//     the control that shows the truncation is what the match rests on;
//   - hash-wasm's `xxhash3` (WASM, async only), given the seed's low half.
// (i) 1,000 random inputs whose lengths cover every branch of XXH3-64
// (0-16, 17-128, 129-240, and long inputs across block boundaries), each
// under a random seed, a fifth of them above 2^32; (ii) 200 seed chains
// shaped like `Cache.key()`, 1-40 parts each, every step
// `xxh3(part, previous)`. Exits 1 when either shipped candidate differs.

import { xxhash3 } from 'hash-wasm'
import { bunXxHash3, xxHash3 } from './shim/xxh3.js'

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

function seedFor(i: number): bigint {
  const k = i % 5
  if (k === 0) return 0n
  if (k === 1) return BigInt(int(1000))
  if (k === 2 || k === 3) return BigInt(int(2 ** 32))
  return u64()
}

function stringOf(len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    s += String.fromCodePoint(int(3) === 0 ? 0x4e00 + int(500) : 32 + int(90))
  }
  return s
}

async function viaWasm(input: string | Uint8Array, seed: bigint): Promise<bigint> {
  return BigInt(`0x${await xxhash3(input, Number(seed & 0xffffffffn), 0)}`)
}

const miss = { pureTs: 0, reference64: 0, hashWasm: 0 }
const chainMiss = { pureTs: 0, reference64: 0, hashWasm: 0 }
const INPUTS = 1000
for (let i = 0; i < INPUTS; i++) {
  // Every seventh input is a string with non-ASCII characters: core hashes strings far more often than bytes.
  const input = i % 7 === 6 ? stringOf(int(300)) : bytesOf(lengthFor(i))
  const seed = seedFor(i)
  const want = Bun.hash.xxHash3(input, seed)
  const got = bunXxHash3(input, seed)
  if (got !== want && miss.pureTs++ === 0) {
    console.error(`pure-TS differs: #${i} len ${input.length} seed ${seed}: ${got} != ${want}`)
  }
  if (xxHash3(input, seed) !== want) miss.reference64++
  if ((await viaWasm(input, seed)) !== want) miss.hashWasm++
}

const CHAINS = 200
for (let c = 0; c < CHAINS; c++) {
  const parts = Array.from({ length: 1 + int(40) }, (_, k) =>
    k % 3 === 0
      ? `inputs:${int(5000)}`
      : `packages/p${int(9)}/src/f${int(99)}.ts\0${u64().toString(16)}`,
  )
  let want = Bun.hash.xxHash3('vx-cache-v28')
  let ts = bunXxHash3('vx-cache-v28')
  let ref = xxHash3('vx-cache-v28')
  let wasm = await viaWasm('vx-cache-v28', 0n)
  for (const p of parts) {
    want = Bun.hash.xxHash3(p, want)
    ts = bunXxHash3(p, ts)
    ref = xxHash3(p, ref)
    wasm = await viaWasm(p, wasm)
  }
  if (ts !== want) chainMiss.pureTs++
  if (ref !== want) chainMiss.reference64++
  if (wasm !== want) chainMiss.hashWasm++
}

console.log(JSON.stringify({ bun: Bun.version, inputs: INPUTS, chains: CHAINS, miss, chainMiss }))
if (miss.pureTs + miss.hashWasm + chainMiss.pureTs + chainMiss.hashWasm > 0) process.exit(1)
