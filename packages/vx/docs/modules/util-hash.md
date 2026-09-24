# `src/util/hash.ts` — xxHash3 helpers

## Purpose

Thin wrappers over `Bun.hash.xxHash3` shared by every cache-key
derivation site (`Cache.key`, `task-hash.ts`, workspace fingerprint,
config-load cache busting). xxHash3 has no streaming hasher API in
Bun, so multi-part keys chain digests via the seed parameter. Bun reads
only the low 32 bits of that seed, so `xxh3` XORs the seed back into the
digest (feed-forward): a chain carries 64 bits of state, and a seed of
`0n` returns Bun's digest unchanged (item 682).

## Public surface

```ts
export function xxh3(input: string | Uint8Array, seed?: bigint): bigint
export function xxh3hex(input: string | Uint8Array, seed?: bigint): string // 16-hex, zero-padded
```

## Invariants

- 16-hex output width matches Turbo's xxh64 key width; changing the
  algorithm or width is a `CACHE_VERSION` bump.
- A chained step depends on all 64 bits of its seed. A bare
  `Bun.hash.xxHash3(part, seed)` chain does not; nothing folds that way
  (the lockfile parsers pass the global digest as data).

## Tests

`tests/util-hash.test.ts`: the published XXH3_64bits vectors for `""`
and `"abc"`, the default seed of exactly `0n` (`Cache.key` seeds its
chain from it), determinism, the barrel re-export being the same
function, and the fixed 16-char rendering. Pinned again by every
cache-key stability test. `tests/hash-chain.test.ts`: Bun's 32-bit seed
read (pinned, so an upgrade that changes it is a decision), a
birthday-found pair of states sharing a low half kept apart after a
common tail, and 2^17 `Cache.key` calls over one env value with no two
keys equal; both collision rows are red without the feed-forward.
