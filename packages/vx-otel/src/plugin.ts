// The `otel()` telemetry plugin. Contributes one observe-only telemetry sink
// that exports a vx run as OTLP traces + metrics. Zero-config via the standard
// OTel env vars; declines (returns undefined) when no endpoint is configured,
// so declaring `otel()` is safe in every environment.
//
// This replaces core's old hardcoded `attachOtelEmit` (logs-only, fired
// unconditionally when OTEL_EXPORTER_OTLP_ENDPOINT was set). OTel is now a
// plugin — declare it in vx.workspace.ts. The trade: the env var ALONE no
// longer auto-exports; you must `defineWorkspace({ plugins: [otel()] })`.

import type { TelemetryContext, TelemetrySink, VxPlugin } from '@vzn/vx'
import { OtelSink, type PostFn } from './sink.js'

export interface OtelPluginOptions {
  /** OTLP base endpoint. Falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  endpoint?: string
  /** Full traces URL override. Falls back to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else `<endpoint>/v1/traces`. */
  tracesEndpoint?: string
  /** Full metrics URL override. Falls back to `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, else `<endpoint>/v1/metrics`. */
  metricsEndpoint?: string
  /** Full logs URL override. Falls back to `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, else `<endpoint>/v1/logs`. */
  logsEndpoint?: string
  /** Service name. Falls back to `OTEL_SERVICE_NAME`, else `'vx'`. */
  serviceName?: string
  /** Extra OTLP headers, merged over `OTEL_EXPORTER_OTLP_HEADERS`. */
  headers?: Record<string, string>
  /** Emit run/task metrics in addition to traces. Default: true. */
  metrics?: boolean
  /**
   * Ship each executed task's captured output tail as an OTel log record.
   * Default: true — an endpoint is configured, so the intent is to export;
   * the same default the cloud sink applies once a connection resolves.
   * Set false (or `OTEL_LOGS_EXPORTER=none`) to export traces + metrics only.
   */
  logs?: boolean
  /** Per-request timeout (ms). Default: 15000. */
  timeoutMs?: number
  /** Test seam — inject the POST transport. Defaults to fetch. */
  post?: PostFn
}

/** Parse an `OTEL_EXPORTER_OTLP_HEADERS`-style `k=v,k=v` string. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function joinSignal(base: string, signal: string): string {
  return `${base.replace(/\/+$/, '')}/v1/${signal}`
}

/**
 * Resolve the export config from options + env. Returns undefined when no
 * endpoint is configured (the plugin then declines — zero-config safe).
 */
export function resolveOtelConfig(
  opts: OtelPluginOptions,
  env: Record<string, string | undefined>,
  warn?: (m: string) => void,
): ConstructorParameters<typeof OtelSink>[0] | undefined {
  const base = opts.endpoint ?? env['OTEL_EXPORTER_OTLP_ENDPOINT']
  const tracesUrl =
    opts.tracesEndpoint ??
    env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ??
    (base ? joinSignal(base, 'traces') : undefined)
  const metricsUrl =
    opts.metricsEndpoint ??
    env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] ??
    (base ? joinSignal(base, 'metrics') : undefined)
  const logsUrl =
    opts.logsEndpoint ??
    env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'] ??
    (base ? joinSignal(base, 'logs') : undefined)
  if (tracesUrl === undefined) return undefined
  // `OTEL_LOGS_EXPORTER=none` is the standard SDK opt-out; honour it so a
  // pipeline already configured that way does not start receiving build logs
  // just because it upgraded vx.
  const logsEnabled =
    opts.logs ??
    (env['OTEL_LOGS_EXPORTER']?.trim().toLowerCase() !== 'none' && logsUrl !== undefined)

  return {
    tracesUrl,
    metricsUrl: metricsUrl ?? tracesUrl,
    logsUrl: logsUrl ?? tracesUrl,
    serviceName: opts.serviceName ?? env['OTEL_SERVICE_NAME'] ?? 'vx',
    headers: { ...parseOtlpHeaders(env['OTEL_EXPORTER_OTLP_HEADERS']), ...opts.headers },
    metricsEnabled: opts.metrics ?? true,
    logsEnabled,
    timeoutMs: opts.timeoutMs ?? 15_000,
    ...(opts.post ? { post: opts.post } : {}),
    ...(warn ? { warn } : {}),
  }
}

/**
 * The OpenTelemetry exporter plugin. Declared in vx.workspace.ts via
 * `defineWorkspace({ plugins: [otel()] })`. Contributes a telemetry sink that
 * maps each run to OTLP traces (a `vx.run` root span + `vx.task` children),
 * metrics, and one log record per executed task, over OTLP/HTTP JSON.
 * Declines when no OTLP endpoint is set.
 */
export function otel(opts: OtelPluginOptions = {}): VxPlugin {
  return {
    name: 'vzn/otel',
    telemetry(ctx: TelemetryContext): TelemetrySink | undefined {
      const config = resolveOtelConfig(opts, process.env, (m) => ctx.warn(m))
      if (config === undefined) return undefined
      return new OtelSink(config)
    },
  }
}
