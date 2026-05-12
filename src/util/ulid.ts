// Tiny ULID generator — 26-char lexicographically-sortable id with a
// 48-bit ms timestamp prefix + 80 bits of randomness, encoded in
// Crockford's base32. Used as `run_id` so every task in one `vx run`
// invocation shares an id (lets analytics queries group by invocation).
//
// Why not pull in the `ulid` npm package: it's 12 KB on disk with a
// browser/node split and zero of its features beyond what we use here.
// Hand-roll keeps the dep tree slim.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

function encodeTime(ms: number): string {
  // 48 bits of time → 10 base32 chars. JS numbers can hold this safely
  // (53-bit mantissa).
  let out = ''
  let n = Math.floor(ms)
  for (let i = 0; i < 10; i++) {
    out = ENCODING[n & 31]! + out
    n = Math.floor(n / 32)
  }
  return out
}

function encodeRandom(): string {
  // 80 bits of randomness → 16 base32 chars. Use crypto.getRandomValues
  // (universally available in Bun, Node, browsers) so we don't lean on
  // Math.random (poor entropy, may collide under heavy parallelism).
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let out = ''
  // Each byte yields 1.6 base32 chars; we pack 5 bytes → 8 chars at a
  // time, twice.
  for (let block = 0; block < 2; block++) {
    const off = block * 5
    const a = bytes[off]!
    const b = bytes[off + 1]!
    const c = bytes[off + 2]!
    const d = bytes[off + 3]!
    const e = bytes[off + 4]!
    out += ENCODING[a >> 3]!
    out += ENCODING[((a & 0x07) << 2) | (b >> 6)]!
    out += ENCODING[(b >> 1) & 0x1f]!
    out += ENCODING[((b & 0x01) << 4) | (c >> 4)]!
    out += ENCODING[((c & 0x0f) << 1) | (d >> 7)]!
    out += ENCODING[(d >> 2) & 0x1f]!
    out += ENCODING[((d & 0x03) << 3) | (e >> 5)]!
    out += ENCODING[e & 0x1f]!
  }
  return out
}
