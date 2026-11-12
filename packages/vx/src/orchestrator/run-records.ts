// What a finished run leaves behind, folded from its event stream: the
// `runs` rows, the `invocations` header row, and — only when a telemetry
// sink is active — the per-task telemetry mirror. One pass over the
// outcome list builds all three, so `invocations.task_count` and the
// number of telemetry tasks agree by construction; the terminal's "N
// total" agrees because `tallyOutcomes` applies the same group/aborted
// filter, a second copy of the rule that tests/run-records.test.ts holds
// to this one.

import { type Cache } from '../cache/index.js'
import { type InvocationRecord, type RunRecord, runHistory } from '../history/index.js'
import {
  exitCodeOf,
  isGroupTask,
  taskDefinition,
  type TaskNode,
  type TaskOutcome,
  isCacheHit,
} from '../graph/index.js'
import { VERSION } from '../version.js'
import { notify, thrownMessage } from '../util/index.js'
import type { CiContext, GitContext, HostContext } from './run-context.js'
import { taskTelemetryOf, type TaskTelemetry } from './telemetry.js'
import { neverStarted, type RunEventSubscriber } from '../report/index.js'

/** A run's outcomes as its event stream told them; see {@link foldOutcomes}. */
export interface OutcomeFold {
  /** Every task the graph finished, in the order it finished. */
  readonly outcomes: TaskOutcome[]
  readonly subscriber: RunEventSubscriber
}

/**
 * The run's record of itself, folded from its event stream: each
 * `task:complete` of the graph's own nodes, handed to `each` as it ends.
 * A plugin's `ctx.bus.emit` carries a view or an object of its own, never
 * the graph's node, so it adds no row.
 */
export function foldOutcomes(
  nodes: ReadonlyMap<string, TaskNode>,
  each: ((o: TaskOutcome) => void) | undefined,
): OutcomeFold {
  const outcomes: TaskOutcome[] = []
  return {
    outcomes,
    subscriber: (e) => {
      if (e.kind !== 'task:complete' || nodes.get(e.node.id) !== e.node) return
      outcomes.push(e.outcome)
      if (each === undefined) return
      // The bus would swallow it unsaid: a lost keep or history row is told.
      try {
        each(e.outcome)
      } catch (err) {
        notify({
          kind: 'line',
          tone: 'warn',
          text: `[vx] onFinish observer threw for ${e.node.id}: ${thrownMessage(err)}\n`,
        })
      }
    },
  }
}

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
  /** Outcomes whose rows the history stream already wrote: counted, not written again. */
  landed?: ReadonlySet<TaskOutcome>
}

/** What a task's `runs` row reads besides its outcome. */
export type RunRecordContext = Pick<
  RunRecordsInput,
  'runId' | 'startedAtMs' | 'endedAtMs' | 'forwardArgs' | 'blocks' | 'remoteTraffic'
>

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
 * Every non-group, non-aborted outcome gets a row, one with no hash too (a
 * skip, a server): `bindRun` stores `''` for it, so the counts match the
 * terminal's; the key-diff readers guard it.
 */
export function assembleRunRecords(input: RunRecordsInput): RunRecords {
  const { outcomes, runId, startedAtMs, endedAtMs } = input
  const runs: RunRecord[] = []
  const telemetryTasks: TaskTelemetry[] = []
  let taskCount = 0
  let failedCount = 0
  let hitLocalCount = 0
  let hitRemoteCount = 0
  let upToDateCount = 0
  let restoredLocalCount = 0
  let restoredRemoteCount = 0
  for (const o of outcomes) {
    if (isGroupTask(o.node)) continue
    // aborted (killed by a shutdown signal) isn't a real run. One that
    // started is still in the summary's task list, as the terminal lists it;
    // one the stop reached first is only `notRunCount`.
    if (o.status === 'aborted') {
      if (input.withTelemetry && !neverStarted(o)) telemetryTasks.push(taskTelemetryOf(o))
      continue
    }
    if (input.withTelemetry) telemetryTasks.push(taskTelemetryOf(o))
    taskCount++
    if (input.landed?.has(o) !== true) runs.push(runRecordOf(o as RecordedOutcome, input))
    if (o.status === 'failed') failedCount++
    if (o.status === 'cache-hit') hitLocalCount++
    if (o.status === 'cache-hit-remote') hitRemoteCount++
    if (isCacheHit(o.status)) {
      if (o.cache?.restored !== true) upToDateCount++
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
    taskCount,
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

/** An outcome a `runs` row records: every status but `aborted`. */
export type RecordedOutcome = TaskOutcome & { status: RunRecord['status'] }

/** One outcome's `runs` row. */
export function runRecordOf(o: RecordedOutcome, input: RunRecordContext): RunRecord {
  const { runId, startedAtMs, endedAtMs } = input
  const blockedBy = o.blockedBy ?? o.taintedBy
  const remoteError = remoteErrorOf(input.remoteTraffic, o.hash)
  // Built field by field: a spread per optional field was ~2 µs of each
  // of a 1,200-hit warm run's rows.
  const hit = isCacheHit(o.status)
  const r: RunRecord = {
    project: o.node.projectName,
    task: o.node.taskName,
    status: o.status,
    exitCode: exitCodeOf(o),
    durationMs: o.durationMs,
    // Run-start wall time plus the task's own ns offset. Only a skip has
    // none: a zero-width mark at the run's end.
    startedAt:
      o.timing?.startNs !== undefined
        ? startedAtMs + Math.round(Number(o.timing?.startNs) / 1e6)
        : endedAtMs - o.durationMs,
    endedAt:
      o.timing?.endNs !== undefined
        ? startedAtMs + Math.round(Number(o.timing?.endNs) / 1e6)
        : endedAtMs,
    runId,
    cached: o.node.config.cache === true,
  }
  // A hit whose restore failed is neither: its `cache_hit` stays NULL.
  if (o.restoreFailed !== true) r.cacheHit = hit
  if (o.hash !== undefined) r.hash = o.hash
  // A run forwards its args to the tasks it was asked for, never to a
  // dependency: the row says which ran with them.
  if (input.forwardArgs !== undefined && input.forwardArgs.length > 0 && o.node.requested)
    r.forwardArgs = input.forwardArgs
  if (o.usage?.cpuMs !== undefined) r.cpuMs = o.usage.cpuMs
  if (o.usage?.peakRssBytes !== undefined) r.peakRssBytes = o.usage.peakRssBytes
  if (o.usage?.peakCores !== undefined) r.peakCores = o.usage.peakCores
  if (o.usage?.avgRssBytes !== undefined) r.avgRssBytes = o.usage.avgRssBytes
  if (o.placement?.where !== undefined) r.placement = o.placement.where
  if (o.placement?.cores !== undefined) r.placementCores = o.placement.cores
  if (o.placement?.memoryBytes !== undefined) r.placementMemoryBytes = o.placement.memoryBytes
  if (o.placement?.cpuShare !== undefined) r.cpuShare = o.placement.cpuShare
  if (o.timing?.queuedMs !== undefined) r.queuedMs = o.timing.queuedMs
  if (o.cache?.outputBytes !== undefined) r.outputBytes = o.cache.outputBytes
  const blocks = input.blocks?.get(o.node.id)
  if (blocks !== undefined) r.blocks = blocks
  if (o.attempts?.flaky !== undefined) {
    r.flakyPasses = o.attempts?.flaky.passes
    r.flakyFailures = o.attempts?.flaky.failures
  }
  if (o.timing?.startNs !== undefined) r.wallclockStartNs = o.timing.startNs
  if (o.timing?.endNs !== undefined) r.wallclockEndNs = o.timing.endNs
  if (hit) r.restored = o.cache?.restored === true
  if (o.attempts?.count !== undefined) r.attempts = o.attempts.count
  // A task that ran behind a failure names it too, so the flakiness
  // projection counts its outcome on no key (failure-mode.ts).
  if (blockedBy !== undefined) r.blockedBy = blockedBy
  if (o.timedOut === true) r.timedOut = true
  if (o.sandbox?.violations !== undefined) r.sandboxViolations = o.sandbox.violations
  if (o.notReady !== undefined) r.notReady = o.notReady
  if (remoteError !== undefined) r.remoteError = remoteError
  if (o.cache?.keylessBy !== undefined) r.keylessBy = o.cache.keylessBy
  const def = taskDefinition(o.node)
  if (def !== undefined) r.def = def
  return r
}

/**
 * The remote failures uploads met after the run's rows went in (the uploads
 * drain later): each row whose text is now short of its key's is rewritten.
 */
export function recordLateRemoteErrors(
  cache: Cache,
  runs: readonly RunRecord[],
  runId: string,
): void {
  const late: [string, string][] = []
  for (const r of runs) {
    const now = remoteErrorOf(cache.traffic.keys, r.hash)
    if (now !== undefined && now !== r.remoteError) late.push([r.hash!, now])
  }
  if (late.length > 0) runHistory(cache).recordRemoteErrors(runId, late)
}
