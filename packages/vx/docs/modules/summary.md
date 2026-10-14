# `src/orchestrator/summary.ts` — end-of-run summary lines

## Purpose

Format the closing footer block — this is the run's **only** banner.
The top-of-run header was removed; the run context (version, requested
tasks, project/task/worker counts, cache mode, projects-in-run bar) now
rides the footer above the result meters, printed once at the end where
the eye lands. Always printed after a `vx run` invocation completes
(success or failure). Counts only real tasks — group nodes are filtered
upstream by `orchestrator.run` before this function is called.

## Public surface

```ts
export interface SummaryStats {
  failed: number
  successful: number
  skipped: number
  aborted?: number // killed by a shutdown signal (final summary only); not in `total`
  notRun?: number // reached by the stop before they ran (final summary only); not in `total`
  total: number
  upToDate: number
  restoredLocal: number
  restoredRemote: number
  miss: number
  noCache?: number // a task no cache answered for (`ranNoCache`) never consulted one
  left?: number // still to run: the live section's gray remainder; 0 in the final summary
  spread: { maxMs: number; minMs: number; sumMs: number; count: number } | null // the time row's per-task spread
  held?: { count: number; sumMs: number } // what an `admit` policy held, summed
  etaMs?: number // live section only: the forecast of what is left (`~3s left` on the time row)
  savedMs?: number // the hits' stored exec times summed: what the cache skipped
  emptyGroups?: readonly string[] // a run of command-less groups: their names, after `0 tasks`
}

export interface RunContext {
  version: string
  packageCount: number // projects covered → the bar's "in run" half
  concurrency?: number // worker-pool size (info row)
  remoteCacheEnabled: boolean
  workspaceProjectCount?: number // total projects → the bar's denominator
}

// The footer section from counted stats — the live status region renders it as the run proceeds.
export function formatSummarySection(
  stats: SummaryStats,
  totalMs: number,
  colors?: ColorSupport,
  context?: RunContext,
): string[]

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors?: ColorSupport,
  context?: RunContext,
): string[]

// The `--verbosity 1` table (RunOptions.summaryTable): one row per real task, groups left out.
export function formatOutcomeTable(outcomes: readonly TaskOutcome[]): string[]

export function neverStarted(o: TaskOutcome): boolean
```

Nothing prints below the footer (owner, 2026-10-06): a task's own facts
ride its row. A skip is a row naming its blocker
(`formatTaskSkippedLine`), a flaky task a dim note on its row and frame
(`flakyNote`, framed-output.md). An aborted task is a row too
(`formatTaskAbortedLine`), and the tasks legend names it after the
total — `not counted: N aborted, N not run` — since `total` is the
count history and telemetry share. `aborted` is killed by a shutdown
signal; `not run` is reached by the stop before it ran. `neverStarted`
tells them apart: an aborted outcome with no `wallclockStartNs`, which
only a started task carries.

`formatRunSummary` returns an array of lines (caller writes one per
`log.status`). Leading blank line is included so the summary stands
apart from the last framed block. The live status region renders the
same section with the same context, filling in as the run proceeds, so
it becomes the final footer. When `context` is omitted the rule reads
a bare `vx` and the `projects` / `info` rows are skipped.

## Format

```
─ vx 0.0.0 ───────────────────────────────────────────────────
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱
            1 in run · 2 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            4 success · 4 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            4 miss

  info      10 workers · local cache
  time      248ms · max 239ms · avg 215ms · min 190ms
```

Labels pad to 8, bars start at column 12, the rule + bars span 50
cells. `projects` (the projects in the run vs the workspace total) leads the meter stack;
`tasks` and `cache` follow, the tasks legend carrying a dim `N total`.
A blank line separates the meters from the `info` row (worker pool +
cache mode, and `admit held N tasks · Ns` when a policy held any — a
sum, said as one) and the `time` row: the wall time, `<time> saved`
(green: the hits' STORED exec times summed, what the cache skipped,
never the restore this run paid; left out under 1 ms), the live
forecast (`~3s left`), then the dim `max / avg / min` spread over
executed tasks. The footer never says a fact twice (M, 2026-10-14):
no `result` row (it only repeated the tasks, cache and time rows), a
skipped count on the tasks legend alone (skips still ride the cache
bar), and a spread value equal to one already on the row is left out,
so one executed task, or tasks that all took the same time, show no
spread. `projects` and `info` only
render when a `RunContext` is passed (the live region and the final
footer both pass one). The block above is
`formatRunSummary` on four successes of 239, 190, 215 and 216 ms with
that context, pinned in `tests/summary.test.ts`.

Colors:

- `successful` is green.
- `failed` is bold red (only shown when N > 0).
- `skipped` is yellow (only shown when N > 0).

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
- Failed task ids are never listed — the count lives in the legend
  (the frames above carry the names; a run can fail hundreds).
- The run context folds into the footer (version on the rule, the
  info row, the projects bar); no context keeps a bare `vx` rule.
- Aborted and not-run tasks: named apart after the total on the tasks
  legend (under `0 tasks` too), a group in neither; their rows
  (`formatTaskAbortedLine`) byte for byte.
- Time row: blank line above, total, saved, then the dim 'max / avg / min' spread (executed tasks only; a repeated value left out).
- No value or count appears twice in a footer (`the footer never repeats a value or a count`).
- Duration formatting (sub-second vs second+).
- A flaky task's note: exact text for a pass that failed before, a
  failure that passed before, a retry with and without history; none
  for a task the run did not prove flaky; the row it rides, dim.
