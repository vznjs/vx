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
  STATUS_UNSET,
  taskSpanAttributes,
  taskStatusCode,
} from './otlp.js'

/** A POST function — injected in tests, defaults to fetch. Returns nothing;
 *  errors are the sink's to swallow. */
export type PostFn = (url: string, body: string, headers: Record<string, string>) => Promise<void>

export interface OtelSinkConfig {
  tracesUrl: string
  metricsUrl: string
  logsUrl: string
  serviceName: string
  headers: Record<string, string>
  metricsEnabled: boolean
  logsEnabled: boolean
  timeoutMs: number
  post?: PostFn
  warn?: (message: string) => void
}

const defaultPost: PostFn = async (url, body, headers) => {
  // Clearable timer, not AbortSignal.timeout: the latter's internal timer is
  // not unref'd and would keep a CLI process alive until it fires, well after
  // the POST resolved.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    await fetch(url, { method: 'POST', body, headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function genId(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/** ms → unix-nano decimal string (OTLP int64-as-string). */
function nanos(ms: number): string {
  return String(Math.trunc(ms) * 1_000_000)
}

export class OtelSink implements TelemetrySink {
  readonly name = 'vzn/otel'
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
  // Core's own bounded capture buffer — the same one the cloud sink uses, so
  // both agree on which task's output survives a chatty run.
  private readonly logs = new TaskLogBuffer()
  private runId = ''
  private runStartedAt = 0

  constructor(config: OtelSinkConfig) {
    this.cfg = {
      tracesUrl: config.tracesUrl,
      metricsUrl: config.metricsUrl,
      logsUrl: config.logsUrl,
      serviceName: config.serviceName,
      headers: config.headers,
      metricsEnabled: config.metricsEnabled,
      logsEnabled: config.logsEnabled,
      timeoutMs: config.timeoutMs,
      post: config.post ?? defaultPost,
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

  onRunSummary(summary: RunSummaryRecord): void {
    this.summary = summary
  }

  async flush(): Promise<void> {
    if (this.uploaded) return
    this.uploaded = true
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
        status: { code: STATUS_UNSET },
      })
    }
    const vxVersion = this.run?.vxVersion ?? '0.0.0'
    await Promise.all([this.shipTraces(vxVersion), this.shipMetrics(), this.shipLogs(vxVersion)])
  }

  private async shipTraces(vxVersion: string): Promise<void> {
    if (this.spans.length === 0) return
    const body = JSON.stringify(buildTraceRequest(this.cfg.serviceName, vxVersion, this.spans))
    await this.send(this.cfg.tracesUrl, body)
  }

  private async shipMetrics(): Promise<void> {
    if (!this.cfg.metricsEnabled || this.summary === undefined) return
    const body = JSON.stringify(
      buildMetricsRequest(this.cfg.serviceName, this.summary, nanos(this.summary.endedAt)),
    )
    await this.send(this.cfg.metricsUrl, body)
  }

  private async shipLogs(vxVersion: string): Promise<void> {
    if (!this.cfg.logsEnabled) return
    const workspaceId = this.run?.workspaceId ?? ''
    const bundle = this.logs.drain(this.runId, workspaceId)
    if (bundle.tasks.length === 0) return
    const body = JSON.stringify(
      buildLogsRequest({
        serviceName: this.cfg.serviceName,
        vxVersion,
        runId: this.runId,
        workspaceId,
        entries: bundle.tasks,
        timeUnixNano: nanos(this.summary?.endedAt ?? Date.now()),
        ...(this.traceId ? { traceId: this.traceId } : {}),
        spanIdFor: (taskId) => this.taskSpanId.get(taskId),
      }),
    )
    await this.send(this.cfg.logsUrl, body)
  }

  private async send(url: string, body: string): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.cfg.headers,
    }
    try {
      await this.cfg.post(url, body, headers)
    } catch (err) {
      // export is fully optional — a down collector never affects a run
      // Name the URL: three signals ship concurrently and each is caught
      // here on its own, so a bare "export failed" cannot tell a down
      // collector from one misconfigured signal endpoint.
      this.cfg.warn?.(
        `[vx-otel] export failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
