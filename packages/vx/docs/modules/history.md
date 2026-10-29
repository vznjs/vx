# `src/history/history.ts` — per-task duration history

## Purpose

A per-run, read-only `HistoryTable` snapshot: each `(project, task)`
pair's rows over the last N **invocations**, folded into one row each
(p50 / p99 duration, success rate, hit rate, failure mode) by one
aggregate over a rowid slice of `cache.db.runs`.

## Public surface

```ts
export interface TaskHistory {
  runs: number
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
  successRate: number
  hitRate: number
  failureMode: FailureMode
  maxPeakRssBytes?: number
  maxCpuParallelism?: number
  saturatedCores?: number // the most cores of a machine it filled (resourcesFor)
  saturatedMemoryBytes?: number // and the most memory
}
export type HistoryTable = ReadonlyMap<string, TaskHistory>
export type TaskResources = Pick<
  TaskHistory,
  | 'p50DurationMs'
  | 'maxPeakRssBytes'
  | 'maxCpuParallelism'
  | 'saturatedCores'
  | 'saturatedMemoryBytes'
>

export interface HistoryProvider {
  loadFor(taskIds: readonly string[]): Promise<HistoryTable>
  /** `loadFor`'s p50s alone; optional, a reader without it uses `loadFor`. */
  p50sFor?(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
}
export class EmptyHistoryProvider implements HistoryProvider {}

// failure-mode.ts, not history.ts:
/** A task whose SAME cache key failed after it had passed — the definition
 *  of flaky, answered from local history with no service. Named in a
 *  run's footer, listed by `vx info`. */
export interface FlakyTask {
  taskId: string
  project: string
  task: string
  keys: number // distinct keys that failed after a pass
  passes: number
  failures: number
}
export function flakyTasks(db: Database): FlakyTask[]
/** An executed, keyed outcome of the run in progress, what `detectFlaky` judges. */
export interface FlakyCandidate {
  project: string
  task: string
  hash: string
  status: 'success' | 'failed'
  attempts: number // > 1 is a within-run retry
}
/** One task the run just proved nondeterministic; `passes`/`failures` fold this run in. */
export interface FlakyFinding extends FlakyCandidate {
  taskId: string
  passes: number
  failures: number
}
// judged before the run's own rows are recorded; no candidate, no query
export function detectFlaky(db: Database, candidates: readonly FlakyCandidate[]): FlakyFinding[]

// history.ts again:
export const PASS_STATUSES: string // the pass set as SQL `(…)`, derived from `isPassStatus`
// What a plugin reads history through (the façade's only door to it): the
// provider below over `cache`'s index, typed so no handle leaves core.
export function localHistory(cache: Cache, options?: LocalHistoryOptions): LocalHistory
export interface LocalHistoryOptions {
  recent?: number // the window; default 50 invocations
  branch?: string | null // undefined: a forecast reads every branch
  defs?: ReadonlyMap<string, string> // `taskDefinitions`: rows of each task as it is now
}
// LocalHistory: HistoryProvider + resourcesFor, hasImported, importTimings.
// Core's own readers (`vx last`, `--dry`) build the provider on the handle.
export class LocalHistoryProvider implements HistoryProvider {
  // without branch a forecast reads every branch
  constructor(db: Database, recent?: number, branch?: string | null) // the window; defaults to 50 invocations
  /** `loadFor`'s p50 and resource maxima, without its rates. */
  resourcesFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, TaskResources>>
  /** The last forecast read found a task with no timing on this branch. */
  lackedBranchHistory: boolean
  hasImported(sha: string): boolean // rows of default-branch commit `sha` exist
  // one 'remote' row per task, with its measured need from `needs` (v45)
  importTimings(
    sha: string,
    timings: ReadonlyMap<string, number>,
    needs?: ReadonlyMap<string, TaskResources>,
  ): void
}
```

## The forecast

Every `p50DurationMs` (and `p50sFor`) is a forecast (2026-10-14):
the median of the task's last five timings on this run's branch, else
the default branch's newest imported timing, else the median of the last
five on any branch, else none. A timing from a crowded worker (`cpuShare`
< 1) is the time the task would take alone, so a plan does not carry the
crowd of the run it learned from. An import (`importTimings`, by
`@vzn/vx-history` from its history server) is rows tagged `remote` with
the commit, unique per (commit, task), so a repeat import from any worktree
adds nothing; a store with no import pays one probe of that partial
index, never a query per task. `resourcesFor` gives a task with no run
in its window the newest imported row's need, so a fresh machine packs
by what the default branch measured. Each tier is one statement over every
task still unanswered (`json_each`), an index probe per task inside
SQLite: 5-8 ms for 2,000 tasks, where a query per task was 31-40. The read learns whether some task lacked
a timing on its branch (`lackedBranchHistory`), so a caller deciding to
import asks no second question. The timings are
`task_durations` in the shared store (`schema.ts`), one row per executed
success appended in the run's history transaction and tagged
`branch:<name>` with the commit, so every worktree of the repo reads them
and a new one forecasts on its first run; `vx last` and the runs stay
per worktree. A read is a point lookup per task on `(project, task,
source, id)`, exact however old the rows. A run learns its branch once
(`run.branch` if set, else git's, else the CI provider's;
`PreparedRun.branch`, the schedule hook's `ctx.branch`;
`currentBranch` in `run-context.ts` for any other reader).
`p99DurationMs`, the rates and the resource maxima stay over the
window. `tests/history-forecast-branch.test.ts`.

A reader given the run's definitions (`taskDefinitions`, the fourth
argument) reads only the rows of each task as it is now. Every row
carries the task's definition: an xxh3 of its id, command and
`env.define` (`graph/definition.ts`). A task whose command or defines
changed under the same name starts over (2026-10-23); editing its
inputs, outputs, cache, sandbox grants, timeout, description or
dependencies keeps its history. An imported timing carries the
definition it was taken of (the blob's `defs`); a row of none (a blob
shared before definitions were kept) is read by every reader, or a PR's
first run would have read every task unmeasured. `tests/history-definition.test.ts`.

## Who reads it

- Every row's `usual` (running and finished, terminal and log) and the
  live region's end-of-run forecast (`p50sNow`), read once per run on
  the first row that asks: a run that executes nothing never reads it.

- `plan.ts` (`--dry`): attaches each would-run task's p50 and
  predicts the run's wall-clock, through `p50sFor` when the provider has
  it: the executed successes' durations alone, 4 ms against `loadFor`'s
  38 at 27,000 rows (its rates and per-hit entry join read every row).
- `@vzn/vx-history` (opt-in): the `schedule` stage's
  priorities and reservations, over a 20-invocation window by default,
  through `resourcesFor`: the executed successes grouped alone and the
  hits as distinct keys, each joined to its entry once. 148 ms against
  `loadFor`'s 407 at 168,000 rows (8,002 tasks), the same numbers
  (`tests/history-p50s.test.ts`). `vx history` reads `loadFor` (it shows
  runs).
- Nothing on the default `vx run` path.

## The window is a rowid slice

`runs` has no `(project, task)` index (it cost every run a scattered
B-tree write per task and bought this reader nothing; `caching.md`). Rows
are appended in time order, one contiguous block per invocation, so the
rows of the newest `recent` invocations are exactly `id >= MIN(id)` of
the newest `recent` `invocations` headers' rows (an index probe per
header; a run of only a group records a header and no row): a
primary-key range, no sort, plain aggregates. At most one row per pair per invocation, so the
slice IS the last `recent` runs for a pair that runs every time, and
whatever fewer it has for one that runs less often — a hint for ordering
and prediction, not a ledger (`vx why` / `vx last` read by `run_id` and
stay exact). Measured 2026-09-09 at 116k rows, 1,000 pairs, window 50:
550 ms for the ranked-per-pair query the index served → 50 ms.

## Invariants

- Zero cost on a plain run: no history query is issued.
- `LocalHistoryProvider(db, window)` (and `localHistory`) reads only; `importTimings` is its one write; `EmptyHistoryProvider`
  is the no-history stand-in.
- The flakiness / failure-mode verdict is `failureModeOf` over
  `mixedOutcomeKeysSql` (`failure-mode.ts`) — one rule, applied here over
  the window and by `mixedOutcomeKeyCount` over a task's whole history,
  so the two cannot disagree. The window's key-outcome pass runs only for
  pairs that failed without a retry already proving nondeterminism.
- `saturatedCores` / `saturatedMemoryBytes` (`resourcesFor` only): the
  most cores, and the most memory, of a machine an executor ran the task on
  (`placement_cores`, `placement_memory`) that it filled: 90% of the cores
  over its run on average (a burst to every core is not), or 90% of the
  memory. Failures count: a task killed for memory filled its machine. `@vzn/vx-dte` runs
  such a task on a bigger size next time.
- Skipped rows (`status = 'skipped'`) are excluded from the window
  (`EXECUTED_RUNS_SQL`), so a run of skips cannot dilute the numbers.
- `maxPeakRssBytes` is the maximum and `maxCpuParallelism` (cpu time over
  wall time over the CPU share) the mean over the window's successful
  executions (one crowded run's reading booked a build a whole Mac, main
  b5b83bb), plus — for hit rows —
  what the PRODUCING execution used, read from the hit's `entries` row
  (a primary-key join, hit rows only): the artifact's sidecar carries it,
  save and ingest index it, so a task this machine has only ever
  restored (a fresh runner behind a remote cache) still has a number.
  The entry keeps no CPU share, so a crowded producer's use reads low:
  a hit's `maxCpuParallelism` counts only for a task no execution here
  measured and (`resourcesFor`) no default-branch import names. A
  hit's own row says what the restore cost, never what the task needs; a
  failure's usage is not what the task needs to succeed; an entry pruned
  since contributes nothing. Absent when no row carried the number.
  `resourcesFor` times a task with no forecast by its hits' producers,
  the longest: a task made on a branch that main only restores has no
  timing of its own anywhere.
  `@vzn/vx-history` turns them into the reservations its
  `admit` hook packs (`docs/design/resource-estimates-2026-09.md`).

## The per-run surfaces (`failure-mode.ts`)

The same rule, applied at the end of every run and by the doctor:

- `detectFlaky(db, candidates)` — each a `FlakyCandidate`
  (`{ project, task, hash, status, attempts }`): the run's executed, keyed,
  cache-declaring outcomes (`run.ts` builds the list; a hit, a skip, a
  group or a task with no `cache` block is not one), judged BEFORE the
  run's own rows land. A failure on a key that passed before, a pass on
  a key that already failed after a pass, or a within-run retry is a
  `FlakyFinding` (a first pass after only failures is a recovery)
  with the key's outcome counts, this run folded in. `run.ts` judges each
  task as it finishes, so its row carries the note (`flakyNote`).
- Both read the shared store's flaky record, `task_outcomes` (v38), not
  this workspace's `runs`: every worktree of a repo judges a key on what
  all of them saw. It keeps every executed outcome that names its key and
  a key's first hit; a later hit replays a pass on record and adds none.
- `flakyTasks(db)` — every task with a key that failed after a pass in the whole
  retained history, most failures first: the `vx info` row. A pass that
  took a retry is one `success` row; its failed attempts count as
  failures, so it counts on its own.
- Cost follows the run's colour. No candidate: no query. A green miss:
  one probe of `task_outcomes_hash` (a key holds a handful of rows),
  which answers "did this key ever fail?" in microseconds at any history
  size. Only a key that did fail before, or a task failing now, pays the
  projection over its own keys. Recording a warm run's hits costs one
  probe of the same index, ~1 ms per 1,000 (2026-10-15). Judged one task at a time
  as each finishes (2026-10-06, so the row carries it): 1,000 green
  misses cost 3.0 ms in all against 0.4 batched, spread over the run
  beside 1,000 spawns.
- Every reader is a filter over one projection, `keyOutcomesSql`, so
  the definition of "mixed" cannot fork between the window, the
  all-time count, the run's findings and the doctor's list.
- Percentiles are over the slice's executed-success rows; rates count
  every executed row. A hit is a success in `successRate` (the pass
  statuses, from `isPassStatus`).

## Tests

`tests/history.test.ts`, `tests/plan-predict.test.ts`,
`tests/run-record-completeness.test.ts`; `tests/failure-mode.test.ts`
(the rule, `detectFlaky`, `flakyTasks`, the partial index's plan and
its creation on an older database); `tests/flaky.test.ts` (end to end:
footer, `vx last`, `vx info`, with a hit and a changed-key break as
controls).
