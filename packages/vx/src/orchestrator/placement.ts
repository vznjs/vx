// Where each task runs: the placement of a graph over the resolved
// executors, and the plan-mode view of it. Split from run.ts on 2026-09-10
// (pure motion). A task is pinned to this machine when it is persistent,
// depends on a persistent task, or says `exec.remote: false`; everything
// else asks the executors in declaration order, and the local floor takes
// what nothing claimed.

import { selectExecutor, type TaskExecutor } from '../exec/index.js'
import { isGroupTask, type TaskNode } from '../graph/index.js'
import { resolveDownloadModes } from './download-policy.js'
import type { Logger } from './logger.js'
import { resolveExecutors } from './plugin-host.js'
import type { prepareRun } from './prepare.js'

/**
 * A task is pinned to this machine when it is persistent, transitively
 * depends on a persistent task (a worker cannot reach a port on the
 * submitter), or declares `exec.remote: false`.
 */
export function pinnedLocalSet(nodes: Map<string, TaskNode>): Set<string> {
  const pinned = new Set<string>()
  const memo = new Map<string, boolean>()
  const visit = (id: string): boolean => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const node = nodes.get(id)
    if (node === undefined) return false
    memo.set(id, false) // cycle guard; the graph builder already rejects cycles
    const result =
      node.config.exec?.persistent !== undefined ||
      node.config.exec?.remote === false ||
      node.deps.some((d) => visit(d))
    memo.set(id, result)
    if (result) pinned.add(id)
    return result
  }
  for (const id of nodes.keys()) visit(id)
  return pinned
}

export interface Placements {
  executors: Map<string, TaskExecutor>
  /**
   * `exec.remote: 'only'` tasks that no REMOTE executor took — a NO-OP on
   * this machine: never executed, declared outputs never cleaned or
   * restored. The task exists to produce a remote input tree; without a
   * remote pool, dependents use the machine's ambient state exactly as they
   * did before the field existed.
   */
  remoteOnlyNoop: Set<string>
  /** `'only'` tasks a remote executor DID take — executed remotely, outputs stay remote. */
  remoteOnly: Set<string>
}

export function placeTasks(
  nodes: Map<string, TaskNode>,
  executors: readonly TaskExecutor[],
  pinAllLocal = false,
): Placements {
  const pinned = pinnedLocalSet(nodes)
  const placements: Placements = {
    executors: new Map(),
    remoteOnlyNoop: new Set(),
    remoteOnly: new Set(),
  }
  for (const node of nodes.values()) {
    if (isGroupTask(node) || node.config.exec?.persistent !== undefined) continue
    const executor = selectExecutor(executors, {
      taskId: node.id,
      projectName: node.projectName,
      projectDir: node.projectDir,
      command: node.config.exec!.command,
      pinnedLocal: pinAllLocal || pinned.has(node.id),
      cacheable: node.config.cache !== undefined,
    })
    placements.executors.set(node.id, executor)
    if (node.config.exec?.remote === 'only') {
      // A pinned 'only' task (it transitively depends on a persistent one)
      // lands here too: pinning wins, so it noops rather than shipping.
      if (executor.remote === true) placements.remoteOnly.add(node.id)
      else placements.remoteOnlyNoop.add(node.id)
    }
  }
  return placements
}

/**
 * `executorOf` for `planRun`, or nothing. Declining plugins, a single
 * executor, or a resolution error all yield nothing: `--dry` is an
 * inspection command and must not fail over a label. The error is still
 * said, on the status line, in the plugin's name: the run this plan
 * previews would refuse on it, and a plan that hid that would read as
 * "everything lands locally".
 */
export async function planExecutorOf(
  prepared: Awaited<ReturnType<typeof prepareRun>>,
  log: Logger,
  policy: 'all' | 'toplevel' | 'none',
): Promise<{
  executorOf?: (id: string) => string | undefined
  downloadOf?: (id: string) => 'eager' | 'deferred' | 'never' | undefined
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
}> {
  let executors: readonly TaskExecutor[]
  try {
    executors = await resolveExecutors(prepared.plugins, {
      workspaceRoot: prepared.workspaceRoot,
      cacheDir: prepared.cacheDir,
      warn: (m: string) => log.status(m),
      concurrency: Math.max(1, navigator.hardwareConcurrency),
    })
  } catch (err) {
    log.status(
      `[vx] placement not shown — ${err instanceof Error ? err.message : String(err)} (the run would refuse on it)`,
    )
    return {}
  }
  const placements = placeTasks(prepared.nodes, executors)
  // Download modes need placement regardless of how many executors there
  // are (a single REMOTE one still defers); executor LABELS only earn their
  // column when there is a choice to report.
  const download =
    policy === 'all'
      ? undefined
      : resolveDownloadModes({
          nodes: prepared.nodes,
          policy,
          localPlaced: new Set(
            [...prepared.nodes.keys()].filter(
              (id) => placements.executors.get(id)?.remote !== true,
            ),
          ),
          remoteOnly: placements.remoteOnly,
        })
  return {
    ...(executors.length < 2
      ? {}
      : {
          executorOf: (id: string) =>
            placements.remoteOnlyNoop.has(id) ? 'noop' : placements.executors.get(id)?.name,
        }),
    ...(download === undefined
      ? {}
      : {
          downloadOf: (id: string) => download.modeOf.get(id),
          downloadDowngrades: [...download.downgrades].map(([taskId, reason]) => ({
            taskId,
            reason,
          })),
        }),
  }
}

/**
 * Stands in for the executor of a task that was never placed — a group task
 * (runs nothing) or a persistent one (`executePersistentTask` owns it and
 * never reads this field). It THROWS rather than silently picking some
 * executor from the list, so a refactor that routes such a task through the
 * exec path fails loudly instead of shipping a localhost server to a worker.
 */
export const UNPLACED_EXECUTOR: TaskExecutor = {
  name: 'unplaced',
  execute: (req) => {
    throw new Error(`internal error: ${req.taskId} reached an executor without being placed`)
  },
}

export function hasPooledExecutor(executors: readonly TaskExecutor[]): boolean {
  return executors.some((e) => e.capacity !== undefined)
}

export function poolOfPlacement(
  placements: Placements,
): (id: string) => { name: string; capacity: number } | undefined {
  return (id) => {
    const executor = placements.executors.get(id)
    return executor?.capacity === undefined
      ? undefined
      : { name: executor.name, capacity: executor.capacity }
  }
}
