// W9 spike (item 676): what `Bun.hash.xxHash3` does with a seed above 2^32.
//
//   bun packages/vx-bench/playground-spike/seed-probe.ts
//
// Measured on Bun 1.4.2: only the low 32 bits of the seed reach the hash.
// Two seeds equal in their low 32 bits hash identically, and the pure-TS
// reference port agrees with Bun only after masking the seed to 32 bits.

import { xxHash3 } from './shim/xxh3.js'

const M32 = 0xffffffffn
let sameLow = 0
let differentLow = 0
let refFull = 0
let refLow32 = 0
const N = 500
for (let i = 0; i < N; i++) {
  const input = `packages/p${i}/src/index.ts\0${i.toString(16)}`
  const seed = BigInt.asUintN(64, BigInt(i + 1) * 0x9e3779b97f4a7c15n)
  const twin = (seed & M32) | (BigInt.asUintN(32, BigInt(i) * 7919n + 1n) << 32n)
  const bun = Bun.hash.xxHash3(input, seed)
  if (twin !== seed && Bun.hash.xxHash3(input, twin) === bun) sameLow++
  if (Bun.hash.xxHash3(input, seed ^ 1n) !== bun) differentLow++
  if (xxHash3(input, seed) === bun) refFull++
  if (xxHash3(input, seed & M32) === bun) refLow32++
}
console.log(
  JSON.stringify({
    bun: Bun.version,
    samples: N,
    highBitsIgnored: sameLow,
    lowBitsMatter: differentLow,
    referenceWithFull64BitSeedMatchesBun: refFull,
    referenceWithLow32BitSeedMatchesBun: refLow32,
  }),
)
