// Type-only imports from @vzn/vx. `import type` is compile-time only —
// zero runtime coupling, no Bun workspace self-resolve required at
// type-check time. The bridge's runtime imports use the same package name;
// consumers install @vzn/vx as a peer dep.

import type { EventBus, RunEventSubscriber, WireEvent, OutcomeView } from '@vzn/vx'

export type { EventBus, RunEventSubscriber, WireEvent, OutcomeView }

export interface OtelBridgeOptions {
  /** OTLP/HTTP collector endpoint. Defaults to OTEL_EXPORTER_OTLP_ENDPOINT. */
  endpoint?: string
  /** Resource attribute `service.name`. Defaults to OTEL_SERVICE_NAME or 'vx'. */
  serviceName?: string
  /** Optional Authorization / x-honeycomb-team / etc. headers. */
  headers?: Record<string, string>
}

export interface OtelBridge {
  /** Subscribe to a vx bus; events fan into the OTLP exporter. */
  attach(bus: EventBus): () => void
  /** Flush pending records and close the exporter. */
  cleanup(): Promise<void>
}
