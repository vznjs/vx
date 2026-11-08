// What an edge past a default build on a package cycle stands in for. Such
// a build folds nothing of its cycle, so the walk takes edges past it
// (`goPast`, `walkHolders` in task-graph.ts), and `inputs.tasks` selecting
// it selects them (`selectFoldedDeps`).
//
// Kept off the public `TaskNode` shape under a symbol key: a spread copy
// (the scheduler's restore view, an executor's `accepts` copy) carries it,
// and `applyGraphStage` re-attaches it by id to a node a hook rebuilt.

import type { TaskNode } from './task-graph.js'

/** Each edge's id, to the ids of the edges it went past. */
export type StandIns = Readonly<Record<string, readonly string[]>>

const STAND_INS = Symbol('vx.standIns')
type Carrier = TaskNode & { [STAND_INS]?: Record<string, string[]> }

/** The node's stand-ins; undefined off a package cycle. */
export function standInsOf(node: TaskNode): StandIns | undefined {
  return (node as Carrier)[STAND_INS]
}

/** Give `node` its stand-ins: a graph read back, or a node a hook rebuilt. */
export function setStandIns(node: TaskNode, standIns: StandIns): void {
  const own: Record<string, string[]> = {}
  for (const [edge, past] of Object.entries(standIns)) own[edge] = [...past]
  ;(node as Carrier)[STAND_INS] = own
}

/** Record that `node`'s edge to `id` stands in for the edges in `past`. */
export function addStandIn(node: TaskNode, id: string, past: readonly string[]): void {
  const map = ((node as Carrier)[STAND_INS] ??= {})
  const known = map[id]
  if (known === undefined) map[id] = [...past]
  else for (const p of past) if (!known.includes(p)) known.push(p)
}
