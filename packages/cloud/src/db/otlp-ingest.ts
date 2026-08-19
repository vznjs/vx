// OTLP -> vx telemetry records. The inverse of `@vzn/vx-otel`'s encoder.
//
// This is what makes the OTel wire a real ingest path rather than a one-way
// export: `@vzn/vx-otel` writes a run as OTLP, and this reads it back into the
// exact `RunSummaryRecord` / `TaskLogBundle` the native `/v1/ingest` endpoints
// already take, so both wires converge on ONE store, ONE set of read queries,
// and no second schema. It also means the standard wire is enough on its own:
// anyone can point a collector here, or write their own receiver against the
// same attributes and build their own analytics.
//
// The attribute keys are duplicated here rather than imported, because cloud
// does not depend on the exporter at runtime and a receiver that could only be
// written by importing the exporter would not be much of a public wire. The
// copy is safe because it is DIFFERENTIALLY guarded: tests/otlp-ingest.test.ts
// drives the real encoder and asserts this decode reproduces the original
// record, so a renamed key fails there rather than silently dropping a field
// in production.

import { assembleRunSummary, deriveCacheSource, LOG_WIRE_VERSION } from '@vzn/vx'
import type {
  OutputFingerprint,
  RunContextRecord,
  RunSummaryRecord,
  TaskLogBundle,
  TaskLogEntry,
  TaskStatus,
  TaskTelemetry,
  VerifyVerdict,
} from '@vzn/vx'

/** The telemetry contract version this receiver reads. */
export const OTLP_TELEMETRY_SCHEMA = 2

/** Mirror of `@vzn/vx-otel`'s VX_ATTR plus the semconv keys it reuses. */
const A = {
  runId: 'cicd.pipeline.run.id',
  taskName: 'cicd.pipeline.task.name',
  taskResult: 'cicd.pipeline.task.run.result',
  headRevision: 'vcs.ref.head.revision',
  headName: 'vcs.ref.head.name',
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
  runStartedAt: 'vx.run.started_at',
  runEndedAt: 'vx.run.ended_at',
  runDurationMs: 'vx.run.duration_ms',
  runExitOk: 'vx.run.exit_ok',
  taskProject: 'vx.task.project',
  taskTask: 'vx.task.task',
  taskExitCode: 'vx.task.exit_code',
  taskDurationMs: 'vx.task.duration_ms',
  taskHash: 'vx.task.hash',
  cpuMs: 'vx.cpu_ms',
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
  logCharsFull: 'vx.log.chars_full',
  logTruncatedHead: 'vx.log.truncated_head',
  logStatus: 'vx.log.status',
} as const

const RUN_SPAN = 'vx.run'
const TASK_SPAN = 'vx.task'

/** An OTLP `AnyValue` reduced to what vx puts in one. `intValue` stays a
 *  STRING: it is OTLP's int64 encoding, and a nanosecond offset routed through
 *  a JS number would round. */
type Scalar = { s: string } | { i: string } | { b: boolean } | { d: number }

type Attrs = ReadonlyMap<string, Scalar>

function scalarOf(value: unknown): Scalar | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['stringValue'] === 'string') return { s: v['stringValue'] }
  // A JSON producer may emit int64 as a number when it fits; normalize.
  if (typeof v['intValue'] === 'string') return { i: v['intValue'] }
  if (typeof v['intValue'] === 'number') return { i: String(Math.trunc(v['intValue'])) }
  if (typeof v['boolValue'] === 'boolean') return { b: v['boolValue'] }
  if (typeof v['doubleValue'] === 'number') return { d: v['doubleValue'] }
  return undefined
}

function attrsOf(list: unknown): Attrs {
  const out = new Map<string, Scalar>()
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const kv = item as Record<string, unknown>
    if (typeof kv['key'] !== 'string') continue
    const s = scalarOf(kv['value'])
    if (s !== undefined) out.set(kv['key'], s)
  }
  return out
}

function str(a: Attrs, key: string): string | undefined {
  const v = a.get(key)
  return v !== undefined && 's' in v ? v.s : undefined
}
function i64(a: Attrs, key: string): string | undefined {
  const v = a.get(key)
  return v !== undefined && 'i' in v ? v.i : undefined
}
function num(a: Attrs, key: string): number | undefined {
  const v = a.get(key)
  if (v === undefined) return undefined
  if ('i' in v) {
    const n = Number(v.i)
    return Number.isFinite(n) ? n : undefined
  }
  if ('d' in v) return v.d
  return undefined
}
function bool(a: Attrs, key: string): boolean | undefined {
  const v = a.get(key)
  return v !== undefined && 'b' in v ? v.b : undefined
}

interface RawSpan {
  name: string
  attrs: Attrs
}

function spansOf(body: unknown): RawSpan[] {
  const out: RawSpan[] = []
  const rs = (body as { resourceSpans?: unknown } | null)?.resourceSpans
  if (!Array.isArray(rs)) return out
  for (const r of rs) {
    const ss = (r as { scopeSpans?: unknown }).scopeSpans
    if (!Array.isArray(ss)) continue
    for (const scope of ss) {
      const spans = (scope as { spans?: unknown }).spans
      if (!Array.isArray(spans)) continue
      for (const sp of spans) {
        const s = sp as Record<string, unknown>
        if (typeof s['name'] !== 'string') continue
        out.push({ name: s['name'], attrs: attrsOf(s['attributes']) })
      }
    }
  }
  return out
}

/** Statuses a span may legally claim. An unknown one drops the task rather
 *  than coercing it: storing a status the read layer has never heard of is how
 *  a run comes to render as neither passing nor failing. */
const STATUSES = new Set<string>([
  'success',
  'failed',
  'skipped',
  'aborted',
  'cache-hit',
  'cache-hit-remote',
])

function decodePathList(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Rebuild the verify verdict. A switch on `kind` rather than a passthrough so
 * a variant this build has never heard of is dropped instead of stored as a
 * verdict the read layer cannot classify.
 */
function decodeVerify(a: Attrs): VerifyVerdict | undefined {
  const kind = str(a, A.taskVerify)
  switch (kind) {
    case 'nondeterministic':
      return { kind, changed: decodePathList(str(a, A.taskVerifyChanged)) }
    case 'allowed-nondeterministic':
      return { kind, changed: decodePathList(str(a, A.taskVerifyChanged)) }
    case 'undeclared-inputs':
      return { kind, paths: decodePathList(str(a, A.taskVerifyUndeclared)) }
    case 'rerun-failed':
      return { kind, exitCode: num(a, A.taskVerifyExitCode) ?? 1 }
    case 'proven-deterministic':
    case 'proven-complete':
    case 'no-outputs':
    case 'not-verified':
      return { kind }
    default:
      return undefined
  }
}

function decodeFingerprint(a: Attrs): OutputFingerprint | undefined {
  const tree = str(a, A.fpTree)
  if (tree === undefined) return undefined
  const fp: { tree: string; fileCount: number; files?: [string, string][]; truncated?: boolean } = {
    tree,
    fileCount: num(a, A.fpFileCount) ?? 0,
  }
  const rawFiles = str(a, A.fpFiles)
  if (rawFiles !== undefined && rawFiles !== '[]') {
    try {
      const parsed: unknown = JSON.parse(rawFiles)
      if (Array.isArray(parsed)) {
        const files = parsed.filter(
          (p): p is [string, string] =>
            Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string',
        )
        if (files.length > 0) fp.files = files
      }
    } catch {
      // A collector with an attribute-value limit truncates this one first.
      // Detection keys on `tree`, so a mangled file map costs the diff its
      // detail and nothing else: never the verdict, and never the run.
    }
  }
  if (bool(a, A.fpTruncated) === true) fp.truncated = true
  return fp
}

function decodeTask(a: Attrs): TaskTelemetry | undefined {
  const taskId = str(a, A.taskName)
  const project = str(a, A.taskProject)
  const task = str(a, A.taskTask)
  const status = str(a, A.taskResult)
  if (
    taskId === undefined ||
    project === undefined ||
    task === undefined ||
    status === undefined ||
    !STATUSES.has(status)
  ) {
    return undefined
  }
  const t: TaskTelemetry = {
    taskId,
    project,
    task,
    status: status as TaskStatus,
    // Derived from the status, not read off the wire: core owns that mapping,
    // and a producer that disagreed with it would put a row in the store whose
    // cache_hit flag contradicts its own status.
    cacheSource: deriveCacheSource(status as TaskStatus),
    exitCode: num(a, A.taskExitCode) ?? 0,
    durationMs: num(a, A.taskDurationMs) ?? 0,
  }
  const hash = str(a, A.taskHash)
  if (hash !== undefined) t.hash = hash
  const cpuMs = num(a, A.cpuMs)
  if (cpuMs !== undefined) t.cpuMs = cpuMs
  const rss = num(a, A.peakRssBytes)
  if (rss !== undefined) t.peakRssBytes = rss
  const attempts = num(a, A.taskAttempts)
  if (attempts !== undefined) t.attempts = attempts
  const startNs = i64(a, A.wallclockStartNs)
  if (startNs !== undefined) t.wallclockStartNs = startNs
  const endNs = i64(a, A.wallclockEndNs)
  if (endNs !== undefined) t.wallclockEndNs = endNs
  const verify = decodeVerify(a)
  if (verify !== undefined) t.verify = verify
  const fp = decodeFingerprint(a)
  if (fp !== undefined) t.outputFp = fp
  return t
}

function decodeRunContext(a: Attrs): RunContextRecord | undefined {
  const runId = str(a, A.runId)
  const workspaceId = str(a, A.workspaceId)
  if (runId === undefined || runId === '' || workspaceId === undefined) return undefined
  const requested = str(a, A.requestedTasks)
  const flow = str(a, A.flow)
  const tags: Record<string, string> = {}
  for (const [k, v] of a) {
    if (k.startsWith(A.tagPrefix) && 's' in v) tags[k.slice(A.tagPrefix.length)] = v.s
  }
  return {
    runId,
    vxVersion: str(a, A.version) ?? '0.0.0',
    command: str(a, A.command) ?? '',
    requestedTasks: requested === undefined || requested === '' ? [] : requested.split(','),
    cachePolicy: str(a, A.cachePolicy) ?? '',
    concurrency: num(a, A.concurrency) ?? 0,
    flow: flow === 'focused' || flow === 'broad' ? flow : null,
    workspaceId,
    workspaceName: str(a, A.workspaceName) ?? workspaceId,
    commitSha: str(a, A.headRevision) ?? null,
    branch: str(a, A.headName) ?? null,
    defaultBranch: str(a, A.defaultBranch) ?? null,
    dirty: bool(a, A.dirty) ?? null,
    ci: bool(a, A.ci) ?? false,
    ciProvider: str(a, A.ciProvider) ?? null,
    host: str(a, A.host) ?? null,
    os: str(a, A.os) ?? '',
    arch: str(a, A.arch) ?? '',
    tags,
  }
}

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Rebuild a run summary from an OTLP trace export.
 *
 * The `vx.run` root span is the run header AND the completeness marker: OTLP
 * batches and may split a run across POSTs, and the root is the span that ends
 * last, so its arrival is what says the run is over. A payload without one is
 * refused rather than stored half-formed.
 *
 * The tallies are RECOMPUTED from the task spans that actually arrived rather
 * than read off the header, via core's `assembleRunSummary` - the same
 * function the native path uses, so a complete trace and a native push produce
 * byte-identical records, and an incomplete one produces a header consistent
 * with the rows it stored instead of a count that outruns them.
 */
export function decodeTraceRequest(body: unknown): DecodeResult<RunSummaryRecord> {
  const spans = spansOf(body)
  if (spans.length === 0) return { ok: false, error: 'no spans in payload' }
  const root = spans.find((s) => s.name === RUN_SPAN)
  if (root === undefined) {
    return { ok: false, error: `no ${RUN_SPAN} span: a partial or non-vx trace` }
  }
  const schema = num(root.attrs, A.schema)
  if (schema === undefined) {
    return { ok: false, error: `missing ${A.schema}: not a vx trace` }
  }
  if (schema !== OTLP_TELEMETRY_SCHEMA) {
    const got = String(schema)
    const want = String(OTLP_TELEMETRY_SCHEMA)
    return { ok: false, error: `telemetry schema mismatch: trace v${got}, serve v${want}` }
  }
  const run = decodeRunContext(root.attrs)
  if (run === undefined) {
    return { ok: false, error: `${RUN_SPAN} span is missing a run id or workspace id` }
  }
  const tasks: TaskTelemetry[] = []
  for (const s of spans) {
    if (s.name !== TASK_SPAN) continue
    const t = decodeTask(s.attrs)
    if (t !== undefined) tasks.push(t)
  }
  const startedAt = num(root.attrs, A.runStartedAt) ?? 0
  const endedAt = num(root.attrs, A.runEndedAt) ?? startedAt
  return {
    ok: true,
    value: assembleRunSummary(run, tasks, {
      startedAt,
      endedAt,
      totalDurationMs: num(root.attrs, A.runDurationMs) ?? Math.max(0, endedAt - startedAt),
      // Absent only when the run died before its summary was assembled; then
      // the tasks that arrived are the only evidence there is.
      exitOk: bool(root.attrs, A.runExitOk) ?? tasks.every((t) => t.status !== 'failed'),
    }),
  }
}

/**
 * Rebuild log bundles from an OTLP logs export. One bundle per (run,
 * workspace): a batching collector may carry several runs in one payload, and
 * ingest routes per run.
 */
export function decodeLogsRequest(body: unknown): DecodeResult<TaskLogBundle[]> {
  const rl = (body as { resourceLogs?: unknown } | null)?.resourceLogs
  if (!Array.isArray(rl)) return { ok: false, error: 'no resourceLogs in payload' }
  const byRun = new Map<string, TaskLogBundle>()
  for (const r of rl) {
    const sl = (r as { scopeLogs?: unknown }).scopeLogs
    if (!Array.isArray(sl)) continue
    for (const scope of sl) {
      const records = (scope as { logRecords?: unknown }).logRecords
      if (!Array.isArray(records)) continue
      for (const rec of records) {
        const lr = rec as Record<string, unknown>
        const a = attrsOf(lr['attributes'])
        const runId = str(a, A.runId)
        const workspaceId = str(a, A.workspaceId)
        const taskId = str(a, A.taskName)
        const status = str(a, A.logStatus)
        if (
          runId === undefined ||
          workspaceId === undefined ||
          taskId === undefined ||
          (status !== 'success' && status !== 'failed')
        ) {
          continue
        }
        const bodyValue = lr['body']
        const content =
          typeof bodyValue === 'object' &&
          bodyValue !== null &&
          typeof (bodyValue as { stringValue?: unknown }).stringValue === 'string'
            ? (bodyValue as { stringValue: string }).stringValue
            : ''
        const entry: TaskLogEntry = {
          taskId,
          status,
          content,
          charsFull: num(a, A.logCharsFull) ?? content.length,
          truncatedHeadChars: num(a, A.logTruncatedHead) ?? 0,
        }
        const hash = str(a, A.taskHash)
        if (hash !== undefined) entry.hash = hash
        const key = `${runId} ${workspaceId}`
        let bundle = byRun.get(key)
        if (bundle === undefined) {
          bundle = { v: LOG_WIRE_VERSION, runId, workspaceId, tasks: [] }
          byRun.set(key, bundle)
        }
        bundle.tasks.push(entry)
      }
    }
  }
  if (byRun.size === 0) return { ok: false, error: 'no vx log records in payload' }
  return { ok: true, value: [...byRun.values()] }
}
