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
  tasks: readonly string[] // requested task names (deduped)
  taskCount: number // real (non-group) executions
  packageCount: number // projects covered by the graph
  concurrency?: number // worker-pool size
  remoteCacheEnabled: boolean
  workspaceProjectCount?: number // total projects → affected-scope bar
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
reads a bare `vx` and the run rows are skipped — byte-identical to the
meters-only section the region renders.

## Format

```
─ vx 0.0.0 ──────────────────────────────────────────────────
  run     build, test · 5 projects · 23 tasks · 8 workers · local + remote cache
  scope   ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱
          5 affected · 12 total

  tasks   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
          1 failed · 20 success · 2 skipped
  cache   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
          18 miss · 3 up-to-date · 2 local

  time    5.2s · max 1.8s · avg 230ms · min 4ms
```

The `run` row always shows; the `scope` bar only when
`workspaceProjectCount` is set (affected runs). Cache mode (`local
cache` / `local + remote cache`) is a dim suffix on the `run` row.

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
