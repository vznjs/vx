# `src/util/paths.ts` — POSIX-path normalisation

## Purpose

Normalize path separators to forward slashes so cache keys are stable
across Windows / \*nix. Used wherever a path participates in a cache
key (input file paths, output file paths, etc.).

## Public surface

```ts
export function toPosix(p: string): string
export function relPosix(from: string, to: string): string
export function normalizeGlob(glob: string): string
export function staticPrefix(glob: string): string
export function wholeSubtreePrefixes(globs: readonly string[]): string[] | null
```

- `toPosix(p)` — replaces every `path.sep` with `/`.
- `relPosix(from, to)` — `path.relative(from, to)` then `toPosix`.
- `normalizeGlob(g)` — the spellings a reader accepts but a matcher turns
  into nothing: a leading `./`, an inner `/./`, a doubled `//`, a trailing
  `/` on a pattern (→ `/**`); after an optional `!`. The one rule behind
  the input/output resolver (`asTrees`), the workspace member globs, the
  watch loop's output containers, the subtree short-circuit and the
  schema's "names the directory itself" refusal (2026-09-10).
- `staticPrefix(g)` — the wildcard-free head of a glob, whole components
  only; a brace set counts as a wildcard. Shared by the sandbox baseline,
  the deferral gate and the watch loop's output container.
- `wholeSubtreePrefixes(globs)` — the `<dir>/**` directories a task's
  outputs cover whole, or `null`; normalizes first.

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
