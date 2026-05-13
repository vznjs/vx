# `src/util/paths.ts` — POSIX-path normalisation

## Purpose

Normalize path separators to forward slashes so cache keys are stable
across Windows / \*nix. Used wherever a path participates in a cache
key (input file paths, output file paths, etc.).

## Public surface

```ts
export function toPosix(p: string): string
export function relPosix(from: string, to: string): string
```

- `toPosix(p)` — replaces every `path.sep` with `/`.
- `relPosix(from, to)` — `path.relative(from, to)` then `toPosix`.

## Why

A workspace cloned on Windows would otherwise produce a different
cache key than the same workspace on Linux for the same task — the
filesystem walk yields `src\index.ts` vs `src/index.ts`. Folding
those into the hash differently is the kind of cross-platform paper
cut we don't want.

vx is POSIX-shell only at the runner level, so Windows isn't
officially supported anyway — but normalizing cache-key paths costs
nothing and keeps things robust.

## Tests

Exercised transitively through `tests/cache.test.ts` (cache-key
determinism) and `tests/inputs.test.ts` (glob result shapes).
