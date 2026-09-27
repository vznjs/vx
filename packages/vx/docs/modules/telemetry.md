# `src/orchestrator/telemetry.ts` — canonical telemetry export contract

## Purpose

THE versioned, serializable contract every telemetry consumer speaks
(`TELEMETRY_SCHEMA_VERSION = 3`). Exporters (otel, a custom sink) receive
these records instead of re-deriving facts from the rendering-oriented
`WireEvent` stream — `cacheSource` is derived once, git/CI/host context
is pre-folded, bigint wallclock spans are decimal strings.

## Public surface

- `TelemetryRecord` — per-event union: `run.start` / `task.start` /
  `task.log` / `task.end` / `run.end`.
- `RunSummaryRecord` — one per run: `RunContextRecord` + totals +
  per-task `TaskTelemetry[]`. What every telemetry sink receives at
  end of run. `abortedCount` (v3, item 851) counts the tasks a
  shutdown signal or an embedder's abort killed; they are not in the
  task list, which holds real runs only, so without it a stopped run
  read as a failure with nothing failed.
- `deriveCacheSource(status)` — the `CacheSource`: `'local'` / `'remote'`
  for the two hits, `'miss'` for `success` / `failed`, `'none'` for
  `skipped` / `aborted`; never null.
- `taskTelemetryOf(outcome)` — the one projection of a `TaskOutcome` into
  `TaskTelemetry`, used by the streaming `task.end` record and the
  summary's `tasks[]` alike, so the two cannot drift (item 660).
- `createTelemetrySource({ sinks, run, warn?, owners? })` → a
  `TelemetrySource` — projects the bus once and fans out to sinks. `run`
  is the `RunContextRecord` stamped on `run.start`; `owners` names a
  nameless sink by its plugin.
- `TelemetrySink` — what a `telemetry` plugin returns: an optional
  `name`, a `wants` list of record kinds (the source checks it BEFORE
  projecting, so a sink pays nothing for kinds it declines), and
  `onRecord` / `onRunSummary` / `flush`. Every one is crash-isolated and
  `flush` is deadline-bounded. A warning names the sink by its `name`,
  else by its plugin's (`org/p`, or `org/p #2` for the second of a
  list), else by its place in the source's list (`#2`; item 1027).
- `TelemetryContext` — what the hook is handed: `workspaceRoot`,
  `cacheDir` (a STRING, not a Cache handle — a sink cannot reach the
  cache) and `warn`.
- `TelemetrySource` — the live projection: a bus `subscriber`,
  `emitSummary` and `flush`.
- `CacheSource` — `'miss' | 'local' | 'remote' | 'none'`, the cache axis
  every record carries.
- `TASK_STATUSES`, `isPassStatus(status)`, `isCacheHit(status)` — the
  task axis and the two predicates every surface shares.
- `TELEMETRY_SCHEMA_VERSION` — bumped when a record's shape changes, so a
  receiver can refuse what it cannot read.

## Invariants

- **Observe-only by construction**: sinks receive immutable records and
  a read-only context — no bus, no Cache, no path back into scheduling.
- **Crash isolation**: a throwing sink is disabled for the run, never
  propagates.
- `task.log` is opt-in via `TelemetrySink.wants` (default excludes it).
- Version bumps are additive-or-bump: consumers reject unknown majors.
