# `src/orchestrator/history.ts` — per-task duration history

## Purpose

A per-run, read-only `HistoryTable` snapshot: each `(project, task)`
pair's rows over the last N **invocations**, folded into one row each
(p50 / p99 duration, success rate, hit rate, failure mode) by one
aggregate over a rowid slice of `cache.db.runs`.

## Who reads it

- `plan.ts` (`--dry` / `--graph`): attaches each would-run task's p50 and
  predicts the run's wall-clock. Explicit inspection commands, so the
  read's cost is fine there.
- `@vzn/vx-schedule-history` (opt-in): the `schedule` stage's
  priorities, over a 20-invocation window by default.
- Nothing on the default `vx run` path.

## The window is a rowid slice

`runs` has no `(project, task)` index (it cost every run a scattered
B-tree write per task and bought this reader nothing; `caching.md`). Rows
are appended in time order, one contiguous block per invocation, so the
rows of the newest `recent` invocations are exactly `id >= MIN(id)` of
the `recent`-th newest `invocations` header: a primary-key range, no
sort, plain aggregates. At most one row per pair per invocation, so the
slice IS the last `recent` runs for a pair that runs every time, and
whatever fewer it has for one that runs less often — a hint for ordering
and prediction, not a ledger (`vx why` / `vx last` read by `run_id` and
stay exact). Measured 2026-09-09 at 116k rows, 1,000 pairs, window 50:
550 ms for the ranked-per-pair query the index served → 50 ms.

## Invariants

- Zero cost on a plain run: no history query is issued.
- `LocalHistoryProvider(db, window)` never mutates; `EmptyHistoryProvider`
  is the no-history stand-in.
- The flakiness / failure-mode verdict is `failureModeOf` over
  `mixedOutcomeKeysSql` (`failure-mode.ts`) — one rule, applied here over
  the window and by `mixedOutcomeKeyCount` over a task's whole history,
  so the two cannot disagree. The window's key-outcome pass runs only for
  pairs that failed without a retry already proving nondeterminism.
- Skipped rows (`status = 'skipped'`) are excluded from the window
  (`EXECUTED_RUNS_SQL`), so a run of skips cannot dilute the numbers.

## The per-run surfaces (`failure-mode.ts`)

The same rule, applied at the end of every run and by the doctor:

- `detectFlaky(db, candidates)` — the run's executed, keyed,
  cache-declaring outcomes (`run.ts` builds the list; a hit, a skip, a
  group or a task with no `cache` block is not one), judged BEFORE the
  run's own rows land. A pass on a key that failed before, a failure on
  a key that passed before, or a within-run retry is a `FlakyFinding`
  with the key's outcome counts, this run folded in. The footer prints
  them (`formatFlakySection`) and `--summarize` types them (`flaky`).
- `flakyTasks(db)` — every task with a mixed-outcome key in the whole
  retained history, most failures first: the `vx info` row.
- Cost follows the run's colour. No candidate: no query. A green miss:
  one probe of `runs_failed`, a PARTIAL index over failed rows (the
  rare ones, so a green run's 1,000 inserts only evaluate its
  predicate: 3.2 ms per 1,000 with and without it), which answers "did
  this key ever fail?" in microseconds at any history size. Only a key
  that did fail before, or a task failing now, pays the projection scan
  over its own keys (~10 ms at 170k rows). Measured 2026-09-10, 170k
  rows: 1 / 12 / 1,000 green candidates 0.01 / 0.02 / 0.55 ms with the
  index against 10.4 / 10.3 / 21.6 ms scanning.
- Every reader is a filter over one projection, `keyOutcomesSql`, so
  the definition of "mixed" cannot fork between the window, the
  all-time count, the run's findings and the doctor's list.
- Percentiles are over the slice's executed-success rows; rates count
  every executed row.

## Tests

`tests/history.test.ts`, `tests/plan-predict.test.ts`,
`tests/run-record-completeness.test.ts`; `tests/failure-mode.test.ts`
(the rule, `detectFlaky`, `flakyTasks`, the partial index's plan and
its creation on an older database); `tests/flaky.test.ts` (end to end:
footer, `--summarize`, `vx info`, with a hit and a changed-key break as
controls).
