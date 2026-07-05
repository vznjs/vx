// OTLP/HTTP JSON payload builders — pure functions, no SDK.
//
// vx-otel speaks the OTLP/HTTP JSON protocol directly rather than pulling the
// OpenTelemetry SDK closure. The protocol is a stable wire spec; building the
// payloads by hand keeps the package zero-dependency, fully testable, and free
// of SDK-version drift. Maps a vx run to:
//   - a TRACE: one root `vx.run` span + one child `vx.task` span per task,
//     with CI/CD + VCS semantic-convention attributes;
//   - METRICS: task/run counters + a run-duration gauge.
//
// References: OpenTelemetry CI/CD + VCS semantic conventions; OTLP/JSON
// protobuf-JSON mapping (int64 fields are decimal STRINGS).

import type { RunContextRecord, RunSummaryRecord, TaskTelemetry } from '@vzn/vx'

// --- OTLP value + attribute primitives ---------------------------------

export type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | { doubleValue: number }

export interface KeyValue {
  key: string
  value: AnyValue
}

export function strAttr(key: string, v: string): KeyValue {
  return { key, value: { stringValue: v } }
}
export function intAttr(key: string, v: number): KeyValue {
  return { key, value: { intValue: String(Math.trunc(v)) } }
}
export function boolAttr(key: string, v: boolean): KeyValue {
  return { key, value: { boolValue: v } }
}
export function doubleAttr(key: string, v: number): KeyValue {
  return { key, value: { doubleValue: v } }
}

// --- semantic-convention keys ------------------------------------------

export const SEMCONV = {
  pipelineRunId: 'cicd.pipeline.run.id',
  taskName: 'cicd.pipeline.task.name',
  taskRunResult: 'cicd.pipeline.task.run.result',
  vcsHeadRevision: 'vcs.ref.head.revision',
  vcsHeadName: 'vcs.ref.head.name',
  serviceName: 'service.name',
  serviceVersion: 'service.version',
} as const

// OTLP status codes: 0 UNSET, 1 OK, 2 ERROR. Span kind: 1 INTERNAL.
export const STATUS_UNSET = 0
export const STATUS_ERROR = 2
export const SPAN_KIND_INTERNAL = 1
// Metric aggregation temporality: 2 = CUMULATIVE.
export const AGG_CUMULATIVE = 2

export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: KeyValue[]
  status: { code: number }
}

// --- attribute mapping (pure) ------------------------------------------

/** Resource attributes — service identity. Run/VCS context rides span attrs. */
export function resourceAttributes(serviceName: string, vxVersion: string): KeyValue[] {
  return [strAttr(SEMCONV.serviceName, serviceName), strAttr(SEMCONV.serviceVersion, vxVersion)]
}

/** Attributes for the root `vx.run` span. */
export function runSpanAttributes(run: RunContextRecord): KeyValue[] {
  const attrs: KeyValue[] = [
    strAttr(SEMCONV.pipelineRunId, run.runId),
    strAttr('vx.command', run.command),
    strAttr('vx.requested_tasks', run.requestedTasks.join(',')),
    strAttr('vx.cache_policy', run.cachePolicy),
    intAttr('vx.concurrency', run.concurrency),
    boolAttr('vx.ci', run.ci),
    strAttr('vx.os', run.os),
    strAttr('vx.arch', run.arch),
    strAttr('vx.version', run.vxVersion),
  ]
  if (run.flow !== null) attrs.push(strAttr('vx.flow', run.flow))
  if (run.commitSha !== null) attrs.push(strAttr(SEMCONV.vcsHeadRevision, run.commitSha))
  if (run.branch !== null) attrs.push(strAttr(SEMCONV.vcsHeadName, run.branch))
  if (run.dirty !== null) attrs.push(boolAttr('vx.dirty', run.dirty))
  if (run.ciProvider !== null) attrs.push(strAttr('vx.ci.provider', run.ciProvider))
  if (run.host !== null) attrs.push(strAttr('vx.host', run.host))
  for (const [k, v] of Object.entries(run.tags)) attrs.push(strAttr(`vx.tag.${k}`, v))
  return attrs
}

/** Attributes for a child `vx.task` span. */
export function taskSpanAttributes(t: TaskTelemetry): KeyValue[] {
  const attrs: KeyValue[] = [
    strAttr(SEMCONV.taskName, t.taskId),
    strAttr(SEMCONV.taskRunResult, t.status),
    strAttr('vx.task.project', t.project),
    strAttr('vx.task.task', t.task),
    strAttr('vx.cache.source', t.cacheSource),
    intAttr('vx.task.exit_code', t.exitCode),
    intAttr('vx.task.duration_ms', t.durationMs),
  ]
  if (t.hash !== undefined) attrs.push(strAttr('vx.task.hash', t.hash))
  if (t.cpuMs !== undefined) attrs.push(intAttr('vx.cpu_ms', t.cpuMs))
  if (t.peakRssBytes !== undefined) attrs.push(intAttr('vx.peak_rss_bytes', t.peakRssBytes))
  if (t.attempts !== undefined) attrs.push(intAttr('vx.task.attempts', t.attempts))
  // Cache-correctness verdict from `--verify` — the hermeticity signal. A
  // `nondeterministic` verdict means the task's cache entry is unsound; it
  // maps to span status ERROR (see taskStatusCode) so it surfaces as a failed
  // span in the tracing backend even though the task itself exited 0.
  if (t.verify !== undefined) {
    attrs.push(strAttr('vx.task.verify', t.verify.kind))
    if (t.verify.kind === 'nondeterministic' || t.verify.kind === 'allowed-nondeterministic') {
      attrs.push(strAttr('vx.task.verify.changed', t.verify.changed.join(',')))
    }
  }
  return attrs
}

/** A failed task maps to span status ERROR; so does a task whose `--verify`
 *  verdict proved it non-hermetic (nondeterministic / rerun-failed) — even
 *  though it exited 0, its cache entry is unsound. Everything else stays UNSET. */
export function taskStatusCode(t: TaskTelemetry): number {
  if (t.status === 'failed') return STATUS_ERROR
  if (t.verify?.kind === 'nondeterministic' || t.verify?.kind === 'rerun-failed') {
    return STATUS_ERROR
  }
  return STATUS_UNSET
}

// --- envelope builders -------------------------------------------------

/** Wrap spans in an ExportTraceServiceRequest. */
export function buildTraceRequest(
  serviceName: string,
  vxVersion: string,
  spans: OtlpSpan[],
): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(serviceName, vxVersion) },
        scopeSpans: [{ scope: { name: 'vx', version: vxVersion }, spans }],
      },
    ],
  }
}

/** Build an ExportMetricsServiceRequest from a run summary. */
export function buildMetricsRequest(
  serviceName: string,
  summary: RunSummaryRecord,
  nowUnixNano: string,
): unknown {
  const sum = (name: string, value: number, attrs: KeyValue[] = []) => ({
    name,
    sum: {
      dataPoints: [{ asInt: String(value), timeUnixNano: nowUnixNano, attributes: attrs }],
      aggregationTemporality: AGG_CUMULATIVE,
      isMonotonic: true,
    },
  })
  const gauge = (name: string, value: number) => ({
    name,
    gauge: {
      dataPoints: [{ asDouble: value, timeUnixNano: nowUnixNano, attributes: [] }],
    },
  })
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(serviceName, summary.run.vxVersion) },
        scopeMetrics: [
          {
            scope: { name: 'vx', version: summary.run.vxVersion },
            metrics: [
              sum('vx.tasks.total', summary.taskCount),
              sum('vx.tasks.failed', summary.failedCount),
              sum('vx.tasks.cache_hits', summary.hitLocalCount, [strAttr('source', 'local')]),
              sum('vx.tasks.cache_hits', summary.hitRemoteCount, [strAttr('source', 'remote')]),
              gauge('vx.run.duration_ms', summary.totalDurationMs),
            ],
          },
        ],
      },
    ],
  }
}
