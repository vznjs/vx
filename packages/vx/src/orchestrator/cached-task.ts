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

import path from 'node:path'
import { fsClockNow } from '../memo/index.js'
import {
  ArtifactVanishedError,
  type CacheEntry,
  FULL_CACHE_POLICY,
  type TaskInputComponent,
} from '../cache/index.js'
import { signalExitCode, warmSpares } from '../exec/index.js'
import { RestoreDemoted, RestoreFailed, type TaskOutcome } from '../graph/index.js'
import { span } from '../util/index.js'
import { warnOf } from '../report/index.js'
import { hashArgsOf } from './execute-args.js'
import type { ExecuteArgs } from './execute-task.js'
import { AttemptSignal } from './attempt-signal.js'
import { AttemptStream } from './attempt-stream.js'
import { OutputGuard } from './attempt-outputs.js'
import { upstreamOutputsHere } from './attempt-request.js'
import { runAttempts } from './attempts.js'
import { restoreHit } from './hit-restore.js'
import { fingerprintMoved, type KeyCheck, type StateStamp } from './input-recheck.js'
import { describeMiss, type PreDescribed } from './miss-inputs.js'
import { missOutcome } from './miss-outcome.js'
import { type SaveFacts, withCheckFacts } from './miss-save.js'
import type { MissRun } from './miss-run.js'
import { getContext } from './remote-prefetch.js'
import { forwardedSignal } from './signals.js'
import { computeTaskHash, keyOf, keyOrDescribe } from './task-hash.js'
import { type TaskPolicy, taskPolicy } from './task-policy.js'
import { isLocalExecutor } from './local-executor.js'
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
  // A task that runs may write anywhere (`warmOutputs`).
  args.run.cache.memo.dropWarm?.()
  const policy = taskPolicy(args)
  // When the task started, as an offset from run start, for EVERY outcome
  // (hits included), so the timeline shows when each task actually ran.
  const taskStartNs = process.hrtime.bigint() - args.run.runStartHrTimeNs
  const { hash, pre, got } = await keyFor(args, policy)

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
      timing: { startNs: taskStartNs, endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs },
    }
  }

  const hit = await probe(args, policy, hash, taskStartNs, got)
  if (hit !== null) return hit
  // It will spawn: the first such task starts the spare shells.
  if (isLocalExecutor(args.executor) && node.config.exec?.sandbox === undefined) warmSpares()

  const env = taskEnv(node, policy.exec, args.run.workspaceRoot)
  const wallclockStartNs = process.hrtime.bigint() - args.run.runStartHrTimeNs
  const { inputs, secrets } = await describeMiss(args, policy, env, pre)

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
      timing: {
        startNs: wallclockStartNs,
        endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
      },
    }
  }
  const stamp = stampState(m)
  m.state = stamp.state
  const ran = await runAttempts(m, wallclockStartNs)
  if ('outcome' in ran) return ran.outcome
  const keyedTasks = args.run.keyedTasks
  if (keyedTasks !== undefined) {
    m.endedAt = fsClockNow(args.run.cacheDir ?? path.join(args.run.workspaceRoot, '.vx'))
    const described = inputs.described
    keyedTasks.ran(
      args,
      described === undefined ? undefined : inputs.keyed(described.facts),
      m.endedAt,
    )
  }
  const landed = ran.result.outputs?.kind === 'trailing' ? ran.result.outputs.landed : undefined
  if (landed !== undefined) args.run.trailing?.add(node.id, landed)
  const wallclockEndNs = process.hrtime.bigint() - args.run.runStartHrTimeNs
  const check: KeyCheck = { unkeyed: false }
  const saveBy = async (c: KeyCheck): Promise<{ saved: boolean; unsavedBytes?: number }> =>
    applySave(m, ran, await saveVerdict(m, ran, c, stamp), c, stamp)
  let save: { saved: boolean; unsavedBytes?: number }
  const saves = args.run.deferredSaves
  if (
    landed === undefined &&
    saves !== undefined &&
    policy.save &&
    ran.exitCode === 0 &&
    // A moved input fails the task: decided before it is done.
    policy.stability.severity !== 'error' &&
    // The sandbox's fix reads what the save leaves: built with the outcome.
    !(m.sandbox.listedThere === true && m.sandbox.violations.length > 0)
  ) {
    // The command is done: its slot goes to the next task, and the re-checks
    // and the save run after it. Its dependants still wait for them
    // (`settledOf`); what they find rides the outcome when it settles.
    const settled: Promise<SaveFacts> = new Promise<void>((r) => setImmediate(r)).then(async () => {
      const now = await saveBy(check)
      // A save on the run's lane parked its own settling here.
      const lane = saves.get(node.id)
      const facts: SaveFacts =
        lane !== undefined && lane !== settled ? await lane : now.saved ? { saved: true } : {}
      return withCheckFacts(facts, check, now.unsavedBytes)
    })
    saves.set(node.id, settled)
    save = { saved: false }
  } else if (landed === undefined || !policy.save || ran.exitCode !== 0) save = await saveBy(check)
  else if (
    saves === undefined ||
    // A moved input fails the task: decided before it is done.
    policy.stability.severity === 'error' ||
    (await saveVerdict(m, ran, check, stamp)).kind !== 'save'
  ) {
    // Nothing to save, or no one to settle it later: once its files are here.
    await landed.catch(() => {})
    save = await saveBy(check)
  } else {
    // Its files are still on their way: it is done, its dependants on other
    // machines start (`trailingSaves`), and it is saved from this disk once
    // the files are here, every check a save makes made again then. Files
    // that never come fail the run (`TrailingOutputs.lost`); nothing is saved.
    const settled: Promise<SaveFacts> = landed.then(
      async () => {
        const now = await saveBy({ unkeyed: false })
        // A save on the run's lane parked its own settling here.
        const lane = saves.get(node.id)
        if (lane !== undefined && lane !== settled) return lane
        return now.saved ? { saved: true as const } : {}
      },
      () => ({}),
    )
    saves.set(node.id, settled)
    args.run.trailingSaves?.add(node.id)
    save = { saved: false }
  }
  if (m.sandbox.listedThere === true && m.sandbox.violations.length > 0)
    m.sandbox.upstreamOutputs = await upstreamOutputsHere(m)
  return missOutcome(m, ran, check, save, { startNs: wallclockStartNs, endNs: wallclockEndNs })
}

/** A key taken before the task's dispatch, and when (`KeyedTasks.keyedAt`). */
export interface PreparedKey {
  readonly key: { hash: string; pre?: PreDescribed }
  readonly at: number
  readonly atMs: number
  /** The local-first lookup under it, asked while the task waited. */
  readonly got?: Promise<CacheEntry | null>
}

/**
 * Take a ready task's key while it waits for a slot (`SchedulerOptions.prepare`),
 * for its dispatch to read back: the key and the description it folds were
 * most of what a cold miss did in its slot before its command. Their facts
 * are dated now, so the re-check after the command sees any write since.
 */
export function prepareKey(args: ExecuteArgs): void {
  const prepared = args.run.preparedKeys
  if (prepared === undefined || args.preProbed !== undefined || args.upfrontKey !== undefined)
    return
  const policy = taskPolicy(args)
  if (!policy.cacheable) return
  const at = fsClockNow(args.run.cacheDir ?? path.join(args.run.workspaceRoot, '.vx'))
  const atMs = Date.now()
  const taken = derivedKey(args, policy).then((key): PreparedKey => {
    if (!policy.read) return { key, at, atMs }
    const got = args.run.cache.get(key.hash, getContext(args.node, policy.exec.command))
    got.catch(() => {})
    return { key, at, atMs, got }
  })
  // Read by its dispatch, which rethrows it; a run that stops first never asks.
  taken.catch(() => {})
  prepared.set(args.node.id, taken)
}

/**
 * The key, taken mid-run (once the task is ready: `prepareKey`), not at
 * prepare time: a task whose `inputs.files`
 * matches a sibling's outputs (`'**\/*'` after a `codegen` step) needs those
 * on disk first. Taken WITHOUT capture, so a warm all-hit run allocates no
 * component array; a miss's rows are captured by the describe. An up-front
 * key is used verbatim: a restore-tier task may run before its deps finish,
 * so its live `upstream` is incomplete.
 */
async function keyFor(
  args: ExecuteArgs,
  policy: TaskPolicy,
): Promise<{ hash: string; pre?: PreDescribed; got?: Promise<CacheEntry | null> }> {
  const known = args.preProbed?.hash ?? args.upfrontKey
  if (known !== undefined) return { hash: known }
  const prepared = args.run.preparedKeys?.get(args.node.id)
  if (prepared !== undefined) {
    args.run.preparedKeys!.delete(args.node.id)
    const { key, at, atMs, got } = await prepared
    args.run.keyedTasks?.keyedAt(args, at, atMs)
    return got === undefined ? key : { ...key, got }
  }
  args.run.keyedTasks?.keyedNow(args)
  return derivedKey(args, policy)
}

async function derivedKey(
  args: ExecuteArgs,
  policy: TaskPolicy,
): Promise<{ hash: string; pre?: PreDescribed }> {
  const hashArgs = hashArgsOf(args, true)
  if (!policy.cacheable) return { hash: await keyOf(computeTaskHash(hashArgs)) }
  const captured: TaskInputComponent[] = []
  const { hash, described } = await keyOf(keyOrDescribe({ ...hashArgs, captureInto: captured }))
  return described === undefined ? { hash } : { hash, pre: { described, captured } }
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
  /** A lookup made while the task waited for its slot (`prepareKey`). */
  got?: Promise<CacheEntry | null>,
): Promise<TaskOutcome | null> {
  if (!policy.read) return null
  const preProbed = args.preProbed
  if (preProbed !== undefined) {
    return preProbed.hit === null ? null : restoreProbed(args, hash, preProbed.hit, taskStartNs)
  }
  if (fingerprintMoved(args)) return null
  const cacheOpStart = performance.now()
  const endProbe = span('cache.get')
  const hit = await (got ?? args.run.cache.get(hash, getContext(args.node, policy.exec.command)))
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
  if (args.executor.capabilities?.remote === true) return undefined
  // A command here may read what another machine's task left: once it is here.
  await args.run.trailing?.settle()
  if (args.run.deferred === undefined) return undefined
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
      timing: { startNs: taskStartNs, endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs },
    }
  }
}

/** The undeclared state the command may write and read back, stamped only where a save follows on this disk. */
function stampState(m: MissRun): StateStamp {
  const { args, policy } = m
  const from = Date.now()
  const state =
    policy.save && !policy.deferred && args.executor.capabilities?.remote !== true
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
