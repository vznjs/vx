// Public API for @vzn/vx-http — the manual-API telemetry exporter for vx.
//
// Usage in vx.workspace.ts:
//   import { defineWorkspace } from '@vzn/vx'
//   import { httpTelemetry } from '@vzn/vx-http'
//   export default defineWorkspace({
//     plugins: [httpTelemetry({ url: 'https://my-collector/ingest' })],
//   })
//
// POSTs the canonical TelemetryRecord / RunSummaryRecord contract. Zero-config
// via VX_TELEMETRY_URL / VX_TELEMETRY_TOKEN; declines when no URL is set.

export { httpTelemetry, resolveHttpConfig, type HttpTelemetryOptions } from './plugin.js'
export {
  HttpSink,
  type HttpSinkConfig,
  type PostFn,
  type TelemetryFormat,
  type TelemetryMode,
} from './sink.js'
