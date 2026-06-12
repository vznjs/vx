# `src/orchestrator/summary.ts` — end-of-run summary lines

## Purpose

Format the closing `Tasks / Cached / Time` block. Always printed after
a `vx run` invocation completes (success or failure). Counts only
real tasks — group nodes are filtered upstream by `orchestrator.run`
before this function is called.

## Public surface

```ts
export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors?: ColorSupport,
): string[]

export function formatDuration(ms: number): string
```

`formatRunSummary` returns an array of lines (caller writes one per
`log.status`). Leading blank line is included so the summary stands
apart from the last framed block.

## Format

```
 Tasks:    3 successful, 1 failed, 4 total
 Cache:    1 miss · 0 up-to-date · 2 local · 1 remote
  Time:    5.34s
```

Colors:

- `successful` is green.
- `failed` is bold red (only shown when N > 0).
- `skipped` is yellow (only shown when N > 0).
- `>>> FULL CACHE` motif appended to the time line when every task in
  the run came from cache (local or remote). Mirrors Turbo's
  `>>> FULL TURBO`.

Duration:

- `<1s` → `Nms`
- ≥1s → `N.NNs`

## Tests

`tests/summary.test.ts`:

- Mixed-status row (success + failed + skipped + cache).
- All-success rendering.
- Empty outcomes (zero-task summary).
- FULL CACHE motif appears when every task cached, otherwise absent.
- Duration formatting (sub-second vs second+).
