// The `otel()` telemetry plugin. Contributes one observe-only telemetry sink
// that exports a vx run as OTLP traces + metrics. Zero-config via the standard
// OTel env vars; declines (returns undefined) when no endpoint is configured,
// so declaring `otel()` is safe in every environment.
//
// This replaces core's old hardcoded `attachOtelEmit` (logs-only, fired
// unconditionally when OTEL_EXPORTER_OTLP_ENDPOINT was set). OTel is now a
// plugin — declare it in vx.workspace.ts. The trade: the env var ALONE no
// longer auto-exports; you must `defineWorkspace({ plugins: [otel()] })`.

import {
  refuseUnknownOptions,
  definePlugin,
  type TelemetryContext,
  type TelemetrySink,
  type VxPlugin,
} from '@vzn/vx'
import { readFileSync } from 'node:fs'
import { OtelSink, type OtlpTls, type PostFn } from './sink.js'

export interface OtelPluginOptions {
  /** OTLP base endpoint. Falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  endpoint?: string
  /** Full traces URL override. Falls back to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else `<endpoint>/v1/traces`. */
  tracesEndpoint?: string
  /** Full metrics URL override. Falls back to `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, else `<endpoint>/v1/metrics`. */
  metricsEndpoint?: string
  /** Full logs URL override. Falls back to `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, else `<endpoint>/v1/logs`. */
  logsEndpoint?: string
  /** Service name. Falls back to `OTEL_SERVICE_NAME`, then `OTEL_RESOURCE_ATTRIBUTES`' `service.name`, else `'vx'`. */
  serviceName?: string
  /** Extra OTLP headers, merged over `OTEL_EXPORTER_OTLP_HEADERS` and each signal's own. */
  headers?: Record<string, string>
  /** Emit run/task metrics in addition to traces. Default: true. */
  metrics?: boolean
  /**
   * Ship each executed task's captured output tail as an OTel log record.
   * Default: true — an endpoint is configured, so the intent is to export.
   * Set false (or `OTEL_LOGS_EXPORTER=none`) to export traces + metrics only.
   */
  logs?: boolean
  /** Per-request timeout (ms). Falls back to `OTEL_EXPORTER_OTLP_TIMEOUT`, else 15000. */
  timeoutMs?: number
  /**
   * `'gzip'` sends every signal gzipped. Falls back to each signal's
   * `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION`, then `OTEL_EXPORTER_OTLP_COMPRESSION`,
   * else `'none'`.
   */
  compression?: 'gzip' | 'none'
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

/** An HTTP header name: an RFC 7230 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** `OTEL_EXPORTER_OTLP_TIMEOUT`: milliseconds; anything but a positive number is unset. */
function envTimeout(raw: string | undefined): number | undefined {
  const ms = Number(present(raw))
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * `v1/<signal>` appended to the base URL's PATH, as the exporter spec says:
 * a base with a query had it glued onto the query's last value (F-49).
 */
function joinSignal(base: string, signal: string): string {
  if (URL.canParse(base)) {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/${signal}`
    return url.toString()
  }
  return `${base.replace(/\/+$/, '')}/v1/${signal}`
}

/**
 * `OTEL_RESOURCE_ATTRIBUTES`: `k=v,k=v`, percent-encoded. On a decoding
 * error the Resource SDK spec discards the whole variable; a malformed
 * escape was sent as written (F-49).
 */
function parseResourceAttributes(
  raw: string | undefined,
  warn: ((m: string) => void) | undefined,
): Record<string, string> {
  if (present(raw) === undefined) return {}
  const out: Record<string, string> = {}
  for (const pair of raw!.split(',')) {
    if (pair.trim() === '') continue
    const eq = pair.indexOf('=')
    try {
      if (eq <= 0) throw new Error('no key')
      const key = decodeURIComponent(pair.slice(0, eq).trim())
      if (key === '') throw new Error('no key')
      out[key] = decodeURIComponent(pair.slice(eq + 1).trim())
    } catch {
      warn?.(
        `[vx-otel] OTEL_RESOURCE_ATTRIBUTES is malformed (${pair.trim()}) — none of it is used`,
      )
      return {}
    }
  }
  return out
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
  // Each signal has its own endpoint, as the spec has them: a pipeline that
  // set only a metrics (or logs) endpoint declined whole and exported
  // nothing (F-45). The plugin declines only when no signal has one.
  if (tracesUrl === undefined && metricsUrl === undefined && logsUrl === undefined) {
    return undefined
  }
  // The standard SDK opt-outs, honoured so a pipeline already configured
  // that way does not start receiving vx's telemetry because it upgraded
  // vx. Only the logs one was read; `OTEL_SDK_DISABLED=true` and the traces
  // and metrics `=none` were ignored and still exported (item 1056).
  if (env['OTEL_SDK_DISABLED']?.trim().toLowerCase() === 'true') return undefined
  const off = (name: string): boolean => env[name]?.trim().toLowerCase() === 'none'
  const tracesWanted = !off('OTEL_TRACES_EXPORTER')
  const logsWanted = opts.logs ?? !off('OTEL_LOGS_EXPORTER')
  const metricsWanted = opts.metrics ?? !off('OTEL_METRICS_EXPORTER')
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
  // header's secret in the log (item 928). A NAME fetch refuses is refused
  // too, and never printed: a curl-style `Authorization: Basic …=` split at
  // its first `=` is a name holding the credential, and every export failed
  // quoting it (item 1056). Names are lower-cased so the later of two
  // spellings replaces the earlier, as the spec orders them: `Authorization`
  // and `authorization` were both sent, joined into one bad credential.
  const dropped = new Set<string>()
  let badName = false
  const clean = (h: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [raw, v] of Object.entries(h)) {
      if (!HEADER_NAME.test(raw)) {
        if (!badName) {
          badName = true
          warn?.(
            '[vx-otel] a header name holds a character no HTTP header name can carry (a space, a colon, …) — not sent (neither its name nor its value is printed)',
          )
        }
        continue
      }
      const k = raw.toLowerCase()
      const fault = headerValueFault(v)
      if (fault === null) out[k] = v
      else if (!dropped.has(k)) {
        dropped.add(k)
        warn?.(
          `[vx-otel] header ${JSON.stringify(raw)} holds ${fault}, which no HTTP header can carry — not sent (its value is not printed)`,
        )
      }
    }
    return out
  }
  // `OTEL_RESOURCE_ATTRIBUTES` (deployment.environment, team, …) was not
  // read, so a pipeline's resource identity never reached vx's telemetry.
  const resource = parseResourceAttributes(env['OTEL_RESOURCE_ATTRIBUTES'], warn)
  // vx speaks OTLP/HTTP JSON only; a signal the env sends over gRPC most
  // likely points at a gRPC port, and its failure warning says so.
  const grpc = (['traces', 'metrics', 'logs'] as const).filter(
    (signal) =>
      (
        present(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`]) ??
        env['OTEL_EXPORTER_OTLP_PROTOCOL']
      )
        ?.trim()
        .toLowerCase() === 'grpc',
  )
  // `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` was not read, and a pipeline
  // configured for it sent every export uncompressed (F-33).
  let badCompression = false
  const gzip = (['traces', 'metrics', 'logs'] as const).filter((signal) => {
    const name = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_COMPRESSION`
    const raw =
      opts.compression ?? present(env[name]) ?? present(env['OTEL_EXPORTER_OTLP_COMPRESSION'])
    const value = raw?.trim().toLowerCase()
    if (value === undefined || value === 'none') return false
    if (value === 'gzip') return true
    if (!badCompression) {
      badCompression = true
      warn?.(`[vx-otel] compression ${JSON.stringify(raw)} is not gzip or none — sent uncompressed`)
    }
    return false
  })
  // The spec's TLS files were not read: a collector behind a private CA
  // failed every export on its certificate, and one that asks for a client
  // certificate refused the connection (F-39). Each is a PEM file path; a
  // signal's own wins. Read once here; one that cannot be read warns once.
  const pem = new Map<string, string | undefined>()
  const read = (name: string, file: string): string | undefined => {
    if (!pem.has(file)) {
      try {
        pem.set(file, readFileSync(file, 'utf8'))
      } catch (err) {
        warn?.(
          `[vx-otel] ${name}: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)}) — not used`,
        )
        pem.set(file, undefined)
      }
    }
    return pem.get(file)
  }
  const timeoutMs = opts.timeoutMs ?? envTimeout(env['OTEL_EXPORTER_OTLP_TIMEOUT']) ?? 15_000
  const tls: Partial<Record<'traces' | 'metrics' | 'logs', OtlpTls>> = {}
  for (const signal of ['traces', 'metrics', 'logs'] as const) {
    const one: OtlpTls = {}
    for (const [field, suffix] of [
      ['ca', 'CERTIFICATE'],
      ['cert', 'CLIENT_CERTIFICATE'],
      ['key', 'CLIENT_KEY'],
    ] as const) {
      const own = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`
      const shared = `OTEL_EXPORTER_OTLP_${suffix}`
      const name = present(env[own]) !== undefined ? own : shared
      const file = present(env[name])
      const text = file === undefined ? undefined : read(name, file)
      if (text !== undefined) one[field] = text
    }
    if (Object.keys(one).length > 0) tls[signal] = one
  }
  return {
    tracesUrl: tracesUrl ?? '',
    metricsUrl: metricsUrl ?? '',
    logsUrl: logsUrl ?? '',
    serviceName:
      present(opts.serviceName) ??
      present(env['OTEL_SERVICE_NAME']) ??
      present(resource['service.name']) ??
      'vx',
    resource,
    grpc,
    gzip,
    ...(Object.keys(tls).length > 0 ? { tls } : {}),
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
    ...(tracesWanted && tracesUrl !== undefined ? {} : { tracesEnabled: false }),
    metricsEnabled: metricsWanted && metricsUrl !== undefined,
    logsEnabled: logsWanted && logsUrl !== undefined,
    timeoutMs,
    // A signal's own `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` wins over the
    // shared one; it was not read (F-49). The option tops both.
    signalTimeoutMs: {
      traces: opts.timeoutMs ?? envTimeout(env['OTEL_EXPORTER_OTLP_TRACES_TIMEOUT']) ?? timeoutMs,
      metrics: opts.timeoutMs ?? envTimeout(env['OTEL_EXPORTER_OTLP_METRICS_TIMEOUT']) ?? timeoutMs,
      logs: opts.timeoutMs ?? envTimeout(env['OTEL_EXPORTER_OTLP_LOGS_TIMEOUT']) ?? timeoutMs,
    },
    ...(opts.post ? { post: opts.post } : {}),
    ...(warn ? { warn } : {}),
  }
}

/** Every option `OtelPluginOptions` names: the type checker holds the two to each other. */
const OTEL_PLUGIN_KEYS: Record<keyof OtelPluginOptions, true> = {
  endpoint: true,
  tracesEndpoint: true,
  metricsEndpoint: true,
  logsEndpoint: true,
  serviceName: true,
  headers: true,
  metrics: true,
  logs: true,
  timeoutMs: true,
  compression: true,
  post: true,
}

/**
 * The OpenTelemetry exporter plugin. Declared in vx.workspace.ts via
 * `defineWorkspace({ plugins: [otel()] })`. Contributes a telemetry sink that
 * maps each run to OTLP traces (a `vx.run` root span + `vx.task` children),
 * metrics, and one log record per executed task, over OTLP/HTTP JSON.
 * Declines when no OTLP endpoint is set.
 */
export function otel(opts: OtelPluginOptions = {}): VxPlugin {
  refuseUnknownOptions('otel()', opts, Object.keys(OTEL_PLUGIN_KEYS))
  return definePlugin(import.meta, {
    telemetry(ctx: TelemetryContext): TelemetrySink | undefined {
      const config = resolveOtelConfig(opts, process.env, (m) => ctx.warn(m))
      if (config === undefined) return undefined
      return new OtelSink(config)
    },
  })
}
