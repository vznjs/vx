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
}

/** A task an unfinished dependency holds back, and what holds it: the running task its longest chain waits on, else that dependency. */
export interface BlockedTask {
  id: string
  by: string
}

/**
 * One pass over what is unfinished. Called again with the same `finished`
 * set, that set has only grown: the pass reads only what the last one left
 * unfinished. Another set starts over.
 */
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
  // Each node by its place in `order`, its facts in arrays. A pass built
  // Maps of the whole graph and read every finished task again, and each
  // task event forces a frame, each frame a pass: a 20,000-task run spent
  // ~1.6 s of its main thread on them on a terminal (2026-11-07).
  const size = order.length
  const position = new Map(order.map((n, i) => [n.id, i]))
  const deps = order.map((n) => {
    const at: number[] = []
    // A dependency outside the graph never has an end: leaving it out changes nothing.
    for (const d of n.deps) {
      const i = position.get(d)
      if (i !== undefined) at.push(i)
    }
    return at
  })
  const ids = order.map((n) => n.id)
  const group = Uint8Array.from(order, (n) => (isGroupTask(n) ? 1 : 0))
  // NaN: no p50.
  const cost = new Float64Array(size)
  const ranks = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    const n = order[i]!
    cost[i] = (group[i] ? undefined : p50s.get(n.id)) ?? NaN
    ranks[i] = rank.get(n.id) ?? 0
  }
  const workers = Math.max(1, concurrency)
  // The scheduler's own baseline ranking (`rank`), most dependents first,
  // ties in graph order.
  const before = (a: number, b: number): boolean => {
    const d = ranks[a]! - ranks[b]!
    return d !== 0 ? d > 0 : a < b
  }
  // Reused by every pass. `end` NaN: no end yet (finished, or not reached);
  // `since` NaN: not running; `head` -1: no running task its chain waits on.
  const end = new Float64Array(size)
  const since = new Float64Array(size)
  const head = new Int32Array(size)
  // What the last pass left unfinished, in order: a pass reads only these,
  // not every finished task again. Rebuilt when `finished` is another set
  // or shrank; the logger's only grows.
  const live = new Int32Array(size)
  let liveCount = -1
  let lastFinished: ReadonlySet<string> | undefined
  let lastSize = 0

  return (finished, running, nowMs) => {
    if (finished !== lastFinished || finished.size < lastSize || liveCount < 0) {
      for (let i = 0; i < size; i++) live[i] = i
      liveCount = size
    }
    let kept = 0
    for (let r = 0; r < liveCount; r++) {
      const i = live[r]!
      if (!finished.has(ids[i]!)) live[kept++] = i
    }
    liveCount = kept
    lastFinished = finished
    lastSize = finished.size
    end.fill(NaN)
    since.fill(NaN)
    head.fill(-1)
    for (const [id, at] of running) {
      const i = position.get(id)
      if (i !== undefined) since[i] = at
    }
    let waiting = 0
    let chain = 0
    let chainEnd = -1
    let work = 0
    let known = false
    // The best `workers` blocked tasks, kept sorted as the pass meets them.
    const held: BlockedTask[] = []
    const heldAt: number[] = []
    const blockedBy = new Map<string, number>()
    for (let r = 0; r < liveCount; r++) {
      const i = live[r]!
      const ds = deps[i]!
      let start = 0
      let via = -1
      for (const d of ds) {
        const e = end[d]!
        if (e === e && (via < 0 || e > start)) {
          start = e
          via = d
        }
      }
      const s = since[i]!
      const runs = s === s
      if (runs) head[i] = i
      else if (via >= 0 && head[via]! >= 0) head[i] = head[via]!
      if (!runs && !group[i]) {
        let by = head[i]!
        if (by < 0)
          for (const d of ds)
            if (end[d] === end[d]) {
              by = d
              break
            }
        if (by >= 0) {
          waiting++
          let at = held.length
          while (at > 0 && before(i, heldAt[at - 1]!)) at--
          if (at < workers) {
            held.splice(at, 0, { id: ids[i]!, by: ids[by]! })
            heldAt.splice(at, 0, i)
            if (held.length > workers) {
              held.pop()
              heldAt.pop()
            }
          }
        }
      }
      const p = cost[i]!
      let own = 0
      if (p === p) {
        known = true
        own = runs ? Math.max(0, p - (nowMs - s)) : p
      }
      const e = start + own
      end[i] = e
      if (e > chain || chainEnd < 0) {
        chain = e
        chainEnd = i
      }
      work += own
    }
    for (const id of running.keys()) {
      const d = rank.get(id)
      if (d !== undefined && d > 0) blockedBy.set(id, d)
    }
    if (!known) return { waiting, blocked: held, blockedBy }
    const critical = chainEnd < 0 || head[chainEnd]! < 0 ? undefined : ids[head[chainEnd]!]!
    return {
      etaMs: Math.max(chain, work / workers),
      ...(critical !== undefined ? { critical } : {}),
      waiting,
      blocked: held,
      blockedBy,
    }
  }
}
