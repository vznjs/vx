// OTLP/HTTP JSON payload builders — pure functions, no SDK.
//
// vx-otel speaks the OTLP/HTTP JSON protocol directly rather than pulling the
// OpenTelemetry SDK closure. The protocol is a stable wire spec; building the
// payloads by hand keeps the package zero-dependency, fully testable, and free
// of SDK-version drift. Maps a vx run to:
//   - a TRACE: one root `vx.run` span + one child `vx.task` span per task,
//     with CI/CD + VCS semantic-convention attributes;
//   - METRICS: task/run counters + a run-duration gauge;
//   - LOGS: one record per executed task carrying its captured output tail.
//
// References: OpenTelemetry CI/CD + VCS semantic conventions; OTLP/JSON
// protobuf-JSON mapping (int64 fields are decimal STRINGS).

import { TELEMETRY_SCHEMA_VERSION } from '@vzn/vx'
import type {
  OutputFingerprint,
  RunContextRecord,
  RunSummaryRecord,
  TaskLogEntry,
  TaskTelemetry,
} from '@vzn/vx'

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
  taskRunStartedAt: 'vx.task.run_started_at',
  taskTask: 'vx.task.task',
  cacheSource: 'vx.cache.source',
  taskExitCode: 'vx.task.exit_code',
  taskDurationMs: 'vx.task.duration_ms',
  taskHash: 'vx.task.hash',
  cpuMs: 'vx.cpu_ms',
  taskWhere: 'vx.task.where',
  taskOutputs: 'vx.task.outputs',
  peakRssBytes: 'vx.peak_rss_bytes',
  taskAttempts: 'vx.task.attempts',
  taskVerify: 'vx.task.verify',
  taskVerifyChanged: 'vx.task.verify.changed',
  taskVerifyUndeclared: 'vx.task.verify.undeclared',
  taskVerifyExitCode: 'vx.task.verify.exit_code',
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

/**
 * Encode a list of output/input PATHS as JSON, not a joined string.
 *
 * A comma is a legal byte in a filename, and these lists are the actionable
 * half of a verify verdict — a path silently split in two names a file that
 * does not exist. `vx.requested_tasks` stays comma-joined by contrast: those
 * are config keys read by humans in a trace viewer far more often than they
 * are parsed, and a comma in one is pathological rather than merely rare.
 * That is a stated limit, not a guarantee.
 */
export function encodePathList(paths: readonly string[]): string {
  return JSON.stringify(paths)
}

/** Encode an output fingerprint's per-file map. JSON rather than a flat string
 *  because the keys are arbitrary output paths — a separator would need
 *  escaping, and this half is already allowed to be dropped (see below). */
export function encodeFingerprintFiles(files: OutputFingerprint['files']): string {
  return JSON.stringify(files ?? [])
}

/** What a task span needs to identify its run without its root span. */
export interface TaskSpanRunContext {
  runId: string
  workspaceId: string
  /** The run's canonical start (epoch ms) — the storage key's base. */
  startedAt: number
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
export function taskSpanAttributes(t: TaskTelemetry, run: TaskSpanRunContext): KeyValue[] {
  const attrs: KeyValue[] = [
    strAttr(SEMCONV.taskName, t.taskId),
    strAttr(SEMCONV.taskRunResult, t.status),
    // Which run, which workspace, and when that run began. Required, not
    // optional: OTLP is re-batched in transit, so a task span can arrive in a
    // payload its root span is not in, and a span that can only be read
    // alongside its parent is a span a collector can silently strand. These
    // three make it attributable on its own — and `run_started_at` is what
    // lets a receiver derive the SAME storage key it would have derived from
    // the complete trace, so the two arrival orders converge instead of
    // duplicating.
    strAttr(SEMCONV.pipelineRunId, run.runId),
    strAttr(VX_ATTR.workspaceId, run.workspaceId),
    intAttr(VX_ATTR.taskRunStartedAt, run.startedAt),
    strAttr(VX_ATTR.taskProject, t.project),
    strAttr(VX_ATTR.taskTask, t.task),
    strAttr(VX_ATTR.cacheSource, t.cacheSource),
    intAttr(VX_ATTR.taskExitCode, t.exitCode),
    intAttr(VX_ATTR.taskDurationMs, t.durationMs),
  ]
  if (t.hash !== undefined) attrs.push(strAttr(VX_ATTR.taskHash, t.hash))
  if (t.cpuMs !== undefined) attrs.push(intAttr(VX_ATTR.cpuMs, t.cpuMs))
  if (t.where !== undefined) attrs.push(strAttr(VX_ATTR.taskWhere, t.where))
  if (t.outputs !== undefined) attrs.push(strAttr(VX_ATTR.taskOutputs, t.outputs))
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
      attrs.push(strAttr(VX_ATTR.taskVerifyChanged, encodePathList(t.verify.changed)))
    }
    // Phase 2 (--verify=inputs): the undeclared workspace reads, same shape
    // as .changed — the actionable list a trace viewer needs.
    if (t.verify.kind === 'undeclared-inputs') {
      attrs.push(strAttr(VX_ATTR.taskVerifyUndeclared, encodePathList(t.verify.paths)))
    }
    // The verdict's own payload — without it a receiver knows the re-run
    // failed but not with what, which is the only actionable part.
    if (t.verify.kind === 'rerun-failed') {
      attrs.push(intAttr(VX_ATTR.taskVerifyExitCode, t.verify.exitCode))
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

// --- logs ---------------------------------------------------------------

// OTLP severity numbers: 9 INFO, 17 ERROR.
export const SEVERITY_INFO = 9
export const SEVERITY_ERROR = 17

export interface OtlpLogRecord {
  timeUnixNano: string
  observedTimeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: KeyValue[]
  traceId?: string
  spanId?: string
}

/**
 * One log record per EXECUTED task, carrying its captured output tail.
 *
 * Per task, not per chunk. A chunk-level stream is the conventional shape for
 * application logs, but a build task's output arrives as thousands of tiny
 * writes and the thing anyone reads is the tail — so a record per chunk would
 * multiply the payload by orders of magnitude to deliver the same bytes, and
 * force every receiver to reassemble them in order before it could show
 * anything. The capture buffer already bounds and orders the tail; this ships
 * what it drained.
 *
 * `traceId`/`spanId` link each record to its task span, so a viewer opens the
 * output from the span rather than by correlating ids by hand. The truncation
 * counters ride along because a capped tail that reads as complete is worse
 * than one that says what it lost.
 */
export function buildLogsRequest(args: {
  serviceName: string
  vxVersion: string
  runId: string
  /** The run's workspace — a receiver has no other way to route the record. */
  workspaceId: string
  entries: readonly TaskLogEntry[]
  timeUnixNano: string
  traceId?: string
  spanIdFor?: (taskId: string) => string | undefined
}): unknown {
  const logRecords: OtlpLogRecord[] = args.entries.map((e) => {
    const failed = e.status === 'failed'
    const attrs: KeyValue[] = [
      strAttr(SEMCONV.pipelineRunId, args.runId),
      strAttr(VX_ATTR.workspaceId, args.workspaceId),
      strAttr(SEMCONV.taskName, e.taskId),
      strAttr(VX_ATTR.logStatus, e.status),
      intAttr(VX_ATTR.logCharsFull, e.charsFull),
      intAttr(VX_ATTR.logTruncatedHead, e.truncatedHeadChars),
    ]
    if (e.hash !== undefined) attrs.push(strAttr(VX_ATTR.taskHash, e.hash))
    const spanId = args.spanIdFor?.(e.taskId)
    return {
      timeUnixNano: args.timeUnixNano,
      observedTimeUnixNano: args.timeUnixNano,
      severityNumber: failed ? SEVERITY_ERROR : SEVERITY_INFO,
      severityText: failed ? 'ERROR' : 'INFO',
      body: { stringValue: e.content },
      attributes: attrs,
      ...(args.traceId ? { traceId: args.traceId } : {}),
      ...(spanId ? { spanId } : {}),
    }
  })
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes(args.serviceName, args.vxVersion) },
        scopeLogs: [{ scope: { name: 'vx', version: args.vxVersion }, logRecords }],
      },
    ],
  }
}
