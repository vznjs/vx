// What a finished run leaves behind: the `runs` rows, the `invocations`
// header row, and — only when a telemetry sink is active — the per-task
// telemetry mirror. One pass over the outcome list builds all three, so
// `invocations.task_count` and the number of telemetry tasks agree by
// construction; the terminal's "N total" agrees because `tallyOutcomes`
// applies the same group/aborted filter, a second copy of the rule that
// tests/run-records.test.ts holds to this one.

import type { InvocationRecord, RunRecord } from '../cache/index.js'
import { isGroupTask, taskDefinition, type TaskOutcome } from '../graph/index.js'
import { VERSION } from '../version.js'
import type { CiContext, GitContext, HostContext } from './run-context.js'
import { taskTelemetryOf, type TaskTelemetry } from './telemetry.js'
import { isCacheHit } from '../graph/index.js'

export interface RunRecordsInput {
  outcomes: readonly TaskOutcome[]
  /**
   * Tasks that ran behind a failed dependency (`--continue=always`) or one
   * `--exclude-dependencies` dropped, each with the task at the root of it.
   */
  tainted?: ReadonlyMap<string, string>
  runId: string
  /** Wall-clock ms at run start; every per-task ns offset is anchored to it. */
  startedAtMs: number
  endedAtMs: number
  totalMs: number
  ok: boolean
  command: string
  requestedTasks: readonly string[]
  /** Already formatted (`formatCachePolicy`), the form the header row stores. */
  cachePolicy: string
  concurrency: number
  flow: InvocationRecord['flow']
  forwardArgs?: readonly string[] | undefined
  git: GitContext
  ci: CiContext
  host: HostContext
  /** Build the telemetry mirror; a run with no sink allocates none. */
  withTelemetry: boolean
  /** Each task's count of the tasks and groups downstream of it (the scheduler's): the rows' `blocks`. */
  blocks?: ReadonlyMap<string, number>
  /** The run's remote failures by key, so far (`Cache.traffic`). */
  remoteTraffic?: ReadonlyMap<string, { failures: readonly string[] }>
}

export interface RunRecords {
  runs: RunRecord[]
  invocation: InvocationRecord
  telemetryTasks: TaskTelemetry[]
}

/** A key's remote failures as its `runs` row stores them; none when it met none. */
function remoteErrorOf(
  traffic: ReadonlyMap<string, { failures: readonly string[] }> | undefined,
  hash: string | undefined,
): string | undefined {
  const failures = hash === undefined ? undefined : traffic?.get(hash)?.failures
  return failures === undefined || failures.length === 0 ? undefined : failures.join('; ')
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
  let upToDateCount = 0
  let restoredLocalCount = 0
  let restoredRemoteCount = 0
  for (const o of outcomes) {
    if (isGroupTask(o.node)) continue
    // aborted (killed by a shutdown signal) isn't a real run.
    if (o.status === 'aborted') continue
    if (input.withTelemetry) telemetryTasks.push(taskTelemetryOf(o))
    const blockedBy = o.blockedBy ?? input.tainted?.get(o.node.id)
    const remoteError = remoteErrorOf(input.remoteTraffic, o.hash)
    // Built field by field: a spread per optional field was ~2 µs of each
    // of a 1,200-hit warm run's rows.
    const hit = isCacheHit(o.status)
    const r: RunRecord = {
      project: o.node.projectName,
      task: o.node.taskName,
      status: o.status,
      exitCode: o.exitCode,
      durationMs: o.durationMs,
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
      cacheHit: hit,
      cached: o.node.config.cache !== undefined,
    }
    if (o.hash !== undefined) r.hash = o.hash
    // A run forwards its args to the tasks it was asked for, never to a
    // dependency: the row says which ran with them.
    if (input.forwardArgs !== undefined && input.forwardArgs.length > 0 && o.node.requested)
      r.forwardArgs = input.forwardArgs
    if (o.cpuMs !== undefined) r.cpuMs = o.cpuMs
    if (o.peakRssBytes !== undefined) r.peakRssBytes = o.peakRssBytes
    if (o.peakCores !== undefined) r.peakCores = o.peakCores
    if (o.avgRssBytes !== undefined) r.avgRssBytes = o.avgRssBytes
    if (o.where !== undefined) r.placement = o.where
    if (o.whereCores !== undefined) r.placementCores = o.whereCores
    if (o.whereMemoryBytes !== undefined) r.placementMemoryBytes = o.whereMemoryBytes
    if (o.cpuShare !== undefined) r.cpuShare = o.cpuShare
    if (o.queuedMs !== undefined) r.queuedMs = o.queuedMs
    if (o.outputBytes !== undefined) r.outputBytes = o.outputBytes
    const blocks = input.blocks?.get(o.node.id)
    if (blocks !== undefined) r.blocks = blocks
    if (o.flaky !== undefined) {
      r.flakyPasses = o.flaky.passes
      r.flakyFailures = o.flaky.failures
    }
    if (o.wallclockStartNs !== undefined) r.wallclockStartNs = o.wallclockStartNs
    if (o.wallclockEndNs !== undefined) r.wallclockEndNs = o.wallclockEndNs
    if (hit) r.restored = o.restored === true
    if (o.attempts !== undefined) r.attempts = o.attempts
    // A task that ran behind a failure names it too, so the flakiness
    // projection counts its outcome on no key (failure-mode.ts).
    if (blockedBy !== undefined) r.blockedBy = blockedBy
    if (o.timedOut === true) r.timedOut = true
    if (o.sandboxViolations !== undefined) r.sandboxViolations = o.sandboxViolations
    if (o.notReady !== undefined) r.notReady = o.notReady
    if (remoteError !== undefined) r.remoteError = remoteError
    if (o.keylessBy !== undefined) r.keylessBy = o.keylessBy
    const def = taskDefinition(o.node)
    if (def !== undefined) r.def = def
    runs.push(r)
    if (o.status === 'failed') failedCount++
    if (o.status === 'cache-hit') hitLocalCount++
    if (o.status === 'cache-hit-remote') hitRemoteCount++
    if (isCacheHit(o.status)) {
      if (o.restored !== true) upToDateCount++
      else if (o.status === 'cache-hit') restoredLocalCount++
      else restoredRemoteCount++
    }
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
    upToDateCount,
    restoredLocalCount,
    restoredRemoteCount,
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
  }
  return { runs, invocation, telemetryTasks }
}

/**
 * The remote failures uploads met after the run's rows went in (the uploads
 * drain later): each row whose text is now short of its key's is rewritten.
 */
export function recordLateRemoteErrors(
  cache: {
    readonly traffic: { readonly keys: ReadonlyMap<string, { failures: readonly string[] }> }
    recordRemoteErrors(runId: string, errors: readonly (readonly [string, string])[]): void
  },
  runs: readonly RunRecord[],
  runId: string,
): void {
  const late: [string, string][] = []
  for (const r of runs) {
    const now = remoteErrorOf(cache.traffic.keys, r.hash)
    if (now !== undefined && now !== r.remoteError) late.push([r.hash!, now])
  }
  if (late.length > 0) cache.recordRemoteErrors(runId, late)
}
