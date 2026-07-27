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

/** Reject anything that is not sink-shaped, naming what arrived. */
function checkSink(sink: unknown): TelemetrySink {
  if (typeof sink !== 'object' || sink === null) {
    throw new Error(`telemetry sink must be an object, got ${sink === null ? 'null' : typeof sink}`)
  }
  const wants = (sink as TelemetrySink).wants
  if (wants !== undefined && !Array.isArray(wants)) {
    throw new Error(`telemetry sink 'wants' must be an array, got ${typeof wants}`)
  }
  return sink as TelemetrySink
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
  extraSinks?: readonly TelemetrySink[],
): Promise<TelemetryHandle | undefined> {
  const sinks: TelemetrySink[] = extraSinks === undefined ? [] : [...extraSinks]
  for (const plugin of plugins) {
    if (plugin.telemetry === undefined) continue
    // A plugin's return value is user input, so it is checked here rather
    // than trusted downstream: `createTelemetrySource` reads `.wants` off
    // every sink immediately, so one `null` in the list used to abort the
    // whole run with a raw TypeError before a single task had run. Staging
    // into `accepted` keeps a partly-bad array all-or-nothing, and the shape
    // check sits INSIDE the try so a throwing `wants` getter is caught too.
    let accepted: TelemetrySink[]
    try {
      const result = await plugin.telemetry(ctx)
      const list = result === undefined ? [] : Array.isArray(result) ? result : [result]
      accepted = list.map((sink) => checkSink(sink))
    } catch (err) {
      ctx.warn(
        `[vx] plugin '${plugin.name}' telemetry failed to initialize; disabled for this run: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    sinks.push(...accepted)
  }

  if (sinks.length === 0) return undefined

  const source = createTelemetrySource({ sinks, run, warn: (m) => ctx.warn(m) })
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
