# `src/orchestrator/run-report.ts` — markdown run report

## Purpose

`vx run --report=markdown` / `--report-file=<path>`: a moon-style
per-task table + totals line rendered after the run, machine-clean for
CI step summaries (`vx run ci --report-file="$GITHUB_STEP_SUMMARY"`).

## Invariants

- Pure: outcomes in, markdown out. No ANSI, no live region.
- Zero cost when both flags are absent (CLI-side only).
- Machine-clean describes the STRING, not stdout — the status logger
  shares that stream, so `--report=markdown >> file` captures the whole
  run log as well. `--report-file` writes the report and nothing else,
  appending (a step summary is shared with other steps).
