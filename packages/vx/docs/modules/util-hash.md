# `src/util/hash.ts` — xxHash3 helpers

## Purpose

Thin wrappers over `Bun.hash.xxHash3` shared by every cache-key
derivation site (`Cache.key`, `task-hash.ts`, workspace fingerprint,
config-load cache busting). xxHash3 has no streaming hasher API in
Bun, so multi-part keys chain digests via the seed parameter.

## Public surface

```ts
export function xxh3(input: string | Uint8Array, seed?: bigint): bigint
export function xxh3hex(input: string | Uint8Array, seed?: bigint): string // 16-hex, zero-padded
```

## Invariants

- 16-hex output width matches Turbo's xxh64 key width; changing the
  algorithm or width is a `CACHE_VERSION` bump.

## Tests

`tests/util-hash.test.ts`: the published XXH3_64bits vectors for `""`
and `"abc"`, the default seed of exactly `0n` (`Cache.key` seeds its
chain from it), determinism, the barrel re-export being the same
function, and the fixed 16-char rendering. Pinned again by every
cache-key stability test.
