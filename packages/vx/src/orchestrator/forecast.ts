// How long the rest of a live run should take, from each task's executed
// p50 in local history. A display aid for the live region only: it never
// steers the scheduler and never reaches the final summary.

import { isGroupTask, type TaskNode } from '../graph/index.js'

/** What the live region says about the rest of a run. */
export interface LiveForecast {
  /** Remaining wall ms, absent when history knows none of what is left. */
  etaMs?: number
  /** The running task at the head of the longest unfinished chain. */
  critical?: string
  /** Each running task's unfinished dependents, direct and transitive. */
  blocks: ReadonlyMap<string, number>
}

export type Forecast = (
  finished: ReadonlySet<string>,
  running: ReadonlyMap<string, number>,
  nowMs: number,
) => LiveForecast

/** How far past its p50 a running task may go before the forecast gives up. */
const OVERRUN = 1.25

/**
 * The later of the longest unfinished chain and the unfinished work spread
 * over the workers. A task still to run costs its p50 (a pending task may
 * yet hit, so this leans long, and the hits finish first); a running one
 * costs what its p50 has left, never below zero; a group or a task with no
 * history costs nothing. A running task well past its p50 means history
 * no longer describes this run, and the forecast says nothing of time.
 */
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

  const dependents = new Map<string, string[]>()
  for (const n of order)
    for (const d of n.deps) {
      const list = dependents.get(d)
      if (list === undefined) dependents.set(d, [n.id])
      else list.push(n.id)
    }

  const blocked = (id: string, finished: ReadonlySet<string>): number => {
    const seen = new Set<string>()
    const stack = [id]
    while (stack.length > 0) {
      for (const next of dependents.get(stack.pop()!) ?? []) {
        if (seen.has(next) || finished.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    return seen.size
  }

  return (finished, running, nowMs) => {
    const blocks = new Map<string, number>()
    for (const id of running.keys()) blocks.set(id, blocked(id, finished))
    const end = new Map<string, number>()
    // The running task each node's longest chain waits on.
    const head = new Map<string, string>()
    let chain = 0
    let chainEnd: string | undefined
    let work = 0
    let known = false
    let overrun = false
    for (const n of order) {
      if (finished.has(n.id)) continue
      let start = 0
      let via: string | undefined
      for (const d of n.deps) {
        const e = end.get(d)
        if (e !== undefined && (via === undefined || e > start)) {
          start = e
          via = d
        }
      }
      const since = running.get(n.id)
      if (since !== undefined) head.set(n.id, n.id)
      else if (via !== undefined && head.has(via)) head.set(n.id, head.get(via)!)
      const p = cost.get(n.id)
      let own = 0
      if (p !== undefined) {
        known = true
        if (since !== undefined && nowMs - since > p * OVERRUN) overrun = true
        own = since === undefined ? p : Math.max(0, p - (nowMs - since))
      }
      const e = start + own
      end.set(n.id, e)
      if (e > chain || chainEnd === undefined) {
        chain = e
        chainEnd = n.id
      }
      work += own
    }
    if (!known || overrun) return { blocks }
    const critical = chainEnd === undefined ? undefined : head.get(chainEnd)
    return {
      etaMs: Math.max(chain, work / workers),
      ...(critical !== undefined ? { critical } : {}),
      blocks,
    }
  }
}
