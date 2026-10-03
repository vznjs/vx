// Where each task runs: the placement of a graph over the resolved
// executors, and the plan-mode view of it. Split from run.ts on 2026-09-10
// (pure motion). A task is pinned to this machine when it is persistent,
// depends on a persistent task, is sandboxed, says `exec.remote: false`, or
// folds a runtime probe into its key; an `exec.interactive` task goes to the
// local floor directly, as only it can hand over this terminal;
// everything else asks the executors in declaration order, and the local
// floor takes what nothing claimed.

import { machineParallelism, UserError } from '../util/index.js'
import { isLocalExecutor, selectExecutor, type TaskExecutor } from '../exec/index.js'
import { isGroupTask, type TaskNode } from '../graph/index.js'
import { resolveDownloadModes } from './download-policy.js'
import type { Logger } from './logger.js'
import { executorLabel, resolveExecutors } from './plugin-host.js'
import type { prepareRun } from './prepare.js'

/**
 * A task is pinned to this machine when it is persistent, transitively
 * depends on a persistent task (a worker cannot reach a port on the
 * submitter), declares `exec.sandbox` (the sandbox is this machine's
 * machinery — a worker has none of it, and a boundary "verified" where it
 * is not enforced passes vacuously), or declares `exec.remote: false`. A
 * dependant of a pinned task is pinned with it. A task whose key folds a
 * runtime probe is pinned alone (`withProbedRuntime`).
 */
export function pinnedLocalSet(nodes: Map<string, TaskNode>): Set<string> {
  const pinned = new Set<string>()
  for (const node of nodes.values()) {
    if (
      node.config.exec?.persistent !== undefined ||
      node.config.exec?.sandbox !== undefined ||
      node.config.exec?.remote === false
    ) {
      pinned.add(node.id)
    }
  }
  if (pinned.size === 0) return withProbedRuntime(nodes, pinned)
  // Pinning flows up the dependant edges from what pins itself, one walk on
  // an explicit stack: a chain is as deep as the graph, and a recursion
  // per edge threw `RangeError` on the 50,000 the builder takes (item 737).
  const dependants = new Map<string, string[]>()
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      const list = dependants.get(dep)
      if (list === undefined) dependants.set(dep, [node.id])
      else list.push(node.id)
    }
  }
  const stack = [...pinned]
  while (stack.length > 0) {
    for (const up of dependants.get(stack.pop()!) ?? []) {
      if (pinned.has(up)) continue
      pinned.add(up)
      stack.push(up)
    }
  }
  return withProbedRuntime(nodes, pinned)
}

/**
 * A key that folds `cache.inputs.runtime` / `workspaceRuntime` holds what
 * THIS machine answered (`node -v`); a worker runs its own runtime, which no
 * executor can prove equal, and its output saved under this key is a stale
 * hit here (C-2). Such a task runs here. Its dependants are not pinned with
 * it: they fold the probe through its input key, and their own output does
 * not depend on this machine's runtime.
 */
function withProbedRuntime(nodes: Map<string, TaskNode>, pinned: Set<string>): Set<string> {
  for (const node of nodes.values()) {
    const inputs = node.config.cache?.inputs
    if ((inputs?.runtime?.length ?? 0) > 0 || (inputs?.workspaceRuntime?.length ?? 0) > 0) {
      pinned.add(node.id)
    }
  }
  return pinned
}

/**
 * The tasks that hold the terminal in a run on one: every
 * `exec.interactive` task when vx's stdin is a TTY, none otherwise. A
 * persistent one holds it until the run ends, so a run may have one, and
 * every other interactive task must run before it (a dependency); anything
 * else would have two tasks reading the same keys. Refused before any task
 * runs.
 */
export function terminalHolders(nodes: Map<string, TaskNode>, tty: boolean): Set<string> {
  const holders = new Set<string>()
  if (!tty) return holders
  for (const node of nodes.values()) {
    if (node.config.exec?.interactive === true) holders.add(node.id)
  }
  const servers = [...holders].filter((id) => nodes.get(id)!.config.exec!.persistent !== undefined)
  if (servers.length > 1) {
    throw new UserError(
      `${servers.join(' and ')} are persistent and interactive: a server holds the terminal ` +
        `until the run ends, so one run can hold one — run them in separate terminals`,
    )
  }
  if (servers.length === 0) return holders
  const server = servers[0]!
  const before = new Set<string>()
  const stack = [...nodes.get(server)!.deps]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (before.has(id)) continue
    before.add(id)
    stack.push(...nodes.get(id)!.deps)
  }
  const clash = [...holders].filter((id) => id !== server && !before.has(id))
  if (clash.length > 0) {
    throw new UserError(
      `${server} is persistent and interactive, so it holds the terminal until the run ends, ` +
        `and ${clash.join(', ')} would ask for it too: make ${server} depend on ` +
        `${clash.length === 1 ? 'it' : 'them'}, or run ${clash.length === 1 ? 'it' : 'them'} on ` +
        `${clash.length === 1 ? 'its' : 'their'} own`,
    )
  }
  return holders
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

/**
 * The tasks that write IN PLACE — everything not placed on a remote
 * executor. `resolveDownloadModes` reads it as "the outputs are already
 * here", so a task wrongly left out is one vx thinks it must fetch from a
 * CAS that never held it.
 *
 * `remote` is a THREE-state field: `true` (remote), `false` (an explicit
 * local plugin) and undefined — which is core's own local floor, since
 * `localExecutor()` declares no `remote` at all. So the question is "not
 * remote", never "declared local"; asking the latter drops every task on
 * the floor executor, i.e. every task in a workspace with no executor
 * plugin. It lives here, shared, because `run()` and `--dry` each built
 * this set inline from the same predicate and a second copy is how the
 * plan and the run would disagree about what comes home (441, 442, 445).
 */
export function locallyPlaced(placements: Placements, ids: Iterable<string>): Set<string> {
  return new Set([...ids].filter((id) => placements.executors.get(id)?.remote !== true))
}

export function placeTasks(
  nodes: Map<string, TaskNode>,
  executors: readonly TaskExecutor[],
): Placements {
  const pinned = pinnedLocalSet(nodes)
  const placements: Placements = {
    executors: new Map(),
    remoteOnlyNoop: new Set(),
    remoteOnly: new Set(),
  }
  // `resolveExecutors` puts it last in every list.
  const floor = executors.find(isLocalExecutor)!
  for (const node of nodes.values()) {
    if (isGroupTask(node) || node.config.exec?.persistent !== undefined) continue
    if (node.config.exec?.interactive === true) {
      placements.executors.set(node.id, floor)
      continue
    }
    const executor = selectExecutor(
      executors,
      {
        taskId: node.id,
        projectName: node.projectName,
        projectDir: node.projectDir,
        command: node.config.exec!.command,
        pinnedLocal: pinned.has(node.id),
        cacheable: node.config.cache !== undefined,
      },
      executorLabel,
    )
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
 * `executorOf` for `planRun`, or nothing. A remote-only task no remote
 * executor takes is labelled `noop` whatever the executor count: the run
 * does nothing for it, and a plan line without the label promises an
 * execution. Otherwise declining plugins, a single executor, or a
 * resolution error all yield nothing: `--dry` is an
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
      concurrency: machineParallelism(),
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
          localPlaced: locallyPlaced(placements, prepared.nodes.keys()),
          remoteOnly: placements.remoteOnly,
        })
  return {
    ...(executors.length < 2 && placements.remoteOnlyNoop.size === 0
      ? {}
      : {
          executorOf: (id: string) =>
            placements.remoteOnlyNoop.has(id)
              ? 'noop'
              : executors.length < 2
                ? undefined
                : placements.executors.get(id)?.name,
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
