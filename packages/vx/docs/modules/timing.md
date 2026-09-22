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

A span's total is WALL summed per call, and the calls run under the
scheduler's concurrency, so a span that overlaps other work reads far
larger than the work it names — `output dirs` at 124 µs a task is a
handful of `lstat`s. The table says so in its own footer now (items 254
and 407 both chased that number before measuring it in isolation);
compare spans to each other, and isolate a suspect one before acting.

## Marks and spans (current)

Marks, in the order a run ends them (`tests/module-shape-drift.test.ts`
pins this list to `prepare.ts` and `run.ts`, and the spans to every
`span(` call under `src/`):

- `startup`
- `workspace config`
- `discover projects`
- `package graph`
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
- `plan`

`plan` is a dry run's only: `planRun` ends it after `build graph`, and it
holds every task's hash, the cache lookups and the history p50s —
`--dry`'s whole answer, booked under `close` until item 601. It is listed
last because `planRun` follows `run` in the source, the order this list
keeps.

Spans, accumulated per call:

- `cache.get`
- `miss: build request`
- `miss: clean outputs`
- `miss: execute`
- `miss: resolve outputs`
- `miss: save`
- `miss: stamp outputs`
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
