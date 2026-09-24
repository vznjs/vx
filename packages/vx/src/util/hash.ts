// Shared non-cryptographic hash helper. xxHash3 is ~5× faster than
// SHA-256 on modern x86 and produces enough entropy (64 bits) for our
// uses: cache-key derivation, file content fingerprinting, config-
// load module cache-busting. None of those need collision resistance
// against an adversary; they just need uniqueness across honest input.
//
// Hex output is a fixed 16-char string. Turbo uses the same shape
// (xxh64 -> hex(to_be_bytes(u64))) — short enough to live in
// filenames, recognizable when grepping logs.
//
// `Bun.hash.xxHash3` has no streaming Hasher API but takes a seed —
// we use that seed to chain multiple updates: each `xxh3(part, prev)`
// folds `part` into the running digest. Equivalent to the old
// `CryptoHasher.update(...).update(...).digest()` pattern, without
// allocating an intermediate buffer.
//
// Bun reads only the LOW 32 bits of that seed (measured, item 682), so a
// bare `xxHash3(part, prev)` carries 32 bits of state from step to step:
// two input sets whose running digests share their low halves merge at
// the next step, and a birthday search found such a pair in 0.08 s — a
// stale hit at ~2^-32 per step, not 2^-64. The seed is XORed back in
// (feed-forward): states that share their low half keep their exact
// high-half difference through every later step, so they never merge,
// and a seed of 0 changes nothing, so single-shot digests are unchanged.

/** xxHash3 bigint output. Use as the seed for the next chain step. */
export function xxh3(input: string | Uint8Array, seed: bigint = 0n): bigint {
  return Bun.hash.xxHash3(input, seed) ^ seed
}

/** xxHash3 hex-encoded, fixed 16 chars (zero-padded). */
export function xxh3hex(input: string | Uint8Array, seed: bigint = 0n): string {
  return xxh3(input, seed).toString(16).padStart(16, '0')
}
