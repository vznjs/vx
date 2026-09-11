# `src/util/timing.ts` — `VX_TIMING` stage table

## Purpose

Answer "where did the warm run go?" without a profiler. With
`VX_TIMING=1`, `mark(label)` records the end of each stage
(`prepareRun`: startup, workspace config, discovery, cache open, config
load, git enumeration, build graph, plugin stages — the graph, key and
schedule hooks, so a plugin's cost is its own row; `run()`: classify +
probe, run graph, history, close) and `span(label)` accumulates repeated per-task
operations (`cache.get`, `output glob`, `output stat`, `task hash`).
`printTimings()` writes the table to stderr at the end of the run, and
at the end of a `--dry` run — a dry run is how the prepare stages get
profiled on a real repo with no install to run against.

## Invariants

- Off by default and free when off: `mark` is one boolean check;
  `span` returns a shared no-op so the hot path allocates nothing.
- Spans run under the scheduler's concurrency, so they over-count (a
  span's wall includes time yielded to other tasks). Compare spans to
  each other, never to the stage total — see `docs/benchmarks.md`
  § Profiling a run.

## Tests

Exercised by every `VX_TIMING` measurement in `docs/benchmarks.md`.
`tests/timing-dry.test.ts` pins the dry-run table (present through
`build graph` and `close` with the variable, absent without); the
table's shape is a developer tool, not a contract.
