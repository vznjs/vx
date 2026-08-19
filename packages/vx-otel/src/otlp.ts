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

import { TELEMETRY_SCHEMA_VERSION } from '@vzn/vx'
import type { OutputFingerprint, RunContextRecord, RunSummaryRecord, TaskTelemetry } from '@vzn/vx'

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
/** An int64 that is ALREADY a decimal string — OTLP's own encoding for the
 *  type. Passing it through untouched is the point: routing a nanosecond
 *  count through a JS number would round it. */
export function int64Attr(key: string, v: string): KeyValue {
  return { key, value: { intValue: v } }
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

/**
 * Every vx-specific attribute key, in ONE place.
 *
 * These keys are the wire: a trace is only a lossless description of a run if
 * a reader can find every field again, and the only thing standing between an
 * encoder and a decoder is agreement on these strings. Naming them once means
 * a rename is a compile error here rather than a field that silently stops
 * arriving. Anything with a real OTel semantic convention uses it instead (see
 * SEMCONV above) — these cover what the conventions have no word for.
 *
 * `vx.default_branch` deliberately does NOT reuse `vcs.ref.base.name`: that
 * convention means the base ref of a specific change, which is not the same
 * question as "what is this repo's trunk", and a decoder reading the wrong
 * one would quietly mis-classify every run's trust scope.
 */
export const VX_ATTR = {
  // run
  schema: 'vx.telemetry.schema',
  workspaceId: 'vx.workspace.id',
  workspaceName: 'vx.workspace.name',
  command: 'vx.command',
  requestedTasks: 'vx.requested_tasks',
  cachePolicy: 'vx.cache_policy',
  concurrency: 'vx.concurrency',
  flow: 'vx.flow',
  ci: 'vx.ci',
  ciProvider: 'vx.ci.provider',
  host: 'vx.host',
  os: 'vx.os',
  arch: 'vx.arch',
  version: 'vx.version',
  dirty: 'vx.dirty',
  defaultBranch: 'vx.default_branch',
  tagPrefix: 'vx.tag.',
  // run summary (root span only)
  runStartedAt: 'vx.run.started_at',
  runEndedAt: 'vx.run.ended_at',
  runDurationMs: 'vx.run.duration_ms',
  runTaskCount: 'vx.run.task_count',
  runFailedCount: 'vx.run.failed_count',
  runHitCount: 'vx.run.hit_count',
  runHitLocalCount: 'vx.run.hit_local_count',
  runHitRemoteCount: 'vx.run.hit_remote_count',
  runExitOk: 'vx.run.exit_ok',
  // task
  taskProject: 'vx.task.project',
  taskTask: 'vx.task.task',
  cacheSource: 'vx.cache.source',
  taskExitCode: 'vx.task.exit_code',
  taskDurationMs: 'vx.task.duration_ms',
  taskHash: 'vx.task.hash',
  cpuMs: 'vx.cpu_ms',
  peakRssBytes: 'vx.peak_rss_bytes',
  taskAttempts: 'vx.task.attempts',
  taskVerify: 'vx.task.verify',
  taskVerifyChanged: 'vx.task.verify.changed',
  taskVerifyUndeclared: 'vx.task.verify.undeclared',
  wallclockStartNs: 'vx.task.wallclock_start_ns',
  wallclockEndNs: 'vx.task.wallclock_end_ns',
  fpTree: 'vx.task.output_fp.tree',
  fpFileCount: 'vx.task.output_fp.file_count',
  fpFiles: 'vx.task.output_fp.files',
  fpTruncated: 'vx.task.output_fp.truncated',
  // task log records (the OTel Logs signal)
  logCharsFull: 'vx.log.chars_full',
  logTruncatedHead: 'vx.log.truncated_head',
  logStatus: 'vx.log.status',
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

/**
 * Attributes for the root `vx.run` span.
 *
 * With `summary` supplied this is a COMPLETE description of the run — every
 * `RunContextRecord` field plus the run-level tallies — so a receiver can
 * rebuild the invocation header from the trace alone. The summary is absent
 * only when a run died before it was assembled; the context half still ships.
 *
 * `started_at` / `ended_at` ride as millisecond attributes even though the
 * span already carries times, because the span's are unix-NANOS: decoding
 * them costs a BigInt (epoch-ms × 1e6 is past Number.MAX_SAFE_INTEGER), and
 * these two values are a storage partition key — silently losing precision on
 * them is not a rounding error, it is a row in the wrong partition.
 */
export function runSpanAttributes(run: RunContextRecord, summary?: RunSummaryRecord): KeyValue[] {
  const attrs: KeyValue[] = [
    strAttr(SEMCONV.pipelineRunId, run.runId),
    intAttr(VX_ATTR.schema, TELEMETRY_SCHEMA_VERSION),
    strAttr(VX_ATTR.workspaceId, run.workspaceId),
    strAttr(VX_ATTR.workspaceName, run.workspaceName),
    strAttr(VX_ATTR.command, run.command),
    strAttr(VX_ATTR.requestedTasks, run.requestedTasks.join(',')),
    strAttr(VX_ATTR.cachePolicy, run.cachePolicy),
    intAttr(VX_ATTR.concurrency, run.concurrency),
    boolAttr(VX_ATTR.ci, run.ci),
    strAttr(VX_ATTR.os, run.os),
    strAttr(VX_ATTR.arch, run.arch),
    strAttr(VX_ATTR.version, run.vxVersion),
  ]
  if (run.flow !== null) attrs.push(strAttr(VX_ATTR.flow, run.flow))
  if (run.commitSha !== null) attrs.push(strAttr(SEMCONV.vcsHeadRevision, run.commitSha))
  if (run.branch !== null) attrs.push(strAttr(SEMCONV.vcsHeadName, run.branch))
  if (run.defaultBranch !== null) attrs.push(strAttr(VX_ATTR.defaultBranch, run.defaultBranch))
  if (run.dirty !== null) attrs.push(boolAttr(VX_ATTR.dirty, run.dirty))
  if (run.ciProvider !== null) attrs.push(strAttr(VX_ATTR.ciProvider, run.ciProvider))
  if (run.host !== null) attrs.push(strAttr(VX_ATTR.host, run.host))
  for (const [k, v] of Object.entries(run.tags)) attrs.push(strAttr(`${VX_ATTR.tagPrefix}${k}`, v))
  if (summary !== undefined) {
    attrs.push(
      intAttr(VX_ATTR.runStartedAt, summary.startedAt),
      intAttr(VX_ATTR.runEndedAt, summary.endedAt),
      intAttr(VX_ATTR.runDurationMs, summary.totalDurationMs),
      intAttr(VX_ATTR.runTaskCount, summary.taskCount),
      intAttr(VX_ATTR.runFailedCount, summary.failedCount),
      intAttr(VX_ATTR.runHitCount, summary.hitCount),
      intAttr(VX_ATTR.runHitLocalCount, summary.hitLocalCount),
      intAttr(VX_ATTR.runHitRemoteCount, summary.hitRemoteCount),
      boolAttr(VX_ATTR.runExitOk, summary.exitOk),
    )
  }
  return attrs
}

/** Encode an output fingerprint's per-file map. JSON rather than a flat string
 *  because the keys are arbitrary output paths — a separator would need
 *  escaping, and this half is already allowed to be dropped (see below). */
export function encodeFingerprintFiles(files: OutputFingerprint['files']): string {
  return JSON.stringify(files ?? [])
}

/**
 * Attributes for a child `vx.task` span — every `TaskTelemetry` field.
 *
 * The wallclock offsets ride as int64 STRINGS (OTLP's own int64 encoding), not
 * numbers: they are nanoseconds, and a receiver reconstructing a task's
 * `started_at` from them is computing a dedup key that must match the value
 * the native ingest path derives, to the millisecond.
 *
 * The fingerprint's per-file map is the one attribute here that may legally
 * not survive the trip — it is the largest by far (up to 500 path/hash pairs)
 * and a collector with an attribute-value limit will truncate it. That is
 * tolerable BY DESIGN: divergence DETECTION keys on `tree`, which is a fixed
 * 16 chars, so a dropped file map costs a diff its detail, never its verdict.
 */
export function taskSpanAttributes(t: TaskTelemetry): KeyValue[] {
  const attrs: KeyValue[] = [
    strAttr(SEMCONV.taskName, t.taskId),
    strAttr(SEMCONV.taskRunResult, t.status),
    strAttr(VX_ATTR.taskProject, t.project),
    strAttr(VX_ATTR.taskTask, t.task),
    strAttr(VX_ATTR.cacheSource, t.cacheSource),
    intAttr(VX_ATTR.taskExitCode, t.exitCode),
    intAttr(VX_ATTR.taskDurationMs, t.durationMs),
  ]
  if (t.hash !== undefined) attrs.push(strAttr(VX_ATTR.taskHash, t.hash))
  if (t.cpuMs !== undefined) attrs.push(intAttr(VX_ATTR.cpuMs, t.cpuMs))
  if (t.peakRssBytes !== undefined) attrs.push(intAttr(VX_ATTR.peakRssBytes, t.peakRssBytes))
  if (t.attempts !== undefined) attrs.push(intAttr(VX_ATTR.taskAttempts, t.attempts))
  if (t.wallclockStartNs !== undefined)
    attrs.push(int64Attr(VX_ATTR.wallclockStartNs, t.wallclockStartNs))
  if (t.wallclockEndNs !== undefined)
    attrs.push(int64Attr(VX_ATTR.wallclockEndNs, t.wallclockEndNs))
  // Cache-correctness verdict from `--verify` — the hermeticity signal. A
  // `nondeterministic` verdict means the task's cache entry is unsound; it
  // maps to span status ERROR (see taskStatusCode) so it surfaces as a failed
  // span in the tracing backend even though the task itself exited 0.
  if (t.verify !== undefined) {
    attrs.push(strAttr(VX_ATTR.taskVerify, t.verify.kind))
    if (t.verify.kind === 'nondeterministic' || t.verify.kind === 'allowed-nondeterministic') {
      attrs.push(strAttr(VX_ATTR.taskVerifyChanged, t.verify.changed.join(',')))
    }
    // Phase 2 (--verify=inputs): the undeclared workspace reads, same shape
    // as .changed — the actionable list a trace viewer needs.
    if (t.verify.kind === 'undeclared-inputs') {
      attrs.push(strAttr(VX_ATTR.taskVerifyUndeclared, t.verify.paths.join(',')))
    }
  }
  // Output fingerprint (--verify=fingerprint and friends): the cross-machine
  // hermeticity signal. A receiver pairs these by (hash, os, arch) and names
  // the outputs that diverged between two platforms.
  if (t.outputFp !== undefined) {
    attrs.push(
      strAttr(VX_ATTR.fpTree, t.outputFp.tree),
      intAttr(VX_ATTR.fpFileCount, t.outputFp.fileCount),
      strAttr(VX_ATTR.fpFiles, encodeFingerprintFiles(t.outputFp.files)),
      boolAttr(VX_ATTR.fpTruncated, t.outputFp.truncated === true),
    )
  }
  return attrs
}

/** A failed task maps to span status ERROR; so does a task whose `--verify`
 *  verdict proved its cache entry unsound (nondeterministic / rerun-failed /
 *  undeclared-inputs) — even though it exited 0. Everything else stays UNSET. */
export function taskStatusCode(t: TaskTelemetry): number {
  if (t.status === 'failed') return STATUS_ERROR
  if (
    t.verify?.kind === 'nondeterministic' ||
    t.verify?.kind === 'rerun-failed' ||
    t.verify?.kind === 'undeclared-inputs'
  ) {
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
