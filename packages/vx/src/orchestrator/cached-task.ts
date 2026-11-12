// A task with a command that is not persistent: the common case. Each step
// is its own file with a typed input and output:
//
//   policy    task-policy.ts     what it may do (read, write, plan a save)
//   key       here               its key, taken mid-run
//   probe     here               a hit restored, or a miss
//   describe  miss-inputs.ts     the miss's input set, once
//   attempts  attempts.ts        the retry loop over attempt.ts
//   recheck   input-recheck.ts   do the key's inputs still hold
//   save      task-save.ts       the one save verdict, carried out
//   outcome   miss-outcome.ts    what it all adds up to

import { ArtifactVanishedError, type CacheEntry, FULL_CACHE_POLICY } from '../cache/index.js'
import { signalExitCode } from '../exec/index.js'
import { RestoreDemoted, RestoreFailed, type TaskOutcome } from '../graph/index.js'
import { span } from '../util/index.js'
import { warnOf } from '../report/index.js'
import type { ExecuteArgs } from './execute-task.js'
import { AttemptSignal } from './attempt-signal.js'
import { AttemptStream } from './attempt-stream.js'
import { OutputGuard } from './attempt-outputs.js'
import { runAttempts } from './attempts.js'
import { restoreHit } from './hit-restore.js'
import { fingerprintMoved, type KeyCheck, type StateStamp } from './input-recheck.js'
import { describeMiss } from './miss-inputs.js'
import { missOutcome } from './miss-outcome.js'
import type { MissRun } from './miss-run.js'
import { getContext } from './remote-prefetch.js'
import { forwardedSignal } from './signals.js'
import { computeTaskHash, keyOf } from './task-hash.js'
import { type TaskPolicy, taskPolicy } from './task-policy.js'
import { isAborted, taskEnv } from './task-process.js'
import { applySave, saveVerdict } from './task-save.js'
import { stampUndeclaredState } from './undeclared-state.js'

/** Whether this task reads the cache: a cached, not remote-only task with a read axis on. */
export function readsCache(args: ExecuteArgs): boolean {
  const policy = args.run.cachePolicy ?? FULL_CACHE_POLICY
  return (
    args.remoteOnly !== true &&
    args.node.config.cache === true &&
    (policy.localRead || policy.remoteRead)
  )
}

/**
 * Restore the up-front probe's hit, or demote it. A key taken before a task
 * rewrote the lockfile names an install the tree no longer holds, and the
 * lazy path never probes one: demoted like a vanished hit, it runs
 * dep-gated. The hit may be restoring AHEAD of this task's deps, and a
 * command run now would build from outputs they have not written yet and
 * save that under the good key: the scheduler runs it again once they are
 * done (admission drops the probe).
 */
export async function restoreProbed(
  args: ExecuteArgs,
  hash: string,
  hit: CacheEntry,
  taskStartNs: bigint,
): Promise<TaskOutcome> {
  const cacheOpStart = performance.now()
  const restored = fingerprintMoved(args)
    ? null
    : await restoreOrMiss(args, hash, hit, cacheOpStart, taskStartNs)
  if (restored !== null) return restored
  throw new RestoreDemoted(args.node.id)
}

/**
 * A hit restored, or null when its artifact was removed after the probe (a
 * `vx cache clean`, here or for a workspace sharing the cache directory): a
 * miss. The restore has wiped the declared outputs by then; the run path
 * cleans them again and the task writes them. Any other throw fails the
 * task as a failed restore (`RestoreFailed`), never as a miss.
 */
async function restoreOrMiss(
  args: ExecuteArgs,
  hash: string,
  hit: CacheEntry,
  cacheOpStart: number,
  taskStartNs: bigint,
): Promise<TaskOutcome | null> {
  try {
    return await restoreHit({ args, hash, hit, cacheOpStart, taskStartNs })
  } catch (err) {
    if (!(err instanceof ArtifactVanishedError)) throw new RestoreFailed(err)
    warnOf(args.log)(`[vx] ${args.node.id}: ${err.message} — running it`)
    return null
  }
}

export async function executeCachedTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node } = args
  const policy = taskPolicy(args)
  // When the task started, as an offset from run start, for EVERY outcome
  // (hits included), so the timeline shows when each task actually ran.
  const taskStartNs = process.hrtime.bigint() - args.run.runStartHrTimeNs
  const hash = await keyFor(args)

  // The local no-op half of `exec.remote: 'only'`: no remote executor took
  // the task, so it succeeds without running. The hash was still computed:
  // dependents fold it.
  if (args.remoteOnlyNoop === true) {
    return {
      node,
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      hash,
      wallclockStartNs: taskStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
    }
  }

  const hit = await probe(args, policy, hash, taskStartNs)
  if (hit !== null) return hit

  const env = taskEnv(node, policy.exec, args.run.workspaceRoot)
  const wallclockStartNs = process.hrtime.bigint() - args.run.runStartHrTimeNs
  const { inputs, secrets } = await describeMiss(args, policy, env)

  const fetched = await fetchDeferredUpstream(args, hash, taskStartNs)
  if (fetched !== undefined) return fetched

  const m: MissRun = {
    args,
    policy,
    hash,
    inputs,
    env,
    secrets,
    storedCommand: secrets.text(policy.exec.command),
    stream: new AttemptStream(node, args.log),
    signal: new AttemptSignal(args, policy.timeout),
    guard: new OutputGuard(args, policy),
    sandbox: {
      violations: [],
      placeholders: [],
      withheld: [],
      upstreamOutputs: [],
      writes: undefined,
    },
    load: {},
    attempt: 0,
  }
  // A stop that landed during the awaits above (the key, the probe, the
  // input description): the first attempt would wipe the last build and
  // hand the executor a request after the run had stopped.
  if (isAborted(args.run.stopSignal)) {
    return {
      node,
      status: 'aborted',
      exitCode: signalExitCode(forwardedSignal(args.run.stopSignal?.reason)),
      durationMs: 0,
      hash,
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
    }
  }
  const stamp = stampState(m)
  const ran = await runAttempts(m, wallclockStartNs)
  if ('outcome' in ran) return ran.outcome
  const wallclockEndNs = process.hrtime.bigint() - args.run.runStartHrTimeNs
  const check: KeyCheck = { unkeyed: false }
  const verdict = await saveVerdict(m, ran, check, stamp)
  const save = await applySave(m, ran, verdict, check, stamp)
  return missOutcome(m, ran, check, save, { startNs: wallclockStartNs, endNs: wallclockEndNs })
}

/**
 * The key, taken mid-run, not at prepare time: a task whose `inputs.files`
 * matches a sibling's outputs (`'**\/*'` after a `codegen` step) needs those
 * on disk first. Taken WITHOUT capture, so a warm all-hit run allocates no
 * component array; a miss's rows are captured by the describe. An up-front
 * key is used verbatim: a restore-tier task may run before its deps finish,
 * so its live `upstream` is incomplete.
 */
async function keyFor(args: ExecuteArgs): Promise<string> {
  return (
    args.preProbed?.hash ??
    args.upfrontKey ??
    (await keyOf(
      computeTaskHash({
        node: args.node,
        upstream: args.upstream,
        workspaceRoot: args.run.workspaceRoot,
        cache: args.run.cache,
        forwardArgs: args.run.forwardArgs,
        nestedProjectDirs: args.nestedProjectDirs,
        ...(args.run.gitFilesCache !== undefined ? { gitFilesCache: args.run.gitFilesCache } : {}),
        ...(args.run.hashCache !== undefined ? { hashCache: args.run.hashCache } : {}),
        ...(args.run.probesAfterWrites !== undefined
          ? { probesAfterWrites: args.run.probesAfterWrites }
          : {}),
      }),
    ))
  )
}

/**
 * A hit restored, or null for a miss. An up-front probe is reused: its hit
 * is restored, its null is a confirmed stable miss. No second `cache.get`.
 * The restore is timed as the user sees it (clean, restore, log replay).
 */
async function probe(
  args: ExecuteArgs,
  policy: TaskPolicy,
  hash: string,
  taskStartNs: bigint,
): Promise<TaskOutcome | null> {
  if (!policy.read) return null
  const preProbed = args.preProbed
  if (preProbed !== undefined) {
    return preProbed.hit === null ? null : restoreProbed(args, hash, preProbed.hit, taskStartNs)
  }
  if (fingerprintMoved(args)) return null
  const cacheOpStart = performance.now()
  const endProbe = span('cache.get')
  const hit = await args.run.cache.get(hash, getContext(args.node, policy.exec.command))
  endProbe()
  return hit ? restoreOrMiss(args, hash, hit, cacheOpStart, taskStartNs) : null
}

/**
 * The task runs a command HERE and missed, so what its dependency closure
 * produced has to be on disk: producers left deferred are fetched now, once
 * per run, on this task's own slot, since they are its critical path. A
 * remote-placed task needs nothing: its worker grafts the upstream bytes by
 * reference. The failed outcome when a fetch failed.
 */
async function fetchDeferredUpstream(
  args: ExecuteArgs,
  hash: string,
  taskStartNs: bigint,
): Promise<TaskOutcome | undefined> {
  if (args.executor.remote === true || args.run.deferred === undefined) return undefined
  try {
    await args.run.deferred.materializeFor(args.node)
    return undefined
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Nothing ran: the note is the frame's first line.
    args.log.taskStderr(args.node, `[vx] ${msg}\n`)
    return {
      node: args.node,
      status: 'failed',
      exitCode: 1,
      durationMs: 0,
      hash,
      wallclockStartNs: taskStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
    }
  }
}

/** The undeclared state the command may write and read back, stamped only where a save follows on this disk. */
function stampState(m: MissRun): StateStamp {
  const { args, policy } = m
  const from = Date.now()
  const state =
    policy.save && !policy.deferred && args.executor.remote !== true
      ? stampUndeclaredState({
          config: args.node.config,
          projectDir: args.node.projectDir,
          workspaceRoot: args.run.workspaceRoot,
          nestedProjectDirs: args.nestedProjectDirs,
          gitFilesCache: args.run.gitFilesCache,
          projectTasks: args.run.projectTasks?.(args.node.projectDir) ?? [],
        })
      : undefined
  return { state, from }
}
