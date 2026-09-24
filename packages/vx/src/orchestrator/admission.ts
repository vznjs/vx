// What stands between the scheduler's `execute` callback and executeTask:
// two rules that decide whether a ready task runs NOW and whether its
// result may be SAVED. Neither changes what the task is.
//
// - In-flight dedup: an embedder running concurrent delegated runs in one
//   process (a daemon built on the façade; core ships none) supplies an
//   `inflight` registry; a task whose key
//   a sibling is already computing waits for it and cache-hits on what it
//   saved. A stateless `vx run` passes none and takes the untouched path.
// - Continue-taint: under `continueMode: 'always'` a task runs although an
//   upstream failed. Its key is the healthy one (pure-input hashing) but
//   its bytes are not, so the taint is tracked here and propagates through
//   every success built on it — or a grand-dependent would cache the same
//   partial tree one hop later. Only that mode ever executes a task behind
//   a failure; the other modes skip it, so a default run carries no check.
//   `--exclude-dependencies` seeds the same taint: a task whose key folds a
//   dependency that did not run has bytes nothing vouches for
//   (excluded-keys.ts).
//
// Split from `run.ts` on 2026-09-10 (pure motion).

import type { CachePolicy } from '../cache/index.js'
import { isGroupTask, RestoreDemoted, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { executeTask, type ExecuteArgs } from './execute-task.js'
import type { ShortCircuit } from './local-shortcircuit.js'
import { computeTaskHash, type ComputeHashArgs } from './task-hash.js'

/**
 * Records which tasks ran behind a failure, or on the key of a dependency
 * that did not run (`seeds`), and answers, per task, whether this one does.
 * Disabled (always `false`, nothing recorded) unless the run's
 * `continueMode` is `'always'` or there is a seed.
 */
export function taintTracker(
  continueAlways: boolean,
  seeds: ReadonlySet<string>,
): (node: TaskNode, upstream: TaskOutcome[]) => boolean {
  if (!continueAlways && seeds.size === 0) return () => false
  const tainted = new Set<string>()
  return (node, upstream) => {
    const taint =
      seeds.has(node.id) ||
      upstream.some(
        // A restore-tier task may run before its deps and see holes here;
        // it never saves anyway (a hit restores), so a hole is not taint.
        (u) =>
          u !== undefined &&
          (tainted.has(u.node.id) ||
            (continueAlways &&
              (u.status === 'failed' || u.status === 'aborted' || u.status === 'skipped'))),
      )
    if (taint) tainted.add(node.id)
    return taint
  }
}

export interface AdmissionArgs {
  /** The shared registry, or undefined for a stateless run (no dedup). */
  inflight: Map<string, Promise<void>> | undefined
  policy: CachePolicy
  shortCircuit: ShortCircuit
  /** Everything `computeTaskHash` needs besides the node and its upstream. */
  hashArgs: Omit<ComputeHashArgs, 'node' | 'upstream' | 'nestedProjectDirs'> & {
    nestedDirsByProject: ReadonlyMap<string, string[]>
  }
  /**
   * The run's execute-args builder. `reuseProbe: false` drops the up-front
   * probe: a task joining a sibling must let executeTask probe fresh,
   * because the probe predates the sibling's save.
   */
  buildExecuteArgs: (node: TaskNode, upstream: TaskOutcome[], reuseProbe?: boolean) => ExecuteArgs
}

/** The scheduler's `execute` callback: dedup when it can help, else executeTask. */
export function admitTasks(
  args: AdmissionArgs,
): (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome> {
  const { inflight, policy, shortCircuit, hashArgs, buildExecuteArgs } = args
  // A probed hit whose artifact vanished before its restore is thrown back
  // to the scheduler (`RestoreDemoted`, execute-task.ts), which dispatches
  // the task again once its deps are done. That dispatch probes for itself:
  // the up-front probe answered for an artifact that is gone. The task
  // stays in the restore-tier SET, so it still skips dedup below.
  const dropProbe = (err: unknown): never => {
    if (err instanceof RestoreDemoted) shortCircuit.preProbed.delete(err.taskId)
    throw err
  }
  return async (node, upstream) => {
    // Dedup only helps when the sibling will WRITE the artifact and this
    // task can READ it back — i.e. both axes effectively on.
    const canRead = policy.localRead || policy.remoteRead
    const canWrite = policy.localWrite || policy.remoteWrite
    const cacheable =
      !isGroupTask(node) &&
      node.config.exec?.persistent === undefined &&
      node.config.cache !== undefined &&
      canRead &&
      canWrite
    // A restore-tier task (confirmed local hit, may run before its deps)
    // needs no dedup — it's a restore, not an executor, and its live
    // `upstream` is incomplete, so the dedup hash recompute would be
    // wrong. Route it straight to executeTask, which reuses the up-front
    // probe.
    const restorable = shortCircuit.restoreTier.has(node.id)
    // `!cacheable` is an early-out for bookkeeping, not a guard: measured
    // (item 506), a non-cacheable task never finds a sibling barrier,
    // because the hash folds the taskId and a taskId executes once per
    // run. Removing it reddens nothing and a throw on "a non-cacheable
    // task joined a barrier" never fires across the whole suite. It saves
    // the set/delete, and the wait a joiner would spend before running the
    // task anyway — there is no artifact for it to hit.
    if (inflight === undefined || !cacheable || restorable) {
      return executeTask(buildExecuteArgs(node, upstream)).catch(dropProbe)
    }
    const { nestedDirsByProject, ...rest } = hashArgs
    const hash = await computeTaskHash({
      ...rest,
      node,
      upstream,
      nestedProjectDirs: nestedDirsByProject.get(node.projectName) ?? [],
    })
    const existing = inflight.get(hash)
    if (existing !== undefined) {
      // Join a sibling already computing this exact task: wait, then
      // executeTask cache-hits on the artifact it just saved.
      await existing.catch(() => {})
      return executeTask(buildExecuteArgs(node, upstream, false))
    }
    // Become the executor: register a barrier siblings await. get→set has
    // no await between, so registration is atomic — at most one executor
    // per hash. Released on every exit (success / failure / throw).
    let release!: () => void
    inflight.set(
      hash,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const execArgs = buildExecuteArgs(node, upstream)
    try {
      // `return await`, deliberately: the finally must run after the task
      // settles, not when its promise is handed back.
      return await executeTask(execArgs)
    } catch (err) {
      return dropProbe(err)
    } finally {
      // The barrier lifts when the ENTRY is there, not when the task is:
      // the save runs off the slot (save-lane.ts), and a sibling released
      // before it landed would probe a miss and run the task again. The
      // executor's own return is not held — only the joiners wait.
      const landed = execArgs.deferredSaves?.get(node.id)
      const lift = (): void => {
        execArgs.deferredSaves?.delete(node.id)
        inflight.delete(hash)
        release()
      }
      if (landed !== undefined) void landed.then(lift, lift)
      else lift()
    }
  }
}
