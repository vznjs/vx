# `src/orchestrator/history.ts` + `predict.ts` — predictive scheduling

## Purpose

`history.ts`: a per-run read-only `HistoryTable` snapshot (last N runs
per task pair via one SQL CTE over `cache.db.runs`), loaded at
`prepareRun`. `predict.ts`: pure functions turning that history into
expected-remaining-critical-path priorities the scheduler consumes via
its `priorities` override.

## Status

**Experimental, opt-in** via `defineWorkspace({ predictive: true })`.
Off by default; unbenchmarked against the baseline reverse-deps
heuristic — promote or remove after a real A/B (consulting-review
2026-07 roadmap item).

## Invariants

- Zero cost when off: no history query, scheduler keeps its static
  heuristic.
- Providers: `LocalHistoryProvider` (cache.db). Never mutated mid-run.
