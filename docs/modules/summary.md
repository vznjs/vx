# `src/orchestrator/summary.ts` — end-of-run summary lines

## Purpose

Format the closing footer block — this is the run's **only** banner.
The top-of-run header was removed; the run context (version, requested
tasks, project/task/worker counts, cache mode, affected-scope bar) now
rides the footer above the result meters, printed once at the end where
the eye lands. Always printed after a `vx run` invocation completes
(success or failure). Counts only real tasks — group nodes are filtered
upstream by `orchestrator.run` before this function is called.

## Public surface

```ts
export interface RunContext {
  version: string
  packageCount: number // projects covered → the bar's "affected" half
  concurrency?: number // worker-pool size (info row)
  remoteCacheEnabled: boolean
  workspaceProjectCount?: number // total projects → the bar's denominator
}

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors?: ColorSupport,
  context?: RunContext,
): string[]

export function formatDuration(ms: number): string
```

`formatRunSummary` returns an array of lines (caller writes one per
`log.status`). Leading blank line is included so the summary stands
apart from the last framed block. When `context` is omitted (the live
status region, which fills in the meters as the run proceeds) the rule
reads a bare `vx` and the `projects` / `info` rows are skipped — the
meters-only section the region renders.

## Format

```
─ vx 0.0.0 ───────────────────────────────────────────────────
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱
            1 affected · 2 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            4 success · 4 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            4 miss

  info      10 workers · local cache
  time      248ms · max 239ms · avg 215ms · min 190ms
```

Labels pad to 8, bars start at column 12, the rule + bars span 50
cells. `projects` (affected vs workspace total) leads the meter stack;
`tasks` and `cache` follow, the tasks legend carrying a dim `N total`.
A blank line separates the meters from the `info` row (worker pool +
cache mode) and the `time` row. `projects` and `info` only render when
a `RunContext` is passed (the final footer); the live region shows the
meters alone.

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
- Stacked state meters (50 cells, largest-remainder allocation, every non-zero bucket gets >= 1 cell): tasks bar = failed/success/skipped, cache bar = miss/no-cache (dim: a task with no `cache` block never consulted it)/up-to-date/local/remote; color-coded legends below each bar.
- Gradient wordmark rule (violet -> pink across the dashes).
- Failed list capped at 5 ids + '... +N more' (frames above carry the rest).
- Time row: blank line above, total + dim 'max / avg / min' per-task spread (skipped excluded).
- Duration formatting (sub-second vs second+).
