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
//
// Split from `run.ts` on 2026-09-10 (pure motion).

import type { CachePolicy } from '../cache/index.js'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { executeTask, type ExecuteArgs } from './execute-task.js'
import type { ShortCircuit } from './local-shortcircuit.js'
import { computeTaskHash, type ComputeHashArgs } from './task-hash.js'

/**
 * Records which tasks ran behind a failure and answers, per task, whether
 * this one does. Disabled (always `false`, nothing recorded) unless the
 * run's `continueMode` is `'always'`.
 */
export function taintTracker(
  enabled: boolean,
): (node: TaskNode, upstream: TaskOutcome[]) => boolean {
  if (!enabled) return () => false
  const tainted = new Set<string>()
  return (node, upstream) => {
    const taint = upstream.some(
      // A restore-tier task may run before its deps and see holes here;
      // it never saves anyway (a hit restores), so a hole is not taint.
      (u) =>
        u !== undefined &&
        (u.status === 'failed' ||
          u.status === 'aborted' ||
          u.status === 'skipped' ||
          tainted.has(u.node.id)),
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
    if (inflight === undefined || !cacheable || restorable) {
      return executeTask(buildExecuteArgs(node, upstream))
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
