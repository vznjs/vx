// Public API for @vzn/vx-otel — the OpenTelemetry exporter plugin for vx.
//
// Usage in vx.workspace.ts:
//   import { defineWorkspace } from '@vzn/vx'
//   import { otel } from '@vzn/vx-otel'
//   export default defineWorkspace({ plugins: [otel()] })
//
// Zero-config via the standard OTel env vars (OTEL_EXPORTER_OTLP_ENDPOINT,
// OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_HEADERS). Maps a run to OTLP traces +
// metrics + per-task logs over HTTP/JSON — no OpenTelemetry SDK dependency.

export { otel, type OtelPluginOptions } from './plugin.js'
export {
  buildLogsRequest,
  buildMetricsRequest,
  buildTraceRequest,
  resourceAttributes,
  runSpanAttributes,
  SEMCONV,
  taskSpanAttributes,
  taskStatusCode,
  VX_ATTR,
  type KeyValue,
  type OtlpLogRecord,
  type OtlpSpan,
} from './otlp.js'
