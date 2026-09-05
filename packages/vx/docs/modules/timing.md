# `src/util/timing.ts` — `VX_TIMING` stage table

## Purpose

Answer "where did the warm run go?" without a profiler. With
`VX_TIMING=1`, `mark(label)` records the end of each stage
(`prepareRun`: startup, workspace config, discovery, cache open, config
load, git enumeration; `run()`: graph, classify + probe, run graph,
history, close) and `span(label)` accumulates repeated per-task
operations (`cache.get`, `output glob`, `output stat`, `task hash`).
`printTimings()` writes the table to stderr at the end of the run.

## Invariants

- Off by default and free when off: `mark` is one boolean check;
  `span` returns a shared no-op so the hot path allocates nothing.
- Spans run under the scheduler's concurrency, so they over-count (a
  span's wall includes time yielded to other tasks). Compare spans to
  each other, never to the stage total — see `docs/benchmarks.md`
  § Profiling a run.

## Tests

Exercised by every `VX_TIMING` measurement in `docs/benchmarks.md`; no
unit test of its own — the table is a developer tool, not a contract.
