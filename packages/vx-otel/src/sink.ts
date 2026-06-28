// The OTLP telemetry sink — accumulates a run's records into OTLP trace +
// metric payloads and ships them over HTTP/JSON. Observe-only: it implements
// core's TelemetrySink (records in, nothing out). Never-fail: every network
// error is swallowed, the POST is time-bounded, and the upload is idempotent —
// a down collector can never affect a run.

import { randomBytes } from 'node:crypto'
import type {
  RunContextRecord,
  RunSummaryRecord,
  TaskTelemetry,
  TelemetryRecord,
  TelemetrySink,
} from '@vzn/vx'
import {
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
  serviceName: string
  headers: Record<string, string>
  metricsEnabled: boolean
  timeoutMs: number
  post?: PostFn
  warn?: (message: string) => void
}

const defaultPost: PostFn = async (url, body, headers) => {
  await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(15_000) })
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
  // Traces + metrics only by default — never the large log chunks.
  readonly wants: ReadonlyArray<TelemetryRecord['kind']> = [
    'run.start',
    'task.start',
    'task.end',
    'run.end',
  ]

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

  constructor(config: OtelSinkConfig) {
    this.cfg = {
      tracesUrl: config.tracesUrl,
      metricsUrl: config.metricsUrl,
      serviceName: config.serviceName,
      headers: config.headers,
      metricsEnabled: config.metricsEnabled,
      timeoutMs: config.timeoutMs,
      post: config.post ?? defaultPost,
      ...(config.warn ? { warn: config.warn } : {}),
    }
  }

  onRecord(record: TelemetryRecord): void {
    switch (record.kind) {
      case 'run.start':
        this.traceId = genId(16)
        this.rootSpanId = genId(8)
        this.run = record.run
        this.rootStartNano = nanos(record.ts)
        return
      case 'task.start':
        this.taskSpanId.set(record.taskId, genId(8))
        this.taskStartNano.set(record.taskId, nanos(record.ts))
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
          attributes: taskSpanAttributes(t),
          status: { code: taskStatusCode(record.status) },
        })
        return
      }
      case 'run.end':
        this.rootEndNano = nanos(record.ts)
        return
      // task.log is excluded via `wants`; never reaches here.
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
      this.spans.unshift({
        traceId: this.traceId,
        spanId: this.rootSpanId,
        name: 'vx.run',
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: this.rootStartNano,
        endTimeUnixNano: this.rootEndNano !== '0' ? this.rootEndNano : this.rootStartNano,
        attributes: runSpanAttributes(this.run),
        status: { code: STATUS_UNSET },
      })
    }
    const vxVersion = this.run?.vxVersion ?? '0.0.0'
    await Promise.all([this.shipTraces(vxVersion), this.shipMetrics()])
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

  private async send(url: string, body: string): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.cfg.headers,
    }
    try {
      await this.cfg.post(url, body, headers)
    } catch (err) {
      // export is fully optional — a down collector never affects a run
      this.cfg.warn?.(
        `[vx-otel] export failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
