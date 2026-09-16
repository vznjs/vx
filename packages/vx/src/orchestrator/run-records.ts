// What a finished run leaves behind: the `runs` rows, the `invocations`
// header row, and — only when a telemetry sink is active — the per-task
// telemetry mirror. One pass over the outcome list builds all three, so
// `invocations.task_count`, the terminal's "N total" and the number of
// telemetry tasks are the same count by construction (`tallyOutcomes`
// applies the same group/aborted filter).

import type { InvocationRecord, RunRecord } from '../cache/index.js'
import { isGroupTask, type TaskOutcome } from '../graph/index.js'
import { VERSION } from '../version.js'
import type { CiContext, GitContext, HostContext } from './run-context.js'
import { deriveCacheSource, isCacheHit, type TaskTelemetry } from './telemetry.js'

export interface RunRecordsInput {
  outcomes: readonly TaskOutcome[]
  runId: string
  /** Wall-clock ms at run start; every per-task ns offset is anchored to it. */
  startedAtMs: number
  endedAtMs: number
  totalMs: number
  ok: boolean
  command: string
  requestedTasks: readonly string[]
  /** Already compacted (`compactCachePolicy`), the form the header row stores. */
  cachePolicy: string
  concurrency: number
  flow: InvocationRecord['flow']
  forwardArgs?: readonly string[] | undefined
  tags: Record<string, string>
  git: GitContext
  ci: CiContext
  host: HostContext
  /** Build the telemetry mirror; a run with no sink allocates none. */
  withTelemetry: boolean
}

export interface RunRecords {
  runs: RunRecord[]
  invocation: InvocationRecord
  telemetryTasks: TaskTelemetry[]
}

/**
 * Every non-group, non-aborted outcome gets a row. An outcome with NO hash
 * (a `skipped` task never probed the cache; a `persistent` one is never
 * cacheable) used to be dropped because `runs.hash` is NOT NULL — which
 * made a failing persistent task record `0 tasks, 0 failures` on a run the
 * terminal called red, and a failed task with a skipped dependent record
 * 1 of 2. `bindRun` stores `''` for those instead; the key-diff readers
 * guard it.
 */
export function assembleRunRecords(input: RunRecordsInput): RunRecords {
  const { outcomes, runId, startedAtMs, endedAtMs } = input
  const runs: RunRecord[] = []
  const telemetryTasks: TaskTelemetry[] = []
  let failedCount = 0
  let hitLocalCount = 0
  let hitRemoteCount = 0
  for (const o of outcomes) {
    if (isGroupTask(o.node)) continue
    // aborted (killed by a shutdown signal) isn't a real run.
    if (o.status === 'aborted') continue
    if (input.withTelemetry) telemetryTasks.push(telemetryOf(o))
    runs.push({
      ...(o.hash !== undefined ? { hash: o.hash } : {}),
      project: o.node.projectName,
      task: o.node.taskName,
      status: o.status,
      exitCode: o.exitCode,
      durationMs: o.durationMs,
      ...(input.forwardArgs !== undefined ? { forwardArgs: input.forwardArgs } : {}),
      // Anchor to the REAL per-task wall-clock window: run-start wall time +
      // the task's ns offset (captured for hits and executed tasks alike).
      // The `end - duration` fallback applies to outcomes without an offset —
      // today only `skipped`, which the scheduler finishes synchronously with
      // no span, so it collapses to a zero-width mark at the run's end. Using
      // run-end-minus-duration for EVERYTHING was the old bug that piled every
      // task at the right edge of the timeline.
      startedAt:
        o.wallclockStartNs !== undefined
          ? startedAtMs + Math.round(Number(o.wallclockStartNs) / 1e6)
          : endedAtMs - o.durationMs,
      endedAt:
        o.wallclockEndNs !== undefined
          ? startedAtMs + Math.round(Number(o.wallclockEndNs) / 1e6)
          : endedAtMs,
      runId,
      ...(o.cpuMs !== undefined ? { cpuMs: o.cpuMs } : {}),
      ...(o.peakRssBytes !== undefined ? { peakRssBytes: o.peakRssBytes } : {}),
      ...(o.wallclockStartNs !== undefined ? { wallclockStartNs: o.wallclockStartNs } : {}),
      ...(o.wallclockEndNs !== undefined ? { wallclockEndNs: o.wallclockEndNs } : {}),
      cacheHit: isCacheHit(o.status),
      ...(o.attempts !== undefined ? { attempts: o.attempts } : {}),
      cached: o.node.config.cache !== undefined,
      ...(o.blockedBy !== undefined ? { blockedBy: o.blockedBy } : {}),
    })
    if (o.status === 'failed') failedCount++
    if (o.status === 'cache-hit') hitLocalCount++
    if (o.status === 'cache-hit-remote') hitRemoteCount++
  }
  const invocation: InvocationRecord = {
    runId,
    command: input.command,
    requestedTasks: JSON.stringify([...input.requestedTasks]),
    cachePolicy: input.cachePolicy,
    concurrency: input.concurrency,
    flow: input.flow,
    startedAt: startedAtMs,
    endedAt: endedAtMs,
    totalDurationMs: Math.round(input.totalMs),
    taskCount: runs.length,
    failedCount,
    hitCount: hitLocalCount + hitRemoteCount,
    hitLocalCount,
    hitRemoteCount,
    exitOk: input.ok,
    commitSha: input.git.commitSha,
    branch: input.git.branch,
    dirty: input.git.dirty,
    ci: input.ci.ci,
    ciProvider: input.ci.provider,
    host: input.host.host,
    os: input.host.os,
    arch: input.host.arch,
    vxVersion: VERSION,
    tags: JSON.stringify(input.tags),
  }
  return { runs, invocation, telemetryTasks }
}

function telemetryOf(o: TaskOutcome): TaskTelemetry {
  const t: TaskTelemetry = {
    taskId: o.node.id,
    project: o.node.projectName,
    task: o.node.taskName,
    status: o.status,
    cacheSource: deriveCacheSource(o.status),
    exitCode: o.exitCode,
    durationMs: o.durationMs,
  }
  if (o.hash !== undefined) t.hash = o.hash
  if (o.cpuMs !== undefined) t.cpuMs = o.cpuMs
  if (o.peakRssBytes !== undefined) t.peakRssBytes = o.peakRssBytes
  if (o.where !== undefined) t.where = o.where
  if (o.outputs !== undefined) t.outputs = o.outputs
  if (o.attempts !== undefined) t.attempts = o.attempts
  if (o.blockedBy !== undefined) t.blockedBy = o.blockedBy
  if (o.wallclockStartNs !== undefined) t.wallclockStartNs = o.wallclockStartNs.toString()
  if (o.wallclockEndNs !== undefined) t.wallclockEndNs = o.wallclockEndNs.toString()
  return t
}
