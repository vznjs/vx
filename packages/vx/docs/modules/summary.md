# `src/report/summary.ts` — end-of-run summary lines

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
  running?: number // live: running now (not in the final summary)
  scheduled?: number // live: handed to an executor whose machine has not begun them
  blocked?: number // live: not started because a dependency has not finished
  total: number
  upToDate: number
  restoredLocal: number
  restoredRemote: number
  saved?: number // ran here and saved: the legend's `↑`
  notSaved?: number // ran here with a `cache` block, succeeded, saved nothing
  miss: number
  noCache?: number // a task no cache answered for (`ranNoCache`) never consulted one
  left?: number // still to run: the live section's gray remainder; 0 in the final summary
  spread: { maxMs: number; minMs: number; sumMs: number; count: number } | null // the time row's per-task spread
  held?: { count: number; sumMs: number } // what an `admit` policy held, summed
  etaMs?: number // live section only: the forecast of what is left (`~3s left` on the time row)
  overMs?: number // live section only: how long the run has gone past that forecast (`+3s over`)
  emptyGroups?: readonly string[] // a run of command-less groups: their names, after `0 tasks`
  buckets?: ReadonlyMap<string, CacheBucket> // each finished task's cache bucket by its key
}

// The cache bar segment a finished task fills before its remote traffic is weighed.
export type CacheBucket =
  'miss' | 'noCache' | 'upToDate' | 'restoredLocal' | 'restoredRemote' | 'saved'
// A finished task's own bucket; none for a group, a skip or an abort.
export function cacheBucketOf(o: TaskOutcome): CacheBucket | undefined

export interface RunContext {
  version: string
  packageCount: number // projects with a task to run → the bar's "affected" half
  runId?: string | undefined // the whole id `vx last` takes (info row)
  executorRows?: () => readonly (readonly [string, ui.Inline])[] // executors' footer rows
  whereRunning?: (taskId: string) => string | undefined // a running task's executor
  concurrency?: number // worker-pool size (info row)
  remoteCacheEnabled: boolean
  cacheScope?: string | undefined // the run's scope (info row: `scope vznjs/vx:feat-x`)
  cache?: {
    local: boolean
    localWrite: boolean
    remote: boolean
    traffic: {
      readonly inFlight: number // uploads queued or running
      readonly keys: ReadonlyMap<string, { uploading: number; failures: readonly string[] }>
    } // `Cache.traffic`, a live ref: each key's uploads and remote failures
    downloads?: { readonly bytes: number } // `Cache.downloads`: what the remote hits pulled
    uploads?: { readonly bytes: number } // `Cache.uploads`: what the landed uploads pushed
    notDownloaded: () => number
  } // the layers the run used: the legend's `local 1✓ 1∅ 2↓ 1↑ · remote 3↓ 12 MB 4↑ 2.1 MB 2✗ 1⇡`
  workspaceProjectCount?: number // total projects → the bar's denominator
  warnings?: () => readonly string[] // the run's warnings → the footer's `warn` row
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
export function formatOutcomeTable(
  outcomes: readonly TaskOutcome[],
  colors?: ColorSupport,
): string[]

export function neverStarted(o: TaskOutcome): boolean
```

Nothing prints below the footer (2026-10-06): a task's own facts
ride its row. A skip is a row naming its blocker
(`formatTaskSkippedLine`), a flaky task a dim note on its row and frame
(`flakyNote`, framed-output.md). An aborted task is a row too
(`formatTaskAbortedLine`), and the tasks legend counts it in the
total, each state its own bar segment: `2 success · 1 aborted · 1 not
run · 4 total` (2026-10-14; history and telemetry still record only
the tasks that ran). A total is always the last word on its line.
`aborted` is killed by a shutdown
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
            1 affected · 2 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            4 success · 4 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 4↑

  info      10 workers · local cache · run 01a14941-c8cf-7a3e-9b51-2f06d4e8c713
  time      248ms · max 239ms · avg 215ms · min 190ms
```

Labels pad to 8, bars start at column 12, the rule + bars span 50
cells. `projects` (the projects in the run vs the workspace total) leads the meter stack;
`tasks` and `cache` follow, the tasks legend carrying a dim `N total`.
An executor's own rows (`TaskExecutor.footer`, such as `@vzn/vx-dte`'s
`agents`) come next, live and at the end, under a blank line; with them
the `info` row names no worker pool. A blank line separates the meters
from the `info` row (worker pool +
cache mode: the layers the run's policy uses, `local + remote cache`,
`local cache`, `remote cache` or `no cache`; `admit held N tasks · Ns` when a policy held any — a
sum, said as one — and `run <id>`, the run's whole id as
`vx last <id>` takes it, live from the run's start; the footer of a run
a signal stopped names none, as such a run records nothing) and the `time` row: the wall time, the live
forecast (`~3s left`), then the dim `max / avg / min` spread over
executed tasks. The footer never says a fact twice (2026-10-14):
no `result` row (it only repeated the tasks, cache and time rows), a
skipped count on the tasks legend alone (skips still ride the cache
bar), and a spread value equal to one already on the row is left out,
so one executed task, or tasks that all took the same time, show no
spread. `projects` and `info` only
render when a `RunContext` is passed (the live region and the final
footer both pass one). The block above is
`formatRunSummary` on four successes of 239, 190, 215 and 216 ms with
that context, pinned in `tests/summary.test.ts`.

### The cache bar: one segment per state, each task once

With a `RunContext.cache`, the cache bar has a segment per legend state
and each task fills one (2026-10-15), in bar order: miss (ran, saved
nothing; red), `∅` no cache (dim), `✓` fresh (green), local `↓` and
`↑` (local blue), remote `↓` and `↑` (remote dark blue), `⇡` uploading
(cyan), `✗` a remote read or write failed (red), skipped (yellow), and
the live gray remainder. A task counts under its strongest state:
`✗`, then `⇡`, then remote `↑`, then local `↑`, then its own (`↓`,
`✓`, `∅` or miss). The task's own bucket is `cacheBucketOf`; its remote
state is its key's entry in `traffic.keys` (failures, then uploads
running, then one landed), which moves it. A task still running is
counted once it ends. The legend's numbers are the segments', each in
its segment's colour, number and glyph alike; the `local` and `remote`
words are dim (2026-10-15).
A state that shares a colour gets no new one: `↓` and `↑` of a layer
are its colour. Under `NO_COLOR` the glyphs carry the meaning. An empty
segment paints nothing. With no run context, the plain legend's
buckets stand (`3 miss · 1 no-cache · …`; a saved task is a miss there).

`⇡` is live only: the final footer prints after the run's drain, when
none is running. A run that ends with uploads still running keeps the
region, footer only, until `traffic.inFlight` reaches 0 (the logger's
`draining`, logger.md); the drain the run already does is the wait.

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
- Stacked state meters (50 cells, fewer on a terminal narrower than the 62-column footer so bars and rule fit its width; largest-remainder allocation, every non-zero bucket gets >= 1 cell): tasks bar = failed/success/skipped, cache bar = a segment per legend state (`the bar has a segment per state, each legend count painted in its colour`); color-coded legends below each bar.
- The cache legend per layer: each task once, `✗` over `⇡` over `↑`, a task still running not counted (`the cache legend reads per layer`).
- Gradient wordmark rule (violet -> pink across the dashes).
- Failed task ids are never listed — the count lives in the legend
  (the frames above carry the names; a run can fail hundreds).
- The run context folds into the footer (version on the rule, the
  info row, the projects bar); no context keeps a bare `vx` rule.
- Aborted and not-run tasks: counted in the tasks total, each its own
  bar segment, a group in neither; a total is last on its line; their rows
  (`formatTaskAbortedLine`) byte for byte.
- Time row: blank line above, total, then the dim 'max / avg / min' spread (executed tasks only; a repeated value left out).
- No value or count appears twice in a footer (`the footer never repeats a value or a count`).
- Duration formatting (sub-second vs second+).
- A flaky task's note: exact text for a pass that failed before, a
  failure that passed before, a retry with and without history; none
  for a task the run did not prove flaky; the row it rides, dim.
