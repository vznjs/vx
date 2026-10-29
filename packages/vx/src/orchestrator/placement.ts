// Where each task runs: the placement of a graph over the resolved
// executors, and the plan-mode view of it. Split from run.ts on 2026-09-10
// (pure motion). A task is pinned to this machine when it is persistent,
// depends on a persistent task no `servers` executor carries, is sandboxed, says `exec.remote: false`, or
// folds a runtime probe into its key; an `exec.interactive` task goes to the
// local floor directly, as only it can hand over this terminal;
// everything else asks the executors in declaration order, and the local
// floor takes what nothing claimed. An `exclusive` executor lifts every
// pin and leaves the floor nothing: a task that would land here refuses.

import { machineParallelism, UserError } from '../util/index.js'
import { hostPlatform, isLocalExecutor, selectExecutor, type TaskExecutor } from '../exec/index.js'
import { isGroupTask, type TaskNode } from '../graph/index.js'
import { resolveDownloadModes } from './download-policy.js'
import { type Logger, warnOf } from '../report/index.js'
import { executorLabel, resolveExecutors } from './plugin-host.js'
import type { prepareRun } from './prepare.js'
import { cacheFacts, taskArtifacts } from './task-artifacts.js'

/**
 * A task is pinned to this machine when it is persistent, transitively
 * depends on a persistent task (a worker cannot reach a port on the
 * submitter), declares `exec.sandbox` (the sandbox is this machine's
 * machinery — a worker has none of it, and a boundary "verified" where it
 * is not enforced passes vacuously), or declares `exec.remote: false`. A
 * dependant of a pinned task is pinned with it. A task whose key folds a
 * runtime probe is pinned alone (`withProbedRuntime`). `sandbox: false`
 * leaves `exec.sandbox` out: the set for an executor that enforces it where
 * it runs (`TaskExecutor.sandbox`).
 */
export function pinnedLocalSet(
  nodes: Map<string, TaskNode>,
  sandbox = true,
  /** For a `servers` executor: a carriable persistent task pins nothing. */
  servers = false,
  /** `false` for a `runtime` executor: it checks the probes where it runs the task. */
  runtime = true,
  /** For an `exclusive` executor: it takes what pins elsewhere, servers included. */
  exclusive = false,
): Set<string> {
  const pinned = new Set<string>()
  for (const node of nodes.values()) {
    if (
      (node.config.exec?.persistent !== undefined && !(servers && carriable(node, exclusive))) ||
      (!exclusive &&
        ((sandbox && node.config.exec?.sandbox !== undefined) ||
          node.config.exec?.remote === false))
    ) {
      pinned.add(node.id)
    }
  }
  if (pinned.size === 0) return runtime ? withProbedRuntime(nodes, pinned) : pinned
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
  return runtime ? withProbedRuntime(nodes, pinned) : pinned
}

/**
 * A persistent task a `servers` executor can start where it runs a
 * dependant: one the run holds for its dependants only, with no sandbox
 * (this machine's machinery) and no `exec.remote: false`, which an
 * `exclusive` executor takes all the same.
 */
function carriable(node: TaskNode, exclusive = false): boolean {
  const exec = node.config.exec
  return (
    exec?.persistent !== undefined &&
    !node.requested &&
    node.surfaced !== true &&
    (exclusive ||
      (exec.sandbox === undefined && exec.remote !== false && exec.interactive !== true))
  )
}

/** The persistent tasks `node` depends on through groups and servers, each after its own. */
function serversBehind(nodes: ReadonlyMap<string, TaskNode>, node: TaskNode): TaskNode[] {
  const out: TaskNode[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const dep = nodes.get(id)
    if (dep === undefined) return
    const server = dep.config.exec?.persistent !== undefined
    if (!server && !isGroupTask(dep)) return
    for (const d of dep.deps) visit(d)
    if (server) out.push(dep)
  }
  for (const d of node.deps) visit(d)
  return out
}

/**
 * A key that folds `inputs.runtime` / `workspaceRuntime` holds what
 * THIS machine answered (`node -v`); a worker runs its own runtime, which no
 * executor can prove equal, and its output saved under this key is a stale
 * hit here (C-2). Such a task runs here, or on a `runtime` executor, which
 * fails it where its probes answer otherwise. Its dependants are not pinned with
 * it: they fold the probe through its input key, and their own output does
 * not depend on this machine's runtime.
 */
function withProbedRuntime(nodes: Map<string, TaskNode>, pinned: Set<string>): Set<string> {
  for (const node of nodes.values()) {
    const inputs = node.config.inputs
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
  // One that runs after the server cannot run before it: the advice to make
  // the server depend on it wrote a cycle.
  const after = clash.filter((id) => reaches(nodes, id, server))
  if (after.length > 0) {
    const one = after.length === 1
    throw new UserError(
      `${server} is persistent and interactive, so it holds the terminal until the run ends, ` +
        `and ${after.join(', ')}, which ${one ? 'depends' : 'depend'} on it, would ask for it too: ` +
        `run ${one ? 'it' : 'them'} on ${one ? 'its' : 'their'} own`,
    )
  }
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

/** Does `from` depend on `to`, directly or through others? */
function reaches(nodes: Map<string, TaskNode>, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [...nodes.get(from)!.deps]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(nodes.get(id)?.deps ?? []))
  }
  return false
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
  /** Each task placed on a `servers` executor → the persistent tasks it starts there. */
  servers: Map<string, TaskNode[]>
  /** Persistent tasks every dependant of which carries them: never started here. */
  carried: Set<string>
  /**
   * Tasks whose `exec.platforms` leave out this machine, placed here: the
   * run skips them and their dependants. Each → its platforms.
   */
  otherPlatform: Map<string, readonly string[]>
  /**
   * Of those, the ones an executor that routes by platform could not take:
   * none of its `platforms` is theirs. Each → the platforms on offer.
   */
  unroutable: Map<string, readonly string[]>
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
  // Each executor's pins, computed only when one reads them.
  const pins = new Map<string, Set<string>>()
  const pinsOf = (
    e: Pick<TaskExecutor, 'sandbox' | 'servers' | 'runtime' | 'exclusive'>,
  ): Set<string> => {
    const k = `${e.sandbox === true}${e.servers === true}${e.runtime === true}${e.exclusive === true}`
    let set = pins.get(k)
    if (set === undefined) {
      set = pinnedLocalSet(
        nodes,
        e.sandbox !== true,
        e.servers === true,
        e.runtime !== true,
        e.exclusive === true,
      )
      pins.set(k, set)
    }
    return set
  }
  const placements: Placements = {
    executors: new Map(),
    remoteOnlyNoop: new Set(),
    remoteOnly: new Set(),
    servers: new Map(),
    carried: new Set(),
    otherPlatform: new Map(),
    unroutable: new Map(),
  }
  const host = hostPlatform()
  /** Runs `node` here: on this machine's platform, or skipped if it is not one of its. */
  const here = (node: TaskNode): void => {
    const wants: readonly string[] | undefined = node.config.exec?.platforms
    if (wants === undefined) return
    if (wants.includes(host)) node.platform = host
    else placements.otherPlatform.set(node.id, wants)
  }
  /** Persistent tasks a dependant placed off a `servers` executor needs here. */
  const heldHere = new Set<string>()
  // `resolveExecutors` puts it last in every list.
  const floor = executors.find(isLocalExecutor)!
  // The floor alone takes every task and starts no server: nothing to pin or
  // select. The walks below were 2.8 ms of a 1,200-task warm run.
  if (executors.length === 1 && executors[0] === floor) {
    for (const node of nodes.values()) {
      delete node.platform
      if (isGroupTask(node)) continue
      here(node)
      if (node.config.exec?.persistent !== undefined) continue
      placements.executors.set(node.id, floor)
      if (node.config.exec?.remote === 'only') placements.remoteOnlyNoop.add(node.id)
    }
    return placements
  }
  const pinned = pinsOf({})
  const routers = executors.filter((e) => e.platforms !== undefined)
  const sole = executors.find((e) => e.exclusive === true)
  /** A task an `exclusive` executor leaves to this machine: the run refuses. */
  const refuse = (id: string, why: string): never => {
    throw new UserError(
      `${id} would run on this machine, and ${executorLabel(sole!)} runs every task elsewhere: ${why}`,
    )
  }
  // A server it cannot carry first: one asked for pins its dependants, and
  // the run named a dependant, as folding a runtime probe (2026-10-24).
  if (sole !== undefined)
    for (const node of nodes.values())
      if (
        node.config.exec?.persistent !== undefined &&
        !(sole.servers === true && carriable(node, true))
      )
        refuse(node.id, 'it starts a server only beside a task that needs it')
  for (const node of nodes.values()) {
    delete node.platform
    if (isGroupTask(node) || node.config.exec?.persistent !== undefined) continue
    if (node.config.exec?.interactive === true && sole === undefined) {
      placements.executors.set(node.id, floor)
      here(node)
      // Its servers run here with it: carried, none started under it.
      for (const s of serversBehind(nodes, node)) heldHere.add(s.id)
      continue
    }
    const wants: readonly string[] | undefined = node.config.exec?.platforms
    const routes = (e: TaskExecutor): boolean =>
      wants === undefined || e.platforms?.some((p) => wants.includes(p)) === true
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
      (e) => pinsOf(e).has(node.id) || !routes(e),
    )
    if (sole !== undefined && executor === floor) {
      refuse(
        node.id,
        pinsOf(sole).has(node.id)
          ? 'its key includes a runtime probe, which it does not check'
          : routes(sole)
            ? 'it declined the task'
            : `it offers ${sole.platforms?.join(', ') ?? 'no platform'}, and exec.platforms asks for ${wants!.join(', ')}`,
      )
    }
    placements.executors.set(node.id, executor)
    if (wants !== undefined) {
      const offered = executor.platforms
      if (offered !== undefined && routes(executor)) {
        node.platform =
          wants.includes(host) && offered.includes(host)
            ? host
            : wants.find((p) => offered.includes(p))!
      } else {
        here(node)
        if (placements.otherPlatform.has(node.id) && routers.length > 0) {
          placements.unroutable.set(node.id, [...new Set(routers.flatMap((e) => e.platforms!))])
        }
      }
    }
    const servers = serversBehind(nodes, node)
    if (servers.length > 0) {
      if (executor.servers === true) placements.servers.set(node.id, servers)
      else for (const s of servers) heldHere.add(s.id)
    }
    if (node.config.exec?.remote === 'only') {
      // A pinned 'only' task (it transitively depends on a persistent one)
      // lands here too: pinning wins, so it noops rather than shipping.
      if (executor.remote === true) placements.remoteOnly.add(node.id)
      else placements.remoteOnlyNoop.add(node.id)
    }
  }
  for (const servers of placements.servers.values())
    for (const s of servers) if (!heldHere.has(s.id)) placements.carried.add(s.id)
  for (const node of nodes.values()) {
    if (node.config.exec?.persistent === undefined || placements.carried.has(node.id)) continue
    if (sole !== undefined) refuse(node.id, 'it starts a server only beside a task that needs it')
    here(node)
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
 * "everything lands locally". The tasks `exec.platforms` skip here ride
 * along, and a platform refusal (CI, an executor that cannot route) throws
 * as the run's does.
 */
export async function planExecutorOf(
  prepared: Awaited<ReturnType<typeof prepareRun>>,
  log: Logger,
  policy: 'all' | 'toplevel' | 'none',
  ci: boolean,
): Promise<{
  executorOf?: (id: string) => string | undefined
  downloadOf?: (id: string) => 'eager' | 'deferred' | 'never' | undefined
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
  otherPlatform?: ReadonlyMap<string, readonly string[]>
}> {
  let executors: readonly TaskExecutor[]
  try {
    executors = await resolveExecutors(prepared.plugins, {
      workspaceRoot: prepared.workspaceRoot,
      cacheDir: prepared.cacheDir,
      warn: warnOf(log),
      concurrency: machineParallelism(),
      artifacts: taskArtifacts(prepared.cache, prepared.workspaceRoot),
      cacheFacts: () => cacheFacts(prepared.remotes, prepared.cacheRefs),
    })
  } catch (err) {
    warnOf(log)(
      `[vx] placement not shown — ${err instanceof Error ? err.message : String(err)} (the run would refuse on it)`,
    )
    return {}
  }
  const placements = placeTasks(prepared.nodes, executors)
  // What the run refuses on, the plan refuses on: on CI a skip fails the run.
  const platforms = platformVerdict(placements, ci)
  if (platforms !== undefined && 'refuse' in platforms) throw new UserError(platforms.refuse)
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
    ...(placements.otherPlatform.size > 0 ? { otherPlatform: placements.otherPlatform } : {}),
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

/**
 * Each pooled executor's pool, under a name no other executor's pool
 * shares: the scheduler counts a pool by its name, and one package declared
 * twice (`@vzn/vx-reapi` against two clusters) names both executors alike,
 * so their two capacities were one. A repeat takes `#2`, `#3` in placement
 * order.
 */
export function poolOfPlacement(
  placements: Placements,
): (id: string) => { name: string; capacity: number } | undefined {
  const pools = new Map<TaskExecutor, { name: string; capacity: number }>()
  const taken = new Set<string>()
  for (const executor of placements.executors.values()) {
    if (executor.capacity === undefined || pools.has(executor)) continue
    let name = executor.name
    for (let n = 2; taken.has(name); n++) name = `${executor.name}#${n}`
    taken.add(name)
    pools.set(executor, { name, capacity: executor.capacity })
  }
  return (id) => {
    const executor = placements.executors.get(id)
    return executor === undefined ? undefined : pools.get(executor)
  }
}

/**
 * What a run says of its `otherPlatform` tasks: a refusal when an executor
 * that routes by platform could not take one, or the run is on CI (each
 * task runs there or the run fails, 2026-10-23), else the warning a
 * local run prints as it skips them and what depends on them.
 */
export function platformVerdict(
  placements: Placements,
  ci: boolean,
): { refuse: string } | { warn: string } | undefined {
  const skipped = placements.otherPlatform
  if (skipped.size === 0) return undefined
  const host = hostPlatform()
  const needs = (id: string): string => `${id} needs ${skipped.get(id)!.join(' or ')}`
  if (placements.unroutable.size > 0) {
    const offered = [...new Set([...placements.unroutable.values()].flat())]
    return {
      refuse:
        `no executor runs ${placements.unroutable.size === 1 ? 'this task' : 'these tasks'} on a platform ${placements.unroutable.size === 1 ? 'it lists' : 'they list'} ` +
        `(this machine is ${host}; executors run ${offered.join(', ')}):\n` +
        [...placements.unroutable.keys()].map((id) => `  ${needs(id)}`).join('\n') +
        `\ngive the executor a worker of each platform listed`,
    }
  }
  if (ci) {
    return {
      refuse:
        `on CI every task runs or the run fails, and ${skipped.size === 1 ? 'this task' : 'these tasks'} cannot run on ${host}:\n` +
        [...skipped.keys()].map((id) => `  ${needs(id)}`).join('\n') +
        `\nrun a target that holds only ${host} tasks, or one DTE run with a worker of each platform`,
    }
  }
  return {
    warn: `[vx] skipped on ${host}, with what depends on them: ${[...skipped.keys()].map(needs).join('; ')}`,
  }
}
