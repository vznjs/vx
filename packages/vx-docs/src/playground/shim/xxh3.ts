// XXH3-64 with a seed, in pure TypeScript over BigInt: the one hash the
// cache key folds (`util/hash.ts`, `Bun.hash.xxHash3(input, seed)`), for a
// runtime that has no Bun. A port of the reference scalar path (xxHash
// 0.8, BSD-2-Clause; the constants and kSecret are the reference's). Sync
// on purpose: core's `xxh3()` is sync, and hash-wasm's seeded XXH3 exists
// only behind a Promise. BigInt is slow next to WASM, and the playground
// hashes a few hundred short strings per plan, so it does not matter.

const M64 = (1n << 64n) - 1n
const P32_1 = 0x9e3779b1n
const P32_2 = 0x85ebca77n
const P32_3 = 0xc2b2ae3dn
const P64_1 = 0x9e3779b185ebca87n
const P64_2 = 0xc2b2ae3d27d4eb4fn
const P64_3 = 0x165667b19e3779f9n
const P64_4 = 0x85ebca77c2b2ae63n
const P64_5 = 0x27d4eb2f165667c5n

const K_SECRET = new Uint8Array([
  0xb8, 0xfe, 0x6c, 0x39, 0x23, 0xa4, 0x4b, 0xbe, 0x7c, 0x01, 0x81, 0x2c, 0xf7, 0x21, 0xad, 0x1c,
  0xde, 0xd4, 0x6d, 0xe9, 0x83, 0x90, 0x97, 0xdb, 0x72, 0x40, 0xa4, 0xa4, 0xb7, 0xb3, 0x67, 0x1f,
  0xcb, 0x79, 0xe6, 0x4e, 0xcc, 0xc0, 0xe5, 0x78, 0x82, 0x5a, 0xd0, 0x7d, 0xcc, 0xff, 0x72, 0x21,
  0xb8, 0x08, 0x46, 0x74, 0xf7, 0x43, 0x24, 0x8e, 0xe0, 0x35, 0x90, 0xe6, 0x81, 0x3a, 0x26, 0x4c,
  0x3c, 0x28, 0x52, 0xbb, 0x91, 0xc3, 0x00, 0xcb, 0x88, 0xd0, 0x65, 0x8b, 0x1b, 0x53, 0x2e, 0xa3,
  0x71, 0x64, 0x48, 0x97, 0xa2, 0x0d, 0xf9, 0x4e, 0x38, 0x19, 0xef, 0x46, 0xa9, 0xde, 0xac, 0xd8,
  0xa8, 0xfa, 0x76, 0x3f, 0xe3, 0x9c, 0x34, 0x3f, 0xf9, 0xdc, 0xbb, 0xc7, 0xc7, 0x0b, 0x4f, 0x1d,
  0x8a, 0x51, 0xe0, 0x4b, 0xcd, 0xb4, 0x59, 0x31, 0xc8, 0x9f, 0x7e, 0xc9, 0xd9, 0x78, 0x73, 0x64,
  0xea, 0xc5, 0xac, 0x83, 0x34, 0xd3, 0xeb, 0xc3, 0xc5, 0x81, 0xa0, 0xff, 0xfa, 0x13, 0x63, 0xeb,
  0x17, 0x0d, 0xdd, 0x51, 0xb7, 0xf0, 0xda, 0x49, 0xd3, 0x16, 0x55, 0x26, 0x29, 0xd4, 0x68, 0x9e,
  0x2b, 0x16, 0xbe, 0x58, 0x7d, 0x47, 0xa1, 0xfc, 0x8f, 0xf8, 0xb8, 0xd1, 0x7a, 0xd0, 0x31, 0xce,
  0x45, 0xcb, 0x3a, 0x8f, 0x95, 0x16, 0x04, 0x28, 0xaf, 0xd7, 0xfb, 0xca, 0xbb, 0x4b, 0x40, 0x7e,
])
const K_SECRET_VIEW = new DataView(K_SECRET.buffer)

const encoder = new TextEncoder()

function r64(v: DataView, off: number): bigint {
  return v.getBigUint64(off, true)
}

function r32(v: DataView, off: number): bigint {
  return BigInt(v.getUint32(off, true))
}

function mulFold64(a: bigint, b: bigint): bigint {
  const p = a * b
  return (p & M64) ^ (p >> 64n)
}

function rotl64(x: bigint, r: bigint): bigint {
  return ((x << r) | (x >> (64n - r))) & M64
}

function swap32(x: bigint): bigint {
  return ((x & 0xffn) << 24n) | ((x & 0xff00n) << 8n) | ((x >> 8n) & 0xff00n) | ((x >> 24n) & 0xffn)
}

function swap64(x: bigint): bigint {
  return (swap32(x & 0xffffffffn) << 32n) | swap32(x >> 32n)
}

function avalanche(h: bigint): bigint {
  h ^= h >> 37n
  h = (h * 0x165667919e3779f9n) & M64
  return h ^ (h >> 32n)
}

function xxh64Avalanche(h: bigint): bigint {
  h ^= h >> 33n
  h = (h * P64_2) & M64
  h ^= h >> 29n
  h = (h * P64_3) & M64
  return h ^ (h >> 32n)
}

function rrmxmx(h: bigint, len: number): bigint {
  h ^= rotl64(h, 49n) ^ rotl64(h, 24n)
  h = (h * 0x9fb21c651e98df25n) & M64
  h ^= (h >> 35n) + BigInt(len)
  h = (h * 0x9fb21c651e98df25n) & M64
  return h ^ (h >> 28n)
}

function mix16B(v: DataView, off: number, s: DataView, soff: number, seed: bigint): bigint {
  return mulFold64(
    r64(v, off) ^ ((r64(s, soff) + seed) & M64),
    r64(v, off + 8) ^ ((r64(s, soff + 8) - seed) & M64),
  )
}

function len0to16(b: Uint8Array, v: DataView, s: DataView, seed: bigint): bigint {
  const len = b.length
  if (len > 8) {
    const bitflip1 = ((r64(s, 24) ^ r64(s, 32)) + seed) & M64
    const bitflip2 = ((r64(s, 40) ^ r64(s, 48)) - seed) & M64
    const lo = r64(v, 0) ^ bitflip1
    const hi = r64(v, len - 8) ^ bitflip2
    return avalanche((BigInt(len) + swap64(lo) + hi + mulFold64(lo, hi)) & M64)
  }
  if (len >= 4) {
    const sd = seed ^ (swap32(seed & 0xffffffffn) << 32n)
    const in1 = r32(v, 0)
    const in2 = r32(v, len - 4)
    const bitflip = ((r64(s, 8) ^ r64(s, 16)) - sd) & M64
    return rrmxmx((in2 + (in1 << 32n)) ^ bitflip, len)
  }
  if (len > 0) {
    const combined =
      (BigInt(b[0]!) << 16n) |
      (BigInt(b[len >> 1]!) << 24n) |
      BigInt(b[len - 1]!) |
      (BigInt(len) << 8n)
    const bitflip = ((r32(s, 0) ^ r32(s, 4)) + seed) & M64
    return xxh64Avalanche(combined ^ bitflip)
  }
  return xxh64Avalanche(seed ^ r64(s, 56) ^ r64(s, 64))
}

function len17to128(v: DataView, len: number, s: DataView, seed: bigint): bigint {
  let acc = BigInt(len) * P64_1
  if (len > 32) {
    if (len > 64) {
      if (len > 96) {
        acc += mix16B(v, 48, s, 96, seed)
        acc += mix16B(v, len - 64, s, 112, seed)
      }
      acc += mix16B(v, 32, s, 64, seed)
      acc += mix16B(v, len - 48, s, 80, seed)
    }
    acc += mix16B(v, 16, s, 32, seed)
    acc += mix16B(v, len - 32, s, 48, seed)
  }
  acc += mix16B(v, 0, s, 0, seed)
  acc += mix16B(v, len - 16, s, 16, seed)
  return avalanche(acc & M64)
}

function len129to240(v: DataView, len: number, s: DataView, seed: bigint): bigint {
  let acc = BigInt(len) * P64_1
  const rounds = Math.floor(len / 16)
  for (let i = 0; i < 8; i++) acc += mix16B(v, 16 * i, s, 16 * i, seed)
  acc = avalanche(acc & M64)
  for (let i = 8; i < rounds; i++) acc += mix16B(v, 16 * i, s, 16 * (i - 8) + 3, seed)
  acc += mix16B(v, len - 16, s, 136 - 17, seed)
  return avalanche(acc & M64)
}

function accumulate512(acc: bigint[], v: DataView, off: number, s: DataView, soff: number): void {
  for (let i = 0; i < 8; i++) {
    const val = r64(v, off + 8 * i)
    const key = val ^ r64(s, soff + 8 * i)
    acc[i ^ 1] = (acc[i ^ 1]! + val) & M64
    acc[i] = (acc[i]! + (key & 0xffffffffn) * (key >> 32n)) & M64
  }
}

function scramble(acc: bigint[], s: DataView, soff: number): void {
  for (let i = 0; i < 8; i++) {
    let a = acc[i]!
    a ^= a >> 47n
    a ^= r64(s, soff + 8 * i)
    acc[i] = (a * P32_1) & M64
  }
}

function hashLong(v: DataView, len: number, seed: bigint): bigint {
  let s = K_SECRET_VIEW
  if (seed !== 0n) {
    const custom = new DataView(new ArrayBuffer(192))
    for (let i = 0; i < 12; i++) {
      custom.setBigUint64(16 * i, (r64(K_SECRET_VIEW, 16 * i) + seed) & M64, true)
      custom.setBigUint64(16 * i + 8, (r64(K_SECRET_VIEW, 16 * i + 8) - seed) & M64, true)
    }
    s = custom
  }
  const acc = [P32_3, P64_1, P64_2, P64_3, P64_4, P32_2, P64_5, P32_1]
  const stripesPerBlock = (192 - 64) / 8
  const blockLen = 64 * stripesPerBlock
  const blocks = Math.floor((len - 1) / blockLen)
  for (let n = 0; n < blocks; n++) {
    for (let st = 0; st < stripesPerBlock; st++) {
      accumulate512(acc, v, n * blockLen + st * 64, s, st * 8)
    }
    scramble(acc, s, 192 - 64)
  }
  const stripes = Math.floor((len - 1 - blockLen * blocks) / 64)
  for (let st = 0; st < stripes; st++) accumulate512(acc, v, blocks * blockLen + st * 64, s, st * 8)
  accumulate512(acc, v, len - 64, s, 192 - 64 - 7)
  let result = (BigInt(len) * P64_1) & M64
  for (let i = 0; i < 4; i++) {
    result += mulFold64(
      acc[2 * i]! ^ r64(s, 11 + 16 * i),
      acc[2 * i + 1]! ^ r64(s, 11 + 16 * i + 8),
    )
  }
  return avalanche(result & M64)
}

/**
 * `Bun.hash.xxHash3(input, seed)` as Bun 1.4.2 computes it: the reference
 * XXH3-64 under only the LOW 32 BITS of the seed. Bun drops the high half
 * (tests/playground-xxh3.test.ts holds it), so the reference over the full
 * seed disagrees with every chained key step whose seed is a 64-bit digest.
 */
export function bunXxHash3(input: string | Uint8Array, seed: bigint | number = 0n): bigint {
  return xxHash3(input, BigInt(seed) & 0xffffffffn)
}

/** Reference XXH3_64bits_withSeed over the UTF-8 bytes of a string, full 64-bit seed. */
export function xxHash3(input: string | Uint8Array, seed: bigint | number = 0n): bigint {
  const b = typeof input === 'string' ? encoder.encode(input) : input
  const sd = BigInt(seed) & M64
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const len = b.length
  if (len <= 16) return len0to16(b, v, K_SECRET_VIEW, sd)
  if (len <= 128) return len17to128(v, len, K_SECRET_VIEW, sd)
  if (len <= 240) return len129to240(v, len, K_SECRET_VIEW, sd)
  return hashLong(v, len, sd)
}
