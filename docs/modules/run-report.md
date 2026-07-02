# `src/orchestrator/run-report.ts` — markdown run report

## Purpose

`vx run --report=markdown`: a moon-style per-task table + totals line
written to stdout after the run, machine-clean for CI step summaries
(`vx run ci --report=markdown >> $GITHUB_STEP_SUMMARY`).

## Invariants

- Pure: outcomes in, markdown out. No ANSI, no live region.
- Zero cost when the flag is absent (CLI-side only).
