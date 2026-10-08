// How long the rest of a live run should take, from each task's executed
// p50 in local history. A display aid for the live region only: it never
// steers the scheduler and never reaches the final summary.

import { isGroupTask, type TaskNode } from '../graph/index.js'

/** Remaining wall ms for a run in progress, or undefined when history knows none of what is left. */
export type Forecast = (
  finished: ReadonlySet<string>,
  running: ReadonlyMap<string, number>,
  nowMs: number,
) => number | undefined

/**
 * The later of the longest unfinished chain and the unfinished work spread
 * over the workers. A task still to run costs its p50 (a pending task may
 * yet hit, so this leans long, and the hits finish first); a running one
 * costs what its p50 has left, never below zero; a group or a task with no
 * history costs nothing. A running task well past its p50 means history
 * no longer describes this run, and the forecast says nothing.
 */
/** How far past its p50 a running task may go before the forecast gives up. */
const OVERRUN = 1.25

export function createForecast(
  nodes: ReadonlyMap<string, TaskNode>,
  p50s: ReadonlyMap<string, number>,
  concurrency: number,
): Forecast {
  // Dependencies before dependents, once: each call is one pass over it.
  const order: TaskNode[] = []
  const placed = new Set<string>()
  const place = (n: TaskNode): void => {
    const stack: Array<[TaskNode, number]> = [[n, 0]]
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const [node, i] = top
      if (placed.has(node.id)) {
        stack.pop()
        continue
      }
      if (i < node.deps.length) {
        top[1] = i + 1
        const dep = nodes.get(node.deps[i]!)
        if (dep !== undefined && !placed.has(dep.id)) stack.push([dep, 0])
        continue
      }
      placed.add(node.id)
      order.push(node)
      stack.pop()
    }
  }
  for (const n of nodes.values()) place(n)
  const cost = new Map<string, number>()
  for (const n of order) {
    const p = isGroupTask(n) ? undefined : p50s.get(n.id)
    if (p !== undefined) cost.set(n.id, p)
  }
  const workers = Math.max(1, concurrency)

  return (finished, running, nowMs) => {
    const end = new Map<string, number>()
    let chain = 0
    let work = 0
    let known = false
    for (const n of order) {
      if (finished.has(n.id)) continue
      let start = 0
      for (const d of n.deps) {
        const e = end.get(d)
        if (e !== undefined && e > start) start = e
      }
      const p = cost.get(n.id)
      let own = 0
      if (p !== undefined) {
        known = true
        const since = running.get(n.id)
        if (since !== undefined && nowMs - since > p * OVERRUN) return undefined
        own = since === undefined ? p : Math.max(0, p - (nowMs - since))
      }
      const e = start + own
      end.set(n.id, e)
      if (e > chain) chain = e
      work += own
    }
    return known ? Math.max(chain, work / workers) : undefined
  }
}
