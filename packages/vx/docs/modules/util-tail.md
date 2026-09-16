# `src/util/tail.ts` — head-evicting tail for a stream that may never end

## Purpose

A persistent task (dev server, watcher, daemon) is unbounded by
construction, so anything accumulating its output needs a cap, and
the cap has to be honest: a truncated log that reads as complete is
worse than one that says what it lost.

```ts
export const PERSISTENT_TAIL_CHARS = 64 * 1024

export interface Tail {
  chunks: string[]
  chars: number
  dropped: number // characters evicted from the head; non-zero means the tail is partial
}
export function createTail(): Tail
export function appendTail(t: Tail, chunk: string, limit?: number): void // limit defaults to PERSISTENT_TAIL_CHARS
export function tailText(t: Tail): string
export function resetTail(t: Tail): void
```

Whole chunks are evicted from the head — no concatenation until the
one join at flush, so a chatty server costs one array push per chunk;
a single chunk over the cap is the one place a copy happens. `dropped`
is non-zero exactly when the tail is partial.

`orchestrator/logger.ts` is the sole holder: one tail per persistent
task from `taskStart` for the rest of the run, covering the pre-ready
window and everything after with one mechanism. A second pre-ready
copy in `exec/runner.ts` was deleted rather than kept in sync — two
copies of the rule had drifted (one grew a bound, the other did not,
and a never-ready `readyWhen` grew the heap ~100 MiB/s with the cap
sitting unused). The file stays in `util` because `exec` cannot import
`orchestrator`.

## Tests

`tests/util-tail.test.ts` (cap, whole-chunk eviction, the oversize
single chunk, `dropped` accounting, reset).
