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
- Percentiles are over the slice's executed-success rows; rates count
  every executed row.

## Tests

`tests/history.test.ts`, `tests/plan-predict.test.ts`,
`tests/run-record-completeness.test.ts`.
