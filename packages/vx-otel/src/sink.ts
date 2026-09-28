// The OTLP telemetry sink — accumulates a run's records into OTLP trace +
// metric payloads and ships them over HTTP/JSON. Observe-only: it implements
// core's TelemetrySink (records in, nothing out). Never-fail: every network
// error is swallowed, the POST is time-bounded, and the upload is idempotent —
// a down collector can never affect a run.

import { randomBytes } from 'node:crypto'
import { TaskLogBuffer } from '@vzn/vx'
import type {
  RunContextRecord,
  RunSummaryRecord,
  TaskTelemetry,
  TelemetryRecord,
  TelemetrySink,
} from '@vzn/vx'
import {
  buildLogsRequest,
  buildMetricsRequest,
  buildTraceRequest,
  type OtlpSpan,
  runSpanAttributes,
  SPAN_KIND_INTERNAL,
  runStatusCode,
  taskSpanAttributes,
  taskStatusCode,
} from './otlp.js'

/** A POST function — injected in tests, defaults to fetch. Returns nothing;
 *  errors are the sink's to swallow. */
export type PostFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  tls?: OtlpTls,
) => Promise<void>

/** PEM text from `OTEL_EXPORTER_OTLP_*CERTIFICATE` / `*CLIENT_KEY`, as fetch takes it. */
export interface OtlpTls {
  ca?: string
  cert?: string
  key?: string
}

export type OtelSignal = 'traces' | 'metrics' | 'logs'

export interface OtelSinkConfig {
  tracesUrl: string
  metricsUrl: string
  logsUrl: string
  serviceName: string
  /** `OTEL_RESOURCE_ATTRIBUTES`, under vx's own service identity. */
  resource?: Readonly<Record<string, string>>
  /** Signals the env asks to export over gRPC, which vx does not speak. */
  grpc?: readonly OtelSignal[]
  headers: Record<string, string>
  /** Per signal, over `headers`. */
  signalHeaders?: Partial<Record<OtelSignal, Record<string, string>>>
  /** Signals sent gzipped (`OTEL_EXPORTER_OTLP_COMPRESSION=gzip`). */
  gzip?: readonly OtelSignal[]
  /** Per signal: a collector's CA, and a client certificate for mutual TLS. */
  tls?: Partial<Record<OtelSignal, OtlpTls>>
  /** False under `OTEL_TRACES_EXPORTER=none`; absent is true. */
  tracesEnabled?: boolean
  metricsEnabled: boolean
  logsEnabled: boolean
  timeoutMs: number
  /** Per signal, over `timeoutMs` (`OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT`). */
  signalTimeoutMs?: Partial<Record<OtelSignal, number>>
  post?: PostFn
  warn?: (message: string) => void
}

const defaultPost =
  (timeoutMs: number): PostFn =>
  async (url, json, headers, deadline, tls) => {
    // Compressed once, not per attempt; the header says the sink asked.
    const body = headers['content-encoding'] === 'gzip' ? Bun.gzipSync(json) : json
    // A collector that sheds load (429, 502, 503, 504, or a reset
    // connection) is retried twice, as the OTLP spec asks of exporters: the
    // export was dropped whole on the first 503 (F-28). The flush deadline
    // still bounds it all.
    for (let attempt = 0; ; attempt++) {
      try {
        return await postOnce(url, body, headers, timeoutMs, deadline, tls)
      } catch (err) {
        const retry = err instanceof OtlpRetryable ? err.afterMs : undefined
        const delay = RETRY_DELAYS_MS[attempt]
        if (retry === undefined || delay === undefined || deadline?.aborted === true) {
          throw err instanceof OtlpRetryable ? err.refused : err
        }
        // The deadline ended the wait: core has given up on the flush, and
        // the refusal is what to tell (F-46).
        if (await sleepUnless(retry > 0 ? Math.min(retry, MAX_RETRY_AFTER_MS) : delay, deadline)) {
          throw err instanceof OtlpRetryable ? err.refused : err
        }
      }
    }
  }

/** fetch refused the server's certificate (untrusted, expired, wrong name). */
function isCertificateRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return (
    typeof code === 'string' &&
    (code.includes('CERT') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  )
}

const RETRY_DELAYS_MS = [200, 800] as const
const MAX_RETRY_AFTER_MS = 2000
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

/** A failure worth another attempt; `afterMs` is the collector's Retry-After, or 0. */
class OtlpRetryable extends Error {
  constructor(
    readonly refused: Error,
    readonly afterMs: number,
  ) {
    super(refused.message)
  }
}

/** Resolves true when `deadline` ended the wait. */
function sleepUnless(ms: number, deadline: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      deadline?.removeEventListener('abort', done)
      resolve(deadline?.aborted === true)
    }
    const timer = setTimeout(done, ms)
    deadline?.addEventListener('abort', done, { once: true })
  })
}

// Takes the CONFIGURED timeout. It used to abort on a literal 15 s while
// `timeoutMs` was resolved, defaulted and stored and then read by nobody, so
// `otel({ timeoutMs: 1000 })` waited fifteen seconds on a hanging collector
// (2026-09-19). Clearable timer, not AbortSignal.timeout: the latter's
// internal timer is not unref'd and would keep a CLI process alive until it
// fires, well after the POST resolved.
async function postOnce(
  url: string,
  body: string | Uint8Array,
  headers: Record<string, string>,
  timeoutMs: number,
  deadline: AbortSignal | undefined,
  tls: OtlpTls | undefined,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // Core's flush deadline ends the POST too: `timeoutMs` (15 s by
  // default) alone held the process that long after the run (item 1055).
  const onDeadline = (): void => controller.abort()
  deadline?.addEventListener('abort', onDeadline, { once: true })
  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        body,
        headers,
        signal: controller.signal,
        ...(tls === undefined ? {} : { tls }),
      })
    } catch (err) {
      // A connection that failed is worth a retry; one this side aborted is
      // not, nor a certificate this side refused: it fails the same way each
      // time, and the retries spent a second of the flush on it (F-40).
      if (controller.signal.aborted) throw err
      if (isCertificateRefusal(err)) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} — for a collector behind a private CA, set OTEL_EXPORTER_OTLP_CERTIFICATE to its CA's PEM file`,
        )
      }
      throw new OtlpRetryable(err instanceof Error ? err : new Error(String(err)), 0)
    }
    // A collector that REFUSES the export still ANSWERS: only one that
    // cannot be reached throws. Until this read the status, a 401 from a
    // wrong token, a 404 from a wrong path and a 500 from a wedged
    // collector each exported nothing and said nothing, for every run
    // (walked the adopter's path, 2026-09-20). The body is the
    // collector's own explanation, so a line of it rides the message.
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      const refused = new Error(`HTTP ${res.status}${detail(text)}`)
      if (!RETRYABLE_STATUS.has(res.status)) throw refused
      const after = Number(res.headers.get('retry-after'))
      throw new OtlpRetryable(refused, Number.isFinite(after) && after > 0 ? after * 1000 : 0)
    }
    // OTLP's other silent loss: a 200 whose body says part of the export
    // was dropped (over quota, past a limit). Success at the transport,
    // missing data in the collector.
    const rejected = partialSuccess(text)
    if (rejected !== undefined) throw new Error(rejected)
  } finally {
    clearTimeout(timer)
    deadline?.removeEventListener('abort', onDeadline)
  }
}

/** One line of a collector's error body, bounded — it is remote text. */
function detail(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim()
  return line === '' ? '' : `: ${line.slice(0, 200)}`
}

/**
 * The OTLP `partialSuccess` shape, when it says something was dropped: the
 * rejected counts are int64-as-string, and a response with the field present
 * but everything zero is a plain success (the spec's own example).
 */
function partialSuccess(body: string): string | undefined {
  if (!body.includes('partialSuccess')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const ps = (parsed as { partialSuccess?: Record<string, unknown> })?.partialSuccess
  if (ps === undefined || ps === null) return undefined
  const counts = (['rejectedSpans', 'rejectedDataPoints', 'rejectedLogRecords'] as const)
    .map((k) => [k, Number(ps[k] ?? 0)] as const)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
  const message = typeof ps['errorMessage'] === 'string' ? ps['errorMessage'].trim() : ''
  if (counts.length === 0 && message === '') return undefined
  const what = counts.map(([k, n]) => `${n} ${k.replace('rejected', '').toLowerCase()}`).join(', ')
  return `the collector dropped part of the export: ${what === '' ? 'some of it' : what}${detail(message)}`
}

function genId(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/** ms → unix-nano decimal string (OTLP int64-as-string). */
function nanos(ms: number): string {
  return String(Math.trunc(ms) * 1_000_000)
}

export class OtelSink implements TelemetrySink {
  readonly name = '@vzn/vx-otel'
  /**
   * Which record kinds this sink takes. `task.log` is included ONLY when the
   * logs signal is on: core checks this before it projects a chunk at all, so
   * a logs-off exporter costs a run exactly nothing on the output path.
   */
  readonly wants: ReadonlyArray<TelemetryRecord['kind']>

  private readonly cfg: Required<Omit<OtelSinkConfig, 'warn'>> & { warn?: (m: string) => void }
  private traceId = ''
  private rootSpanId = ''
  private run: RunContextRecord | undefined
  private rootStartNano = '0'
  private rootEndNano = '0'
  private readonly spans: OtlpSpan[] = []
  private readonly taskSpanId = new Map<string, string>()
  private readonly taskStartNano = new Map<string, string>()
  private summary: RunSummaryRecord | undefined
  private uploaded = false
  // Core's own bounded capture buffer, so which task's output survives a
  // chatty run is core's rule, not this sink's.
  private readonly logs = new TaskLogBuffer()
  private runId = ''
  private runStartedAt = 0
  private readonly injected: boolean

  constructor(config: OtelSinkConfig) {
    this.injected = config.post !== undefined
    this.cfg = {
      tracesUrl: config.tracesUrl,
      metricsUrl: config.metricsUrl,
      logsUrl: config.logsUrl,
      serviceName: config.serviceName,
      resource: config.resource ?? {},
      grpc: config.grpc ?? [],
      gzip: config.gzip ?? [],
      tls: config.tls ?? {},
      headers: config.headers,
      signalHeaders: config.signalHeaders ?? {},
      tracesEnabled: config.tracesEnabled !== false,
      metricsEnabled: config.metricsEnabled,
      logsEnabled: config.logsEnabled,
      timeoutMs: config.timeoutMs,
      signalTimeoutMs: config.signalTimeoutMs ?? {},
      post: config.post ?? defaultPost(config.timeoutMs),
      ...(config.warn ? { warn: config.warn } : {}),
    }
    this.wants = config.logsEnabled
      ? ['run.start', 'task.start', 'task.log', 'task.end', 'run.end']
      : ['run.start', 'task.start', 'task.end', 'run.end']
  }

  onRecord(record: TelemetryRecord): void {
    switch (record.kind) {
      case 'run.start':
        this.traceId = genId(16)
        this.rootSpanId = genId(8)
        this.run = record.run
        this.runId = record.run.runId
        // The run's OWN canonical start, not when this record was projected —
        // it is what the summary reports and what a receiver stores.
        this.rootStartNano = nanos(record.startedAt)
        this.runStartedAt = record.startedAt
        return
      case 'task.start':
        this.taskSpanId.set(record.taskId, genId(8))
        this.taskStartNano.set(record.taskId, nanos(record.ts))
        return
      case 'task.log':
        this.logs.append(record.taskId, record.chunk)
        return
      case 'task.end': {
        const spanId = this.taskSpanId.get(record.taskId) ?? genId(8)
        const startNano =
          this.taskStartNano.get(record.taskId) ?? nanos(record.ts - record.durationMs)
        const t: TaskTelemetry = record
        this.spans.push({
          traceId: this.traceId,
          spanId,
          ...(this.rootSpanId ? { parentSpanId: this.rootSpanId } : {}),
          name: 'vx.task',
          kind: SPAN_KIND_INTERNAL,
          startTimeUnixNano: startNano,
          endTimeUnixNano: nanos(record.ts),
          attributes: taskSpanAttributes(t, {
            runId: this.runId,
            workspaceId: this.run?.workspaceId ?? '',
            startedAt: this.runStartedAt,
          }),
          status: { code: taskStatusCode(t) },
        })
        // Decides retention: a cache hit's bytes belong to the run that
        // executed them, so only an executed success/failure keeps a tail.
        if (this.cfg.logsEnabled) {
          this.logs.finish(record.taskId, record.status, record.cacheSource, record.hash)
        }
        return
      }
      case 'run.end':
        this.rootEndNano = nanos(record.ts)
        return
    }
  }

  /** Core's flush deadline, passed to every POST. */
  private deadline: AbortSignal | undefined

  onRunSummary(summary: RunSummaryRecord): void {
    this.summary = summary
  }

  async flush(signal?: AbortSignal): Promise<void> {
    if (this.uploaded) return
    this.uploaded = true
    this.deadline = signal
    // Finalize the root span now that the run is over (run.end set the end).
    if (this.run !== undefined && this.traceId) {
      // Prefer the summary's own start/end: they are the run's canonical
      // timing, and a receiver rebuilding the invocation header must agree
      // with the native ingest path to the millisecond.
      const start = this.summary !== undefined ? nanos(this.summary.startedAt) : this.rootStartNano
      const end =
        this.summary !== undefined
          ? nanos(this.summary.endedAt)
          : this.rootEndNano !== '0'
            ? this.rootEndNano
            : this.rootStartNano
      this.spans.unshift({
        traceId: this.traceId,
        spanId: this.rootSpanId,
        name: 'vx.run',
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: start,
        endTimeUnixNano: end,
        attributes: runSpanAttributes(this.run, this.summary),
        status: { code: runStatusCode(this.summary) },
      })
    }
    const vxVersion = this.run?.vxVersion ?? '0.0.0'
    await Promise.all([this.shipTraces(vxVersion), this.shipMetrics(), this.shipLogs(vxVersion)])
  }

  private async shipTraces(vxVersion: string): Promise<void> {
    if (this.cfg.tracesEnabled === false || this.spans.length === 0) return
    const bodies = requestBodies(this.spans, (spans) =>
      JSON.stringify(buildTraceRequest(this.cfg.serviceName, vxVersion, spans, this.cfg.resource)),
    )
    await this.send('traces', this.cfg.tracesUrl, bodies)
  }

  private async shipMetrics(): Promise<void> {
    if (!this.cfg.metricsEnabled || this.summary === undefined) return
    const body = JSON.stringify(
      buildMetricsRequest(
        this.cfg.serviceName,
        this.summary,
        nanos(this.summary.endedAt),
        nanos(this.summary.startedAt),
        this.cfg.resource,
      ),
    )
    await this.send('metrics', this.cfg.metricsUrl, [body])
  }

  private async shipLogs(vxVersion: string): Promise<void> {
    if (!this.cfg.logsEnabled) return
    const workspaceId = this.run?.workspaceId ?? ''
    const bundle = this.logs.drain(this.runId, workspaceId)
    if (bundle.tasks.length === 0) return
    const bodies = requestBodies(bundle.tasks, (entries) =>
      JSON.stringify(
        buildLogsRequest({
          serviceName: this.cfg.serviceName,
          resource: this.cfg.resource,
          vxVersion,
          runId: this.runId,
          workspaceId,
          entries,
          timeUnixNano: nanos(this.summary?.endedAt ?? Date.now()),
          // Traces off: the trace and its spans are never exported, and a
          // record naming them links nowhere (F-49).
          ...(this.cfg.tracesEnabled && this.traceId
            ? { traceId: this.traceId, spanIdFor: (taskId) => this.taskSpanId.get(taskId) }
            : {}),
        }),
      ),
    )
    await this.send('logs', this.cfg.logsUrl, bodies)
  }

  /** The transport, under the signal's own timeout when it has one (F-49). */
  private postFor(signal: OtelSignal): PostFn {
    const own = this.cfg.signalTimeoutMs[signal]
    return own === undefined || this.injected ? this.cfg.post : defaultPost(own)
  }

  /** POSTs every body at once; one warning per signal, however many fail. */
  private async send(signal: OtelSignal, url: string, bodies: readonly string[]): Promise<void> {
    const gzip = this.cfg.gzip.includes(signal)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.cfg.headers,
      ...this.cfg.signalHeaders[signal],
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    }
    const failed = (
      await Promise.all(
        bodies.map((body) =>
          // Through a promise, so a transport that throws before it awaits is caught too.
          Promise.resolve()
            .then(() =>
              this.postFor(signal)(url, body, headers, this.deadline, this.cfg.tls[signal]),
            )
            .then(
              () => undefined,
              (err: unknown) => (err instanceof Error ? err.message : String(err)),
            ),
        ),
      )
    ).filter((m) => m !== undefined)
    // export is fully optional — a down collector never affects a run
    if (failed.length === 0) return
    // Name the URL: three signals ship concurrently and each is caught
    // here on its own, so a bare "export failed" cannot tell a down
    // collector from one misconfigured signal endpoint.
    // An HTTP POST to a gRPC port fails with a transport error that
    // names neither; the env that asked for gRPC is the likely cause.
    const hint = this.cfg.grpc.includes(signal)
      ? ` — the env asks for OTLP over gRPC, and vx sends OTLP/HTTP JSON only: point it at the collector's HTTP endpoint (port 4318)`
      : ''
    const share = bodies.length > 1 ? ` (${failed.length} of ${bodies.length} requests)` : ''
    this.cfg.warn?.(`[vx-otel] export failed for ${shownUrl(url)}: ${failed[0]}${share}${hint}`)
  }
}

/**
 * Items per OTLP request. A run's spans went in ONE request, and 20 000 tasks
 * made 23 MiB, past a collector's 20 MiB default: `request body too large`,
 * the whole trace lost (F-22). 1 000 spans is ~1.2 MiB; the SDKs batch 512.
 */
const ITEMS_PER_REQUEST = 1000

/**
 * Bytes per OTLP request. A count bounds spans, not log tails: the run's log
 * budget counts characters, and JSON writes a control character as six bytes
 * (`\u0001`), so 64 tails of control bytes made one 23 MiB logs request
 * (F-23). A body past this is split in half until it fits or is one item.
 */
const BYTES_PER_REQUEST = 4 * 1024 * 1024

/** `items` as request bodies, each at most ITEMS_PER_REQUEST items and BYTES_PER_REQUEST bytes. */
function requestBodies<T>(items: readonly T[], encode: (group: T[]) => string): string[] {
  const out: string[] = []
  const add = (group: T[]): void => {
    const body = encode(group)
    if (group.length > 1 && Buffer.byteLength(body) > BYTES_PER_REQUEST) {
      const half = Math.ceil(group.length / 2)
      add(group.slice(0, half))
      add(group.slice(half))
    } else out.push(body)
  }
  for (let i = 0; i < items.length; i += ITEMS_PER_REQUEST) {
    add(items.slice(i, i + ITEMS_PER_REQUEST))
  }
  return out
}

/**
 * `url` as a warning may print it: a credential in its userinfo or query
 * (`https://user:token@…`, `…?api-key=…`) is replaced, so a refused export
 * does not put the secret in a CI log. Headers were redacted by item 928;
 * the URL was not.
 */
function shownUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return '(an unparsable URL)'
  }
  if (u.username !== '') u.username = '***'
  if (u.password !== '') u.password = '***'
  if (u.search !== '') u.search = '?***'
  return u.href
}
