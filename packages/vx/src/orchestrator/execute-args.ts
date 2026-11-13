// What a dispatch hands executeTask: the run's half, built once and shared
// by reference, and the task's half, looked up per dispatch. The task's
// optional fields are assigned only when present: conditional spreads per
// task cost ~18 ms of object copying on a 1,090-package warm run.

import type { TaskNode, TaskOutcome } from '../graph/index.js'
import type { Logger } from '../report/index.js'
import type { DownloadMode } from './download-policy.js'
import type { ExecuteArgs, RunContext } from './execute-task.js'
import type { ShortCircuit } from './local-shortcircuit.js'
import { UNPLACED_EXECUTOR, type Placements } from './placement.js'
import { outputWallsOf } from './prepare.js'

/** Where the task's half is read from, per task id. */
export interface TaskFacts {
  log: (node: TaskNode) => Logger
  placements: Placements
  nestedDirsByProject: ReadonlyMap<string, string[]>
  /** None under `cache.download: all`: every task eager. */
  downloadModeOf: ReadonlyMap<string, DownloadMode> | undefined
  shortCircuit: Pick<ShortCircuit, 'preProbed' | 'uncachedKeys' | 'groupKeys'>
  /** Tasks whose outputs may come here after they end (`trailable`). */
  trailable?: ReadonlySet<string>
  /** Tasks some other task depends on. */
  dependedOn: ReadonlySet<string>
  /** Tasks that hold the terminal (`terminalHolders`). */
  holders: ReadonlySet<string>
}

/**
 * The dispatch builder. `reuseProbe: false` takes the task's key again
 * instead of the up-front probe (admission's retry after a dropped probe);
 * `tainted` is the run's taint verdict for this dispatch.
 */
export function executeArgsOf(
  scope: RunContext,
  facts: TaskFacts,
): (node: TaskNode, upstream: TaskOutcome[], reuseProbe: boolean, tainted: boolean) => ExecuteArgs {
  const { placements, shortCircuit } = facts
  const walls = outputWallsOf(facts.nestedDirsByProject)
  return (node, upstream, reuseProbe, tainted) => {
    const id = node.id
    const a: ExecuteArgs = {
      run: scope,
      node,
      upstream,
      log: facts.log(node),
      executor: placements.executors.get(id) ?? UNPLACED_EXECUTOR,
      nestedProjectDirs: facts.nestedDirsByProject.get(node.projectName) ?? [],
    }
    const probe = reuseProbe ? shortCircuit.preProbed.get(id) : undefined
    const upfrontKey = shortCircuit.uncachedKeys.get(id)
    const upfrontGroupKey = shortCircuit.groupKeys.get(id)
    if (walls !== facts.nestedDirsByProject) a.outputNestedDirs = walls.get(node.projectName) ?? []
    if (facts.downloadModeOf?.get(id) === 'deferred') a.download = 'deferred'
    else if (facts.trailable?.has(id) === true) a.download = 'trailing'
    if (placements.remoteOnlyNoop.has(id)) a.remoteOnlyNoop = true
    if (placements.belowNoop.has(id)) a.belowNoop = true
    if (placements.remoteOnly.has(id)) a.remoteOnly = true
    if (placements.carried.has(id)) a.carried = true
    const servers = placements.servers.get(id)
    if (servers !== undefined) {
      a.servers = servers
      a.serversNested = servers.map((s) => facts.nestedDirsByProject.get(s.projectName) ?? [])
    }
    if (probe !== undefined) a.preProbed = probe
    if (upfrontKey !== undefined) a.upfrontKey = upfrontKey
    if (upfrontGroupKey !== undefined) a.upfrontGroupKey = upfrontGroupKey
    if (tainted) a.taintedUpstream = true
    if (!facts.dependedOn.has(id)) a.noDependants = true
    if (facts.holders.has(id)) a.terminal = true
    return a
  }
}
