// The `httpTelemetry()` plugin — POST canonical vx records to any HTTP
// endpoint. The generic "manual API" exporter: zero-config via VX_TELEMETRY_*
// env vars, declines when no URL is set. The contract it speaks (the canonical
// TelemetryRecord / RunSummaryRecord from @vzn/vx) is exactly what vx-cloud's
// ingest endpoint consumes, so this is also the building block a cloud plugin
// composes.

import type { TelemetryContext, TelemetrySink, VxPlugin } from '@vzn/vx'
import {
  HttpSink,
  type HttpSinkConfig,
  type PostFn,
  type TelemetryFormat,
  type TelemetryMode,
} from './sink.js'

export interface HttpTelemetryOptions {
  /** Endpoint to POST to. Falls back to `VX_TELEMETRY_URL`. */
  url?: string
  /** Bearer token. Falls back to `VX_TELEMETRY_TOKEN`. */
  token?: string
  /** `summary` (one RunSummaryRecord/run, default) or `stream` (batched records). */
  mode?: TelemetryMode
  /** Wire format. Default `ndjson`. */
  format?: TelemetryFormat
  /** stream mode: flush after this many buffered records. Default 100. */
  batchSize?: number
  /** stream mode: include the large task.log chunks. Default false. */
  includeLogs?: boolean
  /** Per-request timeout (ms). Default 5000. */
  timeoutMs?: number
  /** Test seam — inject the POST transport. Defaults to fetch. */
  post?: PostFn
}

/** Resolve the sink config from options + env. Undefined when no URL is set. */
export function resolveHttpConfig(
  opts: HttpTelemetryOptions,
  env: Record<string, string | undefined>,
  warn?: (m: string) => void,
): HttpSinkConfig | undefined {
  const url = opts.url ?? env['VX_TELEMETRY_URL']
  if (!url) return undefined
  const token = opts.token ?? env['VX_TELEMETRY_TOKEN']
  return {
    url,
    ...(token ? { token } : {}),
    mode: opts.mode ?? 'summary',
    format: opts.format ?? 'ndjson',
    batchSize: opts.batchSize ?? 100,
    includeLogs: opts.includeLogs ?? false,
    timeoutMs: opts.timeoutMs ?? 5000,
    ...(opts.post ? { post: opts.post } : {}),
    ...(warn ? { warn } : {}),
  }
}

/**
 * The manual-API telemetry plugin. Declared in vx.workspace.ts via
 * `defineWorkspace({ plugins: [httpTelemetry({ url })] })`. Contributes a
 * telemetry sink that POSTs the canonical records to `url`. Declines when no
 * URL is configured (zero-config safe).
 */
export function httpTelemetry(opts: HttpTelemetryOptions = {}): VxPlugin {
  return {
    name: 'vzn/http',
    telemetry(ctx: TelemetryContext): TelemetrySink | undefined {
      const config = resolveHttpConfig(opts, process.env, (m) => ctx.warn(m))
      if (config === undefined) return undefined
      return new HttpSink(config)
    },
  }
}
