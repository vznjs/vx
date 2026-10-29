import { isGroupTask } from './folds.js'
import { reverseDepCountsOver } from './priorities.js'
import type { TaskNode } from './task-graph.js'

/** The two dependents counts a run reads: every node's, for the scheduler, and its tasks', a row's `blocks`. */
export interface ReverseDepCounts {
  /** Every dependent: the scheduler's `most-work` baseline (`computeReverseDepCount`). */
  all: Map<string, number>
  /** Dependents that are tasks, groups left out: what a row's `blocks` names. */
  tasks: Map<string, number>
}

/** Both of a run's dependents counts, from one closure. */
export function reverseDepCounts(nodes: ReadonlyMap<string, TaskNode>): ReverseDepCounts {
  const tasks = new Map<string, true>()
  for (const n of nodes.values()) if (!isGroupTask(n)) tasks.set(n.id, true)
  const [all, counted] = reverseDepCountsOver(nodes, [undefined, tasks])
  return { all: all!, tasks: counted! }
}
