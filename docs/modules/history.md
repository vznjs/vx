# `src/orchestrator/history.ts` — per-task duration history

## Purpose

A per-run, read-only `HistoryTable` snapshot: the last N recorded runs
per `(project, task)` pair, folded into one row each (p50 / p99 duration,
success rate, hit rate, failure mode) via one SQL CTE over
`cache.db.runs`.

## Who reads it

- `plan.ts` (`--dry` / `--graph`): attaches each would-run task's p50 and
  predicts the run's wall-clock. Explicit inspection commands, so the
  read's cost is fine there.
- Nothing on the default `vx run` path. The scheduler's `priorities`
  input is the seam a scheduling-policy plugin will feed; core no longer
  computes priorities from history (the opt-in `predictive` mode was
  removed 2026-09-02 — it cost ~280 ms of history loading on a large
  cache, more than a warm run).

## Invariants

- Zero cost on a plain run: no history query is issued.
- `LocalHistoryProvider(db, window)` never mutates; `EmptyHistoryProvider`
  is the no-history stand-in.
- The flakiness / failure-mode verdict comes from `classifyFailureMode`
  (`failure-mode.ts`), shared with the run-history queries in
  `metrics.ts`, so the two surfaces cannot disagree.
- Skipped rows (`status = 'skipped'`) are excluded from the window
  (`EXECUTED_RUNS_SQL`), so a run of skips cannot dilute the numbers.

## Tests

`tests/history.test.ts`, `tests/plan-predict.test.ts`,
`tests/run-record-completeness.test.ts`.
