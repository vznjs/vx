# `src/orchestrator/telemetry-host.ts` — telemetry capability consultation

## Purpose

Sibling of `plugin-host.ts` for the observe-only `telemetry` capability:
asks each declared plugin for its sink(s), and only if at least one
exists wires a `TelemetrySource` onto the run's event bus.

## Public surface

```ts
export interface TelemetryHandle {
  emitSummary(summary: RunSummaryRecord): void // to every sink, crash-isolated
  flush(): Promise<void> // every sink's flush, crash-isolated, time-bounded by the sink
  dispose(): void // remove the bus subscription; idempotent
}

export async function subscribeTelemetry(
  plugins: readonly VxPlugin[],
  bus: EventBus,
  ctx: TelemetryContext,
  run: RunContextRecord,
  extraSinks?: readonly TelemetrySink[], // an embedder's own sinks, ahead of the plugins'
): Promise<TelemetryHandle | undefined>
```

A plugin's `telemetry` may return one sink or an array. Each is checked
before it is kept: an object, `wants` an array when present, and at
least one of `onRecord` / `onRunSummary` a function — anything else is
refused with the shape that arrived named. A plugin that throws during
consultation is logged and skipped.

## Invariants

- **PERF INVARIANT**: zero registered sinks → returns `undefined`, no
  bus subscriber, no summary building — the hot path is byte-identical
  to a run with no telemetry plugin. A plugin that declines (e.g.
  `otel()` without an OTLP endpoint) costs nothing.
- Sink construction failures are isolated and warn; they never fail
  the run.
