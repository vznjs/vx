# `src/util/timing.ts` — `VX_TIMING` stage table

## Purpose

Answer "where did the warm run go?" without a profiler. With
`VX_TIMING` set to anything but the empty string, `mark(label)` records
the end of each stage — `prepareRun`'s seven, then `run()`'s, the
first of which is marked as `prepareRun` returns and holds the graph,
key and schedule hooks, so a plugin's cost is its own row — and
`span(label)` accumulates the repeated per-task operations: the probe,
the restore, the miss and the save, each split into its steps. The
labels are listed below. `printTimings()` writes the table to stderr
at the end of the run, and at the end of a `--dry` run — a dry run is
how the prepare stages get profiled on a real repo with no install to
run against.

## Marks and spans (current)

Marks, in the order a run ends them (`tests/module-shape-drift.test.ts`
pins this list to `prepare.ts` and `run.ts`, and the spans to every
`span(` call under `src/`):

- `startup`
- `workspace config`
- `discover projects`
- `open cache`
- `load configs`
- `git enumeration`
- `build graph`
- `plugin stages`
- `classify + probe`
- `run graph`
- `record history`
- `save lane`
- `output dir snapshots`
- `close`

Spans, accumulated per call:

- `cache.get`
- `miss: build request`
- `miss: clean outputs`
- `miss: execute`
- `miss: resolve outputs`
- `miss: save`
- `output dirs`
- `output glob`
- `output rows`
- `output stat`
- `probe`
- `restore: exists`
- `restore: extract`
- `restore: rows`
- `save: index tx`
- `save: pack`
- `save: rename`
- `save: scan`
- `save: write temp`
- `stable keys`
- `task hash`

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
