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
─ vx ───────────────────────────────────────────────────────
  tasks   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
          1 failed · 20 success · 2 skipped
  failed  @app/web#build
  cache   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
          18 miss · 3 up-to-date · 2 local

  time    5.2s · max 1.8s · avg 230ms · min 4ms
```

Colors:

- `successful` is green.
- `failed` is bold red (only shown when N > 0).
- `skipped` is yellow (only shown when N > 0).
- `⚡ instant` motif appended to the time line when every task in
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
- Stacked state meters (50 cells, largest-remainder allocation, every non-zero bucket gets >= 1 cell): tasks bar = failed/success/skipped, cache bar = miss/up-to-date/local/remote; color-coded legends below each bar.
- Gradient wordmark rule (violet -> pink across the dashes).
- Failed list capped at 5 ids + '... +N more' (frames above carry the rest).
- Time row: blank line above, total + dim 'max / avg / min' per-task spread (skipped excluded).
- Duration formatting (sub-second vs second+).
