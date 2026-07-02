# `src/orchestrator/telemetry.ts` — canonical telemetry export contract

## Purpose

THE versioned, serializable contract every telemetry consumer speaks
(`TELEMETRY_SCHEMA_VERSION = 1`). Exporters (otel, cloud ingest) receive
these records instead of re-deriving facts from the rendering-oriented
`WireEvent` stream — `cacheSource` is derived once, git/CI/host context
is pre-folded, bigint wallclock spans are decimal strings.

## Public surface

- `TelemetryRecord` — per-event union: `run.start` / `task.start` /
  `task.log` / `task.end` / `run.end`.
- `RunSummaryRecord` — one per run: `RunContextRecord` + totals +
  per-task `TaskTelemetry[]`. What the cloud plugin POSTs to
  `/v1/ingest`.
- `deriveCacheSource(status)` — `'local' | 'remote' | 'miss' | null`.
- `createTelemetrySource(bus, sinks, ctx)` — projects the bus once and
  fans out to sinks.

## Invariants

- **Observe-only by construction**: sinks receive immutable records and
  a read-only context — no bus, no Cache, no path back into scheduling.
- **Crash isolation**: a throwing sink is disabled for the run, never
  propagates.
- `task.log` is opt-in via `TelemetrySink.wants` (default excludes it).
- Version bumps are additive-or-bump: consumers reject unknown majors.
