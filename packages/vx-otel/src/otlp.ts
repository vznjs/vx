// OTLP/HTTP JSON payload builders — pure functions, no SDK.
//
// vx-otel speaks the OTLP/HTTP JSON protocol directly rather than pulling the
// OpenTelemetry SDK closure. The protocol is a stable wire spec; building the
// payloads by hand keeps the package zero-dependency, fully testable, and free
// of SDK-version drift. Maps a vx run to:
//   - a TRACE: one root `vx.run` span + one child `vx.task` span per task,
//     with CI/CD + VCS semantic-convention attributes;
//   - METRICS: task/run counters + a run-duration gauge; per task its
//     duration, CPU time and peak memory, and while it runs its process
//     tree's CPU usage and memory, sampled each second;
//   - LOGS: one record per executed task carrying its captured output tail.
//
// References: OpenTelemetry CI/CD + VCS semantic conventions; OTLP/JSON
// protobuf-JSON mapping (int64 fields are decimal STRINGS).

import { TELEMETRY_SCHEMA_VERSION } from '@vzn/vx'
import type { RunContextRecord, RunSummaryRecord, TaskLogEntry, TaskTelemetry } from '@vzn/vx'

// --- OTLP value + attribute primitives ---------------------------------

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }

interface KeyValue {
  key: string
  value: AnyValue
}

function strAttr(key: string, v: string): KeyValue {
  return { key, value: { stringValue: v } }
}
function strArrayAttr(key: string, v: readonly string[]): KeyValue {
  return { key, value: { arrayValue: { values: v.map((stringValue) => ({ stringValue })) } } }
}
function intAttr(key: string, v: number): KeyValue {
  return { key, value: { intValue: String(Math.trunc(v)) } }
}
function boolAttr(key: string, v: boolean): KeyValue {
  return { key, value: { boolValue: v } }
}
/** An int64 that is ALREADY a decimal string — OTLP's own encoding for the
 *  type. Passing it through untouched is the point: routing a nanosecond
 *  count through a JS number would round it. */
function int64Attr(key: string, v: string): KeyValue {
  return { key, value: { intValue: v } }
}

// --- semantic-convention keys ------------------------------------------

const SEMCONV = {
  pipelineRunId: 'cicd.pipeline.run.id',
  pipelineRunUrl: 'cicd.pipeline.run.url.full',
  pipelineName: 'cicd.pipeline.name',
  vcsChangeId: 'vcs.change.id',
  pipelineResult: 'cicd.pipeline.result',
  taskName: 'cicd.pipeline.task.name',
  taskRunResult: 'cicd.pipeline.task.run.result',
  vcsHeadRevision: 'vcs.ref.head.revision',
  vcsHeadName: 'vcs.ref.head.name',
  vcsRepositoryUrl: 'vcs.repository.url.full',
  vcsRepositoryName: 'vcs.repository.name',
  vcsOwnerName: 'vcs.owner.name',
  vcsProviderName: 'vcs.provider.name',
  serviceName: 'service.name',
  serviceVersion: 'service.version',
  serviceInstanceId: 'service.instance.id',
  hostName: 'host.name',
  hostArch: 'host.arch',
  osType: 'os.type',
  eventName: 'event.name',
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
const VX_ATTR = {
  // run
  schema: 'vx.telemetry.schema',
  workspaceId: 'vx.workspace.id',
  workspaceName: 'vx.workspace.name',
  workspacePath: 'vx.workspace.path',
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
  runAbortedCount: 'vx.run.aborted_count',
  runHitCount: 'vx.run.hit_count',
  runHitLocalCount: 'vx.run.hit_local_count',
  runHitRemoteCount: 'vx.run.hit_remote_count',
  runUpToDateCount: 'vx.run.up_to_date_count',
  runRestoredLocalCount: 'vx.run.restored_local_count',
  runRestoredRemoteCount: 'vx.run.restored_remote_count',
  runExitOk: 'vx.run.exit_ok',
  // task
  taskProject: 'vx.task.project',
  taskRunStartedAt: 'vx.task.run_started_at',
  taskTask: 'vx.task.task',
  cacheSource: 'vx.cache.source',
  cacheRestored: 'vx.cache.restored',
  taskExitCode: 'vx.task.exit_code',
  taskStatus: 'vx.task.status',
  taskDurationMs: 'vx.task.duration_ms',
  taskHash: 'vx.task.hash',
  cpuMs: 'vx.cpu_ms',
  taskWhere: 'vx.task.where',
  taskBlockedBy: 'vx.task.blocked_by',
  taskTimedOut: 'vx.task.timed_out',
  taskSandboxViolations: 'vx.task.sandbox_violations',
  taskNotReady: 'vx.task.not_ready',
  taskOutputs: 'vx.task.outputs',
  peakRssBytes: 'vx.peak_rss_bytes',
  taskAttempts: 'vx.task.attempts',
  taskAttempt: 'vx.task.attempt',
  taskCommand: 'vx.task.command',
  taskFlakyPasses: 'vx.task.flaky.passes',
  taskFlakyFailures: 'vx.task.flaky.failures',
  taskAdmissionHeldMs: 'vx.task.admission_held_ms',
  taskQueuedMs: 'vx.task.queued_ms',
  taskInputFiles: 'vx.task.input_files',
  missChangeCount: 'vx.cache.miss.change_count',
  artifactBytes: 'vx.cache.artifact_bytes',
  fetchMs: 'vx.cache.fetch_ms',
  saveMs: 'vx.cache.save_ms',
  uploadCount: 'vx.cache.upload.count',
  uploadBytes: 'vx.cache.upload.bytes',
  uploadMs: 'vx.cache.upload.ms',
  uploadFailed: 'vx.cache.upload.failed',
  missChanges: 'vx.cache.miss.changes',
  ciJob: 'vx.ci.job',
  ciAttempt: 'vx.ci.attempt',
  storedDurationMs: 'vx.cache.stored_duration_ms',
  storedCpuMs: 'vx.cache.stored_cpu_ms',
  storedPeakRssBytes: 'vx.cache.stored_peak_rss_bytes',
  sandboxViolation: 'vx.sandbox.violation',
  sandboxViolationsDropped: 'vx.sandbox.violations_dropped',
  stageName: 'vx.stage.name',
  wallclockStartNs: 'vx.task.wallclock_start_ns',
  wallclockEndNs: 'vx.task.wallclock_end_ns',
  // task log records (the OTel Logs signal)
  logCharsFull: 'vx.log.chars_full',
  logTruncatedHead: 'vx.log.truncated_head',
  logStatus: 'vx.log.status',
} as const

// OTLP status codes: 0 UNSET, 1 OK, 2 ERROR. Span kind: 1 INTERNAL.
const STATUS_UNSET = 0
const STATUS_ERROR = 2
export const SPAN_KIND_INTERNAL = 1
// Metric aggregation temporality: 1 = DELTA.
const AGG_DELTA = 1

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
  events?: OtlpSpanEvent[]
  links?: OtlpSpanLink[]
}

interface OtlpSpanEvent {
  timeUnixNano: string
  name: string
  attributes: KeyValue[]
}

interface OtlpSpanLink {
  traceId: string
  spanId: string
  attributes: KeyValue[]
}

/**
 * A task span's events: each attempt that failed and was run again
 * (`vx.task.retry`, at its end), vx's own deadline killing the task
 * (`vx.task.timeout`, at the span's end), and each sandbox violation
 * (`vx.sandbox.violation`, its line).
 */
export function taskSpanEvents(t: TaskTelemetry, endUnixNano: string): OtlpSpanEvent[] {
  const events: OtlpSpanEvent[] = (t.failedAttempts ?? []).map((a, i) => ({
    timeUnixNano: String(Math.trunc(a.endedAt) * 1_000_000),
    name: 'vx.task.retry',
    attributes: [
      intAttr(VX_ATTR.taskAttempt, i + 1),
      intAttr(VX_ATTR.taskExitCode, a.exitCode),
      ...(a.timedOut === true ? [boolAttr(VX_ATTR.taskTimedOut, true)] : []),
    ],
  }))
  if (t.timedOut === true) {
    events.push({ timeUnixNano: endUnixNano, name: 'vx.task.timeout', attributes: [] })
  }
  const lines = t.sandboxViolationLines ?? []
  for (const line of lines.slice(0, MAX_VIOLATION_EVENTS)) {
    events.push({
      timeUnixNano: endUnixNano,
      name: VX_ATTR.sandboxViolation,
      attributes: [strAttr(VX_ATTR.sandboxViolation, line)],
    })
  }
  if (lines.length > MAX_VIOLATION_EVENTS) {
    events.push({
      timeUnixNano: endUnixNano,
      name: VX_ATTR.sandboxViolationsDropped,
      attributes: [intAttr(VX_ATTR.sandboxViolationsDropped, lines.length - MAX_VIOLATION_EVENTS)],
    })
  }
  return events
}

/** A collector keeps 128 events per span by default; the rest say how many they were. */
const MAX_VIOLATION_EVENTS = 100

/**
 * A child span of the run for one of its stages (`VX_TIMING`'s marks):
 * where the time before the first task and after the last one went. Named
 * by the stage, a fixed set. The stages ahead of the run lock end before
 * the run span starts.
 */
export function stageSpan(
  traceId: string,
  parentSpanId: string,
  stage: { name: string; startedAt: number; endedAt: number },
  spanId: string,
): OtlpSpan {
  return {
    traceId,
    spanId,
    parentSpanId,
    name: stage.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: exactNanos(stage.startedAt),
    endTimeUnixNano: exactNanos(stage.endedAt),
    attributes: [strAttr(VX_ATTR.stageName, stage.name)],
    status: { code: STATUS_UNSET },
  }
}

/** Epoch ms with a fraction, as OTLP's int64 nanoseconds: a stage can be under 1 ms. */
function exactNanos(ms: number): string {
  return String(BigInt(Math.round(ms * 1000)) * 1000n)
}

/** A link from a task span to the span of a task it waited on. */
export function dependencyLink(traceId: string, spanId: string, taskId: string): OtlpSpanLink {
  return { traceId, spanId, attributes: [strAttr(SEMCONV.taskName, taskId)] }
}

// --- attribute mapping (pure) ------------------------------------------

/**
 * Resource attributes — service identity, after `OTEL_RESOURCE_ATTRIBUTES`'
 * own (`extra`), whose `service.name` / `service.version` vx's replace.
 * Run/VCS context rides span attrs.
 */
function resourceAttributes(
  serviceName: string,
  vxVersion: string,
  extra: Readonly<Record<string, string>> = {},
): KeyValue[] {
  const own = new Set<string>([SEMCONV.serviceName, SEMCONV.serviceVersion])
  return [
    ...Object.entries(extra)
      .filter(([k]) => !own.has(k))
      .map(([k, v]) => strAttr(k, v)),
    strAttr(SEMCONV.serviceName, serviceName),
    strAttr(SEMCONV.serviceVersion, vxVersion),
  ]
}

/**
 * The run as resource attributes, so every signal it sends (spans, metric
 * points, log records) names the same run, host, repository and workspace: a
 * backend joins them on `service.instance.id`. Under `OTEL_RESOURCE_ATTRIBUTES`,
 * which wins.
 */
export function runResource(run: RunContextRecord): Record<string, string> {
  const r: Record<string, string> = {
    [SEMCONV.serviceInstanceId]: run.runId,
    [SEMCONV.pipelineRunId]: run.runId,
    [SEMCONV.osType]: run.os === 'win32' ? 'windows' : run.os,
    [SEMCONV.hostArch]: run.arch === 'x64' ? 'amd64' : run.arch,
  }
  if (run.host !== null) r[SEMCONV.hostName] = run.host
  for (const [k, v] of originFields(run)) r[k] = v
  if (run.commitSha !== null) r[SEMCONV.vcsHeadRevision] = run.commitSha
  if (run.branch !== null) r[SEMCONV.vcsHeadName] = run.branch
  return r
}

const VCS_PROVIDERS: Readonly<Record<string, string>> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'codeberg.org': 'gitea',
}

/**
 * Where the run came from: the repository (from the normalized origin remote,
 * `host/owner/name`) as the VCS conventions name it, where in it the
 * workspace sits, and the CI run, pull request, workflow and job.
 */
function originFields(run: RunContextRecord): [key: string, value: string][] {
  const fields: [string, string][] = []
  if (run.repository !== undefined) {
    const parts = run.repository.split('/')
    fields.push(
      [SEMCONV.vcsRepositoryUrl, `https://${run.repository}`],
      [SEMCONV.vcsRepositoryName, parts.at(-1)!],
    )
    if (parts.length >= 3) fields.push([SEMCONV.vcsOwnerName, parts.at(-2)!])
    const provider = VCS_PROVIDERS[parts[0]!]
    if (provider !== undefined) fields.push([SEMCONV.vcsProviderName, provider])
  }
  if (run.workspacePath !== undefined) fields.push([VX_ATTR.workspacePath, run.workspacePath])
  if (run.ciRunUrl !== undefined) fields.push([SEMCONV.pipelineRunUrl, run.ciRunUrl])
  if (run.ciChange !== undefined) fields.push([SEMCONV.vcsChangeId, run.ciChange])
  if (run.ciPipeline !== undefined) fields.push([SEMCONV.pipelineName, run.ciPipeline])
  if (run.ciJob !== undefined) fields.push([VX_ATTR.ciJob, run.ciJob])
  if (run.ciAttempt !== undefined) fields.push([VX_ATTR.ciAttempt, String(run.ciAttempt)])
  return fields
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
    ...originFields(run).map(([k, v]) => strAttr(k, v)),
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
      intAttr(VX_ATTR.runAbortedCount, summary.abortedCount),
      intAttr(VX_ATTR.runHitCount, summary.hitCount),
      intAttr(VX_ATTR.runHitLocalCount, summary.hitLocalCount),
      intAttr(VX_ATTR.runHitRemoteCount, summary.hitRemoteCount),
      intAttr(VX_ATTR.runUpToDateCount, summary.upToDateCount),
      intAttr(VX_ATTR.runRestoredLocalCount, summary.restoredLocalCount),
      intAttr(VX_ATTR.runRestoredRemoteCount, summary.restoredRemoteCount),
      boolAttr(VX_ATTR.runExitOk, summary.exitOk),
      strAttr(SEMCONV.pipelineResult, pipelineResult(summary)),
    )
    if (summary.uploads !== undefined) {
      attrs.push(
        intAttr(VX_ATTR.uploadCount, summary.uploads.count),
        intAttr(VX_ATTR.uploadBytes, summary.uploads.bytes),
        intAttr(VX_ATTR.uploadMs, summary.uploads.ms),
        intAttr(VX_ATTR.uploadFailed, summary.uploads.failed),
      )
    }
  }
  return attrs
}

/**
 * `cicd.pipeline.result`, the task enum's run-level twin. A red run with
 * nothing failed and something aborted is a stopped one.
 */
function pipelineResult(s: RunSummaryRecord): string {
  if (s.exitOk) return 'success'
  return s.failedCount === 0 && s.abortedCount > 0 ? 'cancellation' : 'failure'
}

/** The root span is ERROR when the run is red: UNSET read as a clean run. */
export function runStatusCode(summary?: RunSummaryRecord): number {
  return summary?.exitOk === false ? STATUS_ERROR : STATUS_UNSET
}

/** What a task span needs to identify its run without its root span. */
interface TaskSpanRunContext {
  runId: string
  workspaceId: string
  /** The run's canonical start (epoch ms) — the storage key's base. */
  startedAt: number
  /** The task's command, from its start record; a task that never started has none. */
  command?: string
}

/**
 * `cicd.pipeline.task.run.result` is an enum (success, failure, error,
 * timeout, cancellation, skip). vx's own status went out verbatim, so
 * `failed`, `skipped`, `aborted` and the two hit statuses matched none of it
 * and a conventions-aware backend counted no task as failed (F-12). The
 * exact status still rides `vx.task.status`.
 */
function runResult(t: TaskTelemetry): string {
  switch (t.status) {
    case 'failed':
      return t.timedOut === true ? 'timeout' : 'failure'
    case 'skipped':
      return 'skip'
    case 'aborted':
      return 'cancellation'
    default:
      return 'success'
  }
}

/**
 * Attributes for a child `vx.task` span — every `TaskTelemetry` field.
 *
 * The wallclock offsets ride as int64 STRINGS (OTLP's own int64 encoding), not
 * numbers: they are nanoseconds, and a receiver reconstructing a task's
 * `started_at` from them is computing a dedup key that must match the value
 * the native ingest path derives, to the millisecond.
 *
 * Nothing here is unbounded: every value is an id, an enum, a number or the
 * task's command line, so a collector's attribute-value limit cannot cut one. The largest thing this
 * exporter ships is a task's captured tail, which travels as a LOG record
 * (`vx.log.*`) carrying its own full length, so a cut there is visible.
 */
export function taskSpanAttributes(t: TaskTelemetry, run: TaskSpanRunContext): KeyValue[] {
  const attrs: KeyValue[] = [
    strAttr(SEMCONV.taskName, t.taskId),
    strAttr(SEMCONV.taskRunResult, runResult(t)),
    strAttr(VX_ATTR.taskStatus, t.status),
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
  if (t.restored !== undefined) attrs.push(boolAttr(VX_ATTR.cacheRestored, t.restored))
  if (t.cpuMs !== undefined) attrs.push(intAttr(VX_ATTR.cpuMs, t.cpuMs))
  if (t.where !== undefined) attrs.push(strAttr(VX_ATTR.taskWhere, t.where))
  // A skipped task's root blocker (a task id, as the record carries it).
  if (t.blockedBy !== undefined) attrs.push(strAttr(VX_ATTR.taskBlockedBy, t.blockedBy))
  // vx's own deadline killed the task: the 143 is a timeout, not a signal.
  if (t.timedOut === true) attrs.push(boolAttr(VX_ATTR.taskTimedOut, true))
  if (t.sandboxViolations !== undefined)
    attrs.push(intAttr(VX_ATTR.taskSandboxViolations, t.sandboxViolations))
  // Why a persistent task never became ready ('timeout' | 'exited' | 'spawn').
  if (t.notReady !== undefined) attrs.push(strAttr(VX_ATTR.taskNotReady, t.notReady))
  if (t.outputs !== undefined) attrs.push(strAttr(VX_ATTR.taskOutputs, t.outputs))
  if (t.peakRssBytes !== undefined) attrs.push(intAttr(VX_ATTR.peakRssBytes, t.peakRssBytes))
  if (t.attempts !== undefined) attrs.push(intAttr(VX_ATTR.taskAttempts, t.attempts))
  if (run.command !== undefined) attrs.push(strAttr(VX_ATTR.taskCommand, run.command))
  if (t.flaky !== undefined) {
    attrs.push(
      intAttr(VX_ATTR.taskFlakyPasses, t.flaky.passes),
      intAttr(VX_ATTR.taskFlakyFailures, t.flaky.failures),
    )
  }
  if (t.storedDurationMs !== undefined)
    attrs.push(intAttr(VX_ATTR.storedDurationMs, t.storedDurationMs))
  if (t.storedCpuMs !== undefined) attrs.push(intAttr(VX_ATTR.storedCpuMs, t.storedCpuMs))
  if (t.storedPeakRssBytes !== undefined)
    attrs.push(intAttr(VX_ATTR.storedPeakRssBytes, t.storedPeakRssBytes))
  if (t.admissionHeldMs !== undefined)
    attrs.push(intAttr(VX_ATTR.taskAdmissionHeldMs, t.admissionHeldMs))
  if (t.queuedMs !== undefined) attrs.push(intAttr(VX_ATTR.taskQueuedMs, t.queuedMs))
  if (t.inputFiles !== undefined) attrs.push(intAttr(VX_ATTR.taskInputFiles, t.inputFiles))
  if (t.artifactBytes !== undefined) attrs.push(intAttr(VX_ATTR.artifactBytes, t.artifactBytes))
  if (t.fetchMs !== undefined) attrs.push(intAttr(VX_ATTR.fetchMs, t.fetchMs))
  if (t.saveMs !== undefined) attrs.push(intAttr(VX_ATTR.saveMs, t.saveMs))
  if (t.inputChanges !== undefined) {
    // `changed file src/a.ts`: what moved the key since the last saved entry.
    attrs.push(
      intAttr(VX_ATTR.missChangeCount, t.inputChanges.count),
      strArrayAttr(
        VX_ATTR.missChanges,
        t.inputChanges.first.map((c) => `${c.change} ${c.kind} ${c.name}`),
      ),
    )
  }
  if (t.wallclockStartNs !== undefined)
    attrs.push(int64Attr(VX_ATTR.wallclockStartNs, t.wallclockStartNs))
  if (t.wallclockEndNs !== undefined)
    attrs.push(int64Attr(VX_ATTR.wallclockEndNs, t.wallclockEndNs))
  return attrs
}

/** A failed task maps to span status ERROR. Everything else stays UNSET. */
export function taskStatusCode(t: TaskTelemetry): number {
  if (t.status === 'failed') return STATUS_ERROR
  return STATUS_UNSET
}

// --- envelope builders -------------------------------------------------

/** Wrap spans in an ExportTraceServiceRequest. */
export function buildTraceRequest(
  serviceName: string,
  vxVersion: string,
  spans: OtlpSpan[],
  resource?: Readonly<Record<string, string>>,
): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(serviceName, vxVersion, resource) },
        scopeSpans: [{ scope: { name: 'vx', version: vxVersion }, spans }],
      },
    ],
  }
}

/**
 * Build an ExportMetricsServiceRequest from a run summary. Each count is the
 * RUN's, so it is a DELTA over the run's own interval: sent CUMULATIVE with
 * no start time, two runs of 10 tasks read as a series that never rose, and
 * parallel jobs interleaved on one series (item 927).
 */
export function buildMetricsRequest(
  serviceName: string,
  summary: RunSummaryRecord,
  nowUnixNano: string,
  startUnixNano: string,
  resource?: Readonly<Record<string, string>>,
  points: readonly TaskMetricPoint[] = [],
): unknown {
  const point = (value: number, attrs: KeyValue[] = []) => ({
    asInt: String(value),
    startTimeUnixNano: startUnixNano,
    timeUnixNano: nowUnixNano,
    attributes: attrs,
  })
  const sum = (name: string, dataPoints: ReturnType<typeof point>[]) => ({
    name,
    sum: { dataPoints, aggregationTemporality: AGG_DELTA, isMonotonic: true },
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
        resource: { attributes: resourceAttributes(serviceName, summary.run.vxVersion, resource) },
        scopeMetrics: [
          {
            scope: { name: 'vx', version: summary.run.vxVersion },
            metrics: [
              sum('vx.tasks.total', [point(summary.taskCount)]),
              sum('vx.tasks.failed', [point(summary.failedCount)]),
              // One metric, a point per source: two entries of one name
              // are two metrics a backend may keep only one of.
              sum('vx.tasks.cache_hits', [
                point(summary.hitLocalCount, [strAttr('source', 'local')]),
                point(summary.hitRemoteCount, [strAttr('source', 'remote')]),
              ]),
              // What the hits did to the disk: restored outputs (by the
              // layer they came from) or found them already in place.
              sum('vx.tasks.cache_restored', [
                point(summary.restoredLocalCount, [strAttr('source', 'local')]),
                point(summary.restoredRemoteCount, [strAttr('source', 'remote')]),
              ]),
              sum('vx.tasks.cache_up_to_date', [point(summary.upToDateCount)]),
              gauge('vx.run.duration_ms', summary.totalDurationMs),
              // What the run's cache hits skipped: the stored runs' time.
              gauge(
                'vx.run.time_saved_ms',
                summary.tasks.reduce((n, t) => n + (t.storedDurationMs ?? 0), 0),
              ),
              ...taskMetrics(points),
            ],
          },
        ],
      },
    ],
  }
}

/**
 * A per-task metric point: a task's totals at its end, or one live sample
 * of its process tree while it runs.
 */
export type TaskMetricPoint = (
  | { kind: 'end'; task: TaskTelemetry; startUnixNano: string; endUnixNano: string }
  | {
      kind: 'sample'
      taskId: string
      project: string
      task: string
      timeUnixNano: string
      /** CPU cores busy since the previous sample (1 = one core). */
      cpuUsage: number
      rssBytes: number
    }
) & {
  /** The task's span: each point carries it as an exemplar, a link from the chart to the trace. */
  span?: { traceId: string; spanId: string }
}

/**
 * An ExportMetricsServiceRequest of per-task gauges alone: the points past
 * what fit beside the run's own metrics (`buildMetricsRequest`).
 */
export function buildTaskMetricsRequest(
  serviceName: string,
  vxVersion: string,
  points: readonly TaskMetricPoint[],
  resource?: Readonly<Record<string, string>>,
): unknown {
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(serviceName, vxVersion, resource) },
        scopeMetrics: [{ scope: { name: 'vx', version: vxVersion }, metrics: taskMetrics(points) }],
      },
    ],
  }
}

/**
 * Per-task gauges, keyed by task. At each task's end: its duration, CPU time and peak memory (CPU and memory as
 * the runner measured them at exit; a task it did not measure, a cache hit or
 * a remote run, sends no point for them), on a hit the time it saved, and
 * how long an `admit` policy held it. While a task runs: its process
 * tree's CPU usage and memory, once per sample. A task's numbers otherwise
 * live only on its span, which no metrics backend charts. Each point names
 * the task's span as an exemplar.
 */
function taskMetrics(points: readonly TaskMetricPoint[]): unknown[] {
  const series = new Map<string, { unit: string; dataPoints: unknown[] }>()
  const add = (name: string, unit: string, point: unknown): void => {
    const s = series.get(name)
    if (s === undefined) series.set(name, { unit, dataPoints: [point] })
    else s.dataPoints.push(point)
  }
  const taskAttrs = (taskId: string, project: string, task: string): KeyValue[] => [
    strAttr(SEMCONV.taskName, taskId),
    strAttr(VX_ATTR.taskProject, project),
    strAttr(VX_ATTR.taskTask, task),
  ]
  const exemplars = (p: TaskMetricPoint, value: number, timeUnixNano: string) =>
    p.span === undefined
      ? {}
      : { exemplars: [{ timeUnixNano, asDouble: value, filteredAttributes: [], ...p.span }] }
  for (const p of points) {
    if (p.kind === 'sample') {
      const at = (value: number) => ({
        asDouble: value,
        timeUnixNano: p.timeUnixNano,
        attributes: taskAttrs(p.taskId, p.project, p.task),
        ...exemplars(p, value, p.timeUnixNano),
      })
      add('vx.task.cpu_usage', '1', at(p.cpuUsage))
      add('vx.task.memory', 'By', at(p.rssBytes))
      continue
    }
    const t = p.task
    const at = (value: number) => ({
      asDouble: value,
      startTimeUnixNano: p.startUnixNano,
      timeUnixNano: p.endUnixNano,
      attributes: [
        ...taskAttrs(t.taskId, t.project, t.task),
        strAttr(VX_ATTR.cacheSource, t.cacheSource),
      ],
      ...exemplars(p, value, p.endUnixNano),
    })
    add('vx.task.duration', 'ms', at(t.durationMs))
    if (t.cpuMs !== undefined) add('vx.task.cpu_time', 'ms', at(t.cpuMs))
    if (t.peakRssBytes !== undefined) add('vx.task.peak_memory', 'By', at(t.peakRssBytes))
    if (t.storedDurationMs !== undefined) add('vx.task.time_saved', 'ms', at(t.storedDurationMs))
    if (t.admissionHeldMs !== undefined) add('vx.task.admission_held', 'ms', at(t.admissionHeldMs))
    if (t.queuedMs !== undefined) add('vx.task.queued', 'ms', at(t.queuedMs))
    if (t.artifactBytes !== undefined) add('vx.task.artifact_size', 'By', at(t.artifactBytes))
    if (t.fetchMs !== undefined) add('vx.task.cache_fetch', 'ms', at(t.fetchMs))
    if (t.saveMs !== undefined) add('vx.task.cache_save', 'ms', at(t.saveMs))
  }
  return [...series].map(([name, { unit, dataPoints }]) => ({ name, unit, gauge: { dataPoints } }))
}

// --- logs ---------------------------------------------------------------

// OTLP severity numbers: 9 INFO, 17 ERROR.
const SEVERITY_INFO = 9
const SEVERITY_ERROR = 17

interface OtlpLogRecord {
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
  /** When the task ended; `timeUnixNano` for one with no known end. */
  timeFor?: (taskId: string) => string | undefined
  traceId?: string
  spanIdFor?: (taskId: string) => string | undefined
  resource?: Readonly<Record<string, string>>
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
    const time = args.timeFor?.(e.taskId) ?? args.timeUnixNano
    return {
      timeUnixNano: time,
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
        resource: {
          attributes: resourceAttributes(args.serviceName, args.vxVersion, args.resource),
        },
        scopeLogs: [{ scope: { name: 'vx', version: args.vxVersion }, logRecords }],
      },
    ],
  }
}

/** A lifecycle moment, sent as it happens in live mode: a run or a task started. */
export interface LiveEvent {
  name: 'vx.run.start' | 'vx.task.start'
  timeUnixNano: string
  body: string
  taskId?: string
  spanId?: string
}

/**
 * Live mode's lifecycle records, one log record each, linked to the run's
 * trace (and the task's span): what a dashboard shows as running before any
 * span, which is sent only once it ends, exists.
 */
export function buildEventLogsRequest(args: {
  serviceName: string
  vxVersion: string
  runId: string
  workspaceId: string
  events: readonly LiveEvent[]
  traceId?: string
  resource?: Readonly<Record<string, string>>
}): unknown {
  const logRecords: OtlpLogRecord[] = args.events.map((e) => ({
    timeUnixNano: e.timeUnixNano,
    observedTimeUnixNano: e.timeUnixNano,
    severityNumber: SEVERITY_INFO,
    severityText: 'INFO',
    body: { stringValue: e.body },
    attributes: [
      strAttr(SEMCONV.eventName, e.name),
      strAttr(SEMCONV.pipelineRunId, args.runId),
      strAttr(VX_ATTR.workspaceId, args.workspaceId),
      ...(e.taskId !== undefined ? [strAttr(SEMCONV.taskName, e.taskId)] : []),
    ],
    ...(args.traceId ? { traceId: args.traceId } : {}),
    ...(args.traceId && e.spanId ? { spanId: e.spanId } : {}),
  }))
  return {
    resourceLogs: [
      {
        resource: {
          attributes: resourceAttributes(args.serviceName, args.vxVersion, args.resource),
        },
        scopeLogs: [{ scope: { name: 'vx', version: args.vxVersion }, logRecords }],
      },
    ],
  }
}
