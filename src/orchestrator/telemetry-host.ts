// Telemetry consultation — sibling to plugin-host.ts, for the observe-only
// `telemetry` capability. Asks each declared plugin for its sink(s),
// collects them, and (only if at least one exists) wires a TelemetrySource
// onto the run event bus.
//
// PERF INVARIANT: with zero registered sinks, NOTHING subscribes to the bus
// and the returned handle is a no-op — the hot path is byte-identical to a
// run with no telemetry plugin. A plugin that declines (returns undefined,
// e.g. otel() with no OTLP endpoint) contributes no sink, so it costs
// nothing. This is what keeps telemetry off the critical path entirely.
//
// See docs/design/observability-architecture-2026-06.md §1, §3.

import type { EventBus } from './events.js'
import type {
  RunContextRecord,
  RunSummaryRecord,
  TelemetryContext,
  TelemetrySink,
} from './telemetry.js'
import { createTelemetrySource } from './telemetry.js'
import type { VxPlugin } from './plugin.js'

/** A wired telemetry handle, present ONLY when at least one sink exists. */
export interface TelemetryHandle {
  /** Emit the per-run summary to every sink (crash-isolated). */
  emitSummary(summary: RunSummaryRecord): void
  /** Await every sink's flush (crash-isolated, time-bounded by the sink). */
  flush(): Promise<void>
  /** Remove the bus subscription. Idempotent. */
  dispose(): void
}

/**
 * Consult every plugin's `telemetry` capability, collect the sinks, and —
 * only if at least one sink results — create a TelemetrySource and subscribe
 * it to the bus. A plugin that throws during consultation is logged + skipped
 * (observability must never break a run). Returns `undefined` when no sink is
 * contributed, so the bus gains no subscriber AND the caller does zero
 * summary-building work — the no-telemetry hot path stays byte-identical.
 */
export async function subscribeTelemetry(
  plugins: readonly VxPlugin[],
  bus: EventBus,
  ctx: TelemetryContext,
  run: RunContextRecord,
): Promise<TelemetryHandle | undefined> {
  const sinks: TelemetrySink[] = []
  for (const plugin of plugins) {
    if (plugin.telemetry === undefined) continue
    let result
    try {
      result = await plugin.telemetry(ctx)
    } catch (err) {
      ctx.warn(
        `[vx] plugin '${plugin.name}' telemetry failed to initialize; disabled for this run: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    if (result === undefined) continue
    if (Array.isArray(result)) sinks.push(...result)
    else sinks.push(result)
  }

  if (sinks.length === 0) return undefined

  const source = createTelemetrySource({ sinks, run })
  const dispose = bus.subscribe(source.subscriber)
  let disposed = false
  return {
    emitSummary: (summary) => source.emitSummary(summary),
    flush: () => source.flush(),
    dispose() {
      if (disposed) return
      disposed = true
      dispose()
    },
  }
}
