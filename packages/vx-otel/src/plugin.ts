// The `otel()` telemetry plugin. Contributes one observe-only telemetry sink
// that exports a vx run as OTLP traces + metrics. Zero-config via the standard
// OTel env vars; declines (returns undefined) when no endpoint is configured,
// so declaring `otel()` is safe in every environment.
//
// This replaces core's old hardcoded `attachOtelEmit` (logs-only, fired
// unconditionally when OTEL_EXPORTER_OTLP_ENDPOINT was set). OTel is now a
// plugin — declare it in vx.workspace.ts. The trade: the env var ALONE no
// longer auto-exports; you must `defineWorkspace({ plugins: [otel()] })`.

import { definePlugin, type TelemetryContext, type TelemetrySink, type VxPlugin } from '@vzn/vx'
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
  /** Extra OTLP headers, merged over `OTEL_EXPORTER_OTLP_HEADERS` and each signal's own. */
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

/**
 * Parse an `OTEL_EXPORTER_OTLP_HEADERS`-style `k=v,k=v` string. The spec's
 * format is W3C Baggage's, so keys and values are percent-decoded:
 * `Authorization=Basic%20…`, as vendors document it, was sent literally and
 * every export was refused 401 (item 923). A malformed escape is kept as
 * written.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = decode(pair.slice(0, eq).trim())
    const value = decode(pair.slice(eq + 1).trim())
    if (key) out[key] = value
  }
  return out
}

/**
 * An EMPTY value is as absent as an unset one. A workflow writing
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ${{ secrets.X }}` with the secret unset
 * exports an empty string, and `??` does not fall through on it — so an empty
 * signal URL used to survive the `tracesUrl === undefined` guard and produce a
 * sink that POSTed to '' on every run. Whitespace-only counts too (a stray
 * newline from a shell here-doc). Every option and env read goes through this,
 * so they cannot disagree the way they did.
 */
function present(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === '' ? undefined : v
}

/**
 * Why a string cannot be an HTTP header value, or null. Bun's `fetch`
 * refuses a line break, a NUL or a character past Latin-1 once it has
 * trimmed the ends (measured on 1.4.2), and quotes the value in its error.
 */
function headerValueFault(value: string): string | null {
  let past = false
  for (const ch of value.trim()) {
    const c = ch.codePointAt(0)!
    if (c === 0x0a || c === 0x0d || c === 0) return 'a line break or NUL'
    if (c > 0xff) past = true
  }
  return past ? 'a character past Latin-1' : null
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
  const base = present(opts.endpoint) ?? present(env['OTEL_EXPORTER_OTLP_ENDPOINT'])
  const tracesUrl =
    present(opts.tracesEndpoint) ??
    present(env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) ??
    (base ? joinSignal(base, 'traces') : undefined)
  const metricsUrl =
    present(opts.metricsEndpoint) ??
    present(env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']) ??
    (base ? joinSignal(base, 'metrics') : undefined)
  const logsUrl =
    present(opts.logsEndpoint) ??
    present(env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT']) ??
    (base ? joinSignal(base, 'logs') : undefined)
  if (tracesUrl === undefined) return undefined
  // `OTEL_LOGS_EXPORTER=none` is the standard SDK opt-out; honour it so a
  // pipeline already configured that way does not start receiving build logs
  // just because it upgraded vx.
  const logsWanted = opts.logs ?? env['OTEL_LOGS_EXPORTER']?.trim().toLowerCase() !== 'none'
  const metricsWanted = opts.metrics ?? true
  // A signal ships only to its OWN url. With only a traces endpoint set, the
  // metrics payload used to go to the traces url — a request the collector
  // refuses on every run (item 807). A signal asked for by name and given no
  // url says so once instead.
  for (const [signal, asked, url] of [
    ['metrics', opts.metrics, metricsUrl],
    ['logs', opts.logs, logsUrl],
  ] as const) {
    if (asked === true && url === undefined) {
      warn?.(
        `[vx-otel] ${signal}: true but no ${signal} endpoint (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT) — ${signal} are not exported`,
      )
    }
  }

  // A header value fetch refuses is refused here, by name: fetch's error
  // quotes the whole value, and the export warning printed it — an auth
  // header's secret in the log (item 928).
  const dropped = new Set<string>()
  const clean = (h: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(h)) {
      const fault = headerValueFault(v)
      if (fault === null) out[k] = v
      else if (!dropped.has(k)) {
        dropped.add(k)
        warn?.(
          `[vx-otel] header ${JSON.stringify(k)} holds ${fault}, which no HTTP header can carry — not sent (its value is not printed)`,
        )
      }
    }
    return out
  }
  return {
    tracesUrl,
    metricsUrl: metricsUrl ?? tracesUrl,
    logsUrl: logsUrl ?? tracesUrl,
    serviceName: present(opts.serviceName) ?? present(env['OTEL_SERVICE_NAME']) ?? 'vx',
    headers: clean({ ...parseOtlpHeaders(env['OTEL_EXPORTER_OTLP_HEADERS']), ...opts.headers }),
    // A signal's own `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` wins over the
    // shared ones, as the spec orders them; they were not read (item 923).
    // The plugin's `headers` option stays on top of both.
    signalHeaders: {
      traces: clean({
        ...parseOtlpHeaders(env['OTEL_EXPORTER_OTLP_TRACES_HEADERS']),
        ...opts.headers,
      }),
      metrics: clean({
        ...parseOtlpHeaders(env['OTEL_EXPORTER_OTLP_METRICS_HEADERS']),
        ...opts.headers,
      }),
      logs: clean({ ...parseOtlpHeaders(env['OTEL_EXPORTER_OTLP_LOGS_HEADERS']), ...opts.headers }),
    },
    metricsEnabled: metricsWanted && metricsUrl !== undefined,
    logsEnabled: logsWanted && logsUrl !== undefined,
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
  return definePlugin(import.meta, {
    telemetry(ctx: TelemetryContext): TelemetrySink | undefined {
      const config = resolveOtelConfig(opts, process.env, (m) => ctx.warn(m))
      if (config === undefined) return undefined
      return new OtelSink(config)
    },
  })
}
