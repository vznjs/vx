// How long the rest of a live run should take, from each task's executed
// p50 in local history. A display aid for the live region only: it never
// steers the scheduler and never reaches the final summary.

import { computeReverseDepCount, isGroupTask, type TaskNode } from '../graph/index.js'

/** What the live region says about the rest of a run. */
export interface LiveForecast {
  /** Remaining wall ms, absent when history knows none of what is left. */
  etaMs?: number
  /** The running task at the head of the longest unfinished chain. */
  critical?: string
  /** Tasks not started because a dependency has not finished: the tasks line's `blocked`. */
  waiting: number
  /** Each running task's p50, where history knows it: the row's expected duration. */
  expected?: ReadonlyMap<string, number>
  /**
   * Tasks not started because a dependency has not finished, in the order
   * the scheduler would start them, at most one per worker: what an idle
   * worker row holds (2026-10-15).
   */
  blocked?: readonly BlockedTask[]
  /**
   * Each running task's count of what is downstream of it, the
   * scheduler's own count (`computeReverseDepCount`): its row's `blocks`
   * cell, why they are not running. A node downstream of two running tasks
   * counts under both.
   */
  blockedBy: ReadonlyMap<string, number>
  /** Each task's usual time (its executed p50), for the results' `±usual`. */
  usual?: ReadonlyMap<string, number>
}

/** A task an unfinished dependency holds back, and what holds it: the running task its longest chain waits on, else that dependency. */
export interface BlockedTask {
  id: string
  by: string
}

export type Forecast = (
  finished: ReadonlySet<string>,
  running: ReadonlyMap<string, number>,
  nowMs: number,
) => LiveForecast

/**
 * The later of the longest unfinished chain and the unfinished work spread
 * over the workers. A task still to run costs its p50 (a pending task may
 * yet hit, so this leans long, and the hits finish first); a running one
 * costs what its p50 has left, never below zero; a group or a task with no
 * history costs nothing. Zero while tasks still run means the run is past
 * its estimate: the live region counts the time since (2026-10-27).
 */
export function createForecast(
  nodes: ReadonlyMap<string, TaskNode>,
  p50s: ReadonlyMap<string, number>,
  concurrency: number,
  /** Every node's dependents count, the scheduler's baseline and the rows' `blocks`; computed here when absent. */
  rank: ReadonlyMap<string, number> = computeReverseDepCount(nodes),
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
  // The scheduler's own baseline ranking (`rank`), most dependents first,
  // ties in graph order.
  const position = new Map(order.map((n, i) => [n.id, i]))
  const before = (a: string, b: string): boolean => {
    const d = (rank.get(a) ?? 0) - (rank.get(b) ?? 0)
    return d !== 0 ? d > 0 : position.get(a)! < position.get(b)!
  }

  return (finished, running, nowMs) => {
    const expected = new Map<string, number>()
    let waiting = 0
    for (const id of running.keys()) {
      const p = cost.get(id)
      if (p !== undefined) expected.set(id, p)
    }
    const end = new Map<string, number>()
    // The running task each node's longest chain waits on.
    const head = new Map<string, string>()
    let chain = 0
    let chainEnd: string | undefined
    let work = 0
    let known = false
    // The best `workers` blocked tasks, kept sorted as the pass meets them.
    const held: BlockedTask[] = []
    const blockedBy = new Map<string, number>()
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
      const by =
        since === undefined ? (head.get(n.id) ?? n.deps.find((d) => end.has(d))) : undefined
      if (by !== undefined && !isGroupTask(n)) {
        waiting++
        let at = held.length
        while (at > 0 && before(n.id, held[at - 1]!.id)) at--
        if (at < workers) {
          held.splice(at, 0, { id: n.id, by })
          if (held.length > workers) held.pop()
        }
      }
      const p = cost.get(n.id)
      let own = 0
      if (p !== undefined) {
        known = true
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
    for (const id of running.keys()) {
      const d = rank.get(id)
      if (d !== undefined && d > 0) blockedBy.set(id, d)
    }
    if (!known) return { waiting, expected, blocked: held, blockedBy, usual: cost }
    const critical = chainEnd === undefined ? undefined : head.get(chainEnd)
    return {
      etaMs: Math.max(chain, work / workers),
      ...(critical !== undefined ? { critical } : {}),
      waiting,
      expected,
      blocked: held,
      blockedBy,
      usual: cost,
    }
  }
}
