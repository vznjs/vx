# `src/orchestrator/telemetry-host.ts` — telemetry capability consultation

## Purpose

Sibling of `plugin-host.ts` for the observe-only `telemetry` capability:
asks each declared plugin for its sink(s), and only if at least one
exists wires a `TelemetrySource` onto the run's event bus.

## Public surface

- `subscribeTelemetry(plugins, bus, ctx, runContext)` →
  `TelemetryHandle | undefined` (`emitSummary`, `flush`, `dispose`).

## Invariants

- **PERF INVARIANT**: zero registered sinks → returns `undefined`, no
  bus subscriber, no summary building — the hot path is byte-identical
  to a run with no telemetry plugin. A plugin that declines (e.g.
  `otel()` without an OTLP endpoint) costs nothing.
- Sink construction failures are isolated and warn; they never fail
  the run.
