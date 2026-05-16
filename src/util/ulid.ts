// Run-id generator. Thin wrapper over `Bun.randomUUIDv7()` so the
// `runId` column on `runs` carries a timestamp-ordered identifier —
// `vx stats --since` queries can range-scan without an index on the
// time column, and the IDs lexicographically sort by creation time
// for grouping.
//
// UUIDv7 layout: 48-bit ms-epoch timestamp + 74 bits of randomness
// across the remaining bytes (RFC 9562). Standard format, hex with
// hyphens, 36 chars. Previously a hand-rolled 26-char Crockford-
// base32 ULID — Bun's built-in covers the same guarantees with zero
// custom code.

export function ulid(): string {
  return Bun.randomUUIDv7()
}
