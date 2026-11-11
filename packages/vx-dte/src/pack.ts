/**
 * The run's work packed onto as little worker time as ends it by its
 * deadline: each task, in order of its latest start, into the cheapest
 * room a worker has between its ready time and its latest start; a new
 * worker only for a task none has room for by then. Started as soon as
 * there was room, tasks with slack spread over workers the run then kept:
 * 21% more CPU than the least that ends at the critical path, on graphs
 * of 12 to 20 tasks solved exactly (lab, 2026-11-11).
 */
import type { PlanTask, PlanWorker, Size } from './planner.js'

/**
 * What a running task has left: past its time, as long again as it is
 * over, not none. Counted as ending now, a filler running three times its
 * history kept the room a critical task was held, the plan started no
 * worker for it, and it waited 100 s (2026-11-10).
 */
export const leftMs = (endsIn: number): number => (endsIn >= 0 ? endsIn : -endsIn)

/** A worker of the packing: what it holds through time. */
interface Bay {
  readonly id: string
  readonly cores: number
  readonly memory: number
  readonly platform: string | undefined
  /** The size a new one starts as. */
  readonly size?: Size
  /** When it is asked (new) or now (running); its CPU counts from here. */
  readonly spawn: number
  /** When it takes tasks. */
  readonly join: number
  /** Whether it takes new ones: not a draining one. */
  readonly open: boolean
  /** When its last task ends. */
  end: number
  /** Each change in what it holds, in time order: when, and the cores and memory it adds. */
  readonly at: number[]
  readonly dc: number[]
  readonly dm: number[]
  /** What it holds from each change on. */
  readonly hc: number[]
  readonly hm: number[]
  readonly given: string[]
}

export interface Packing {
  /** When the last task ends. */
  readonly end: number
  /** Cores times time each worker is held, from its ask (or now) to its last end. */
  readonly held: number
  /** Each task's worker, its start, and when it is ready as packed. */
  readonly placed: ReadonlyMap<
    string,
    { readonly worker: string; readonly at: number; readonly ready: number }
  >
  /** Each worker's tasks, in the order placed. */
  readonly given: ReadonlyMap<string, readonly string[]>
  /** When each worker's last task ends. */
  readonly free: ReadonlyMap<string, number>
  /** The workers to start: the size, and when to ask for it. */
  readonly starts: readonly { readonly id: string; readonly size: Size; readonly at: number }[]
}

/** Adds what `bay` holds from `at` on, as `hc`/`hm` count it. */
function change(bay: Bay, at: number, cores: number, memory: number): void {
  let i = bay.at.length
  while (i > 0 && bay.at[i - 1]! > at) i--
  bay.at.splice(i, 0, at)
  bay.dc.splice(i, 0, cores)
  bay.dm.splice(i, 0, memory)
  bay.hc.splice(i, 0, 0)
  bay.hm.splice(i, 0, 0)
  for (let j = i; j < bay.at.length; j++) {
    bay.hc[j] = (j === 0 ? 0 : bay.hc[j - 1]!) + bay.dc[j]!
    bay.hm[j] = (j === 0 ? 0 : bay.hm[j - 1]!) + bay.dm[j]!
  }
}

/** The index of the last change at or before `t`, or -1. */
function before(bay: Bay, t: number): number {
  let lo = 0
  let hi = bay.at.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bay.at[mid]! <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** Whether `bay` has `cores` and `memory` free over [t, t + ms). */
function room(bay: Bay, t: number, ms: number, cores: number, memory: number): boolean {
  const freeCores = bay.cores + 1e-9 - cores
  const freeMemory = bay.memory - memory
  let i = before(bay, t)
  if (i >= 0 && (bay.hc[i]! > freeCores || bay.hm[i]! > freeMemory)) return false
  for (i++; i < bay.at.length && bay.at[i]! < t + ms; i++)
    if (bay.hc[i]! > freeCores || bay.hm[i]! > freeMemory) return false
  return true
}

/** The earliest start in [from, until] where `bay` has room for the task, or undefined. */
function first(
  bay: Bay,
  from: number,
  until: number,
  ms: number,
  cores: number,
  memory: number,
): number | undefined {
  const lo = Math.max(from, bay.join)
  if (lo > until + 1e-6) return undefined
  if (room(bay, lo, ms, cores, memory)) return lo
  for (let i = before(bay, lo) + 1; i < bay.at.length && bay.at[i]! <= until + 1e-6; i++)
    if ((bay.dc[i]! < 0 || bay.dm[i]! < 0) && room(bay, bay.at[i]!, ms, cores, memory))
      return bay.at[i]!
  return undefined
}

/** Whether a task may run on `bay`: its platform, and its whole need in the worker's size. */
const suits = (bay: Bay, t: PlanTask): boolean =>
  bay.open &&
  (t.platform === undefined || bay.platform === t.platform) &&
  t.cores <= bay.cores + 1e-9 &&
  t.memory <= bay.memory &&
  (t.above === undefined || bay.cores > t.above.cores || bay.memory > t.above.memory)

/**
 * Packs `tasks` (each with its time) onto `workers` and new ones, each of
 * `fresh` at most once, the `nth` of its size (those starting counted)
 * joining `warm(size, nth)` after its ask, to end by
 * `deadline` (ms from now) on the least worker time.
 */
export function pack(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  fresh: readonly Size[],
  warm: (size: string, nth: number) => number,
  deadline: number,
): Packing {
  const n = tasks.length
  const index = new Map(tasks.map((t, i) => [t.id, i]))
  const after: number[][] = tasks.map(() => [])
  const waits = new Int32Array(n)
  const readyAt = new Float64Array(n)
  const runningEnd = new Map<string, number>()
  for (const w of workers)
    for (const r of w.running)
      if (r.id !== undefined) runningEnd.set(r.id, Math.max(1, leftMs(r.endsIn)))
  for (let i = 0; i < n; i++)
    for (const d of tasks[i]!.deps) {
      const j = index.get(d)
      if (j !== undefined) {
        after[j]!.push(i)
        waits[i]!++
      } else readyAt[i] = Math.max(readyAt[i]!, runningEnd.get(d) ?? 0)
    }
  // Latest start: the deadline less its chain.
  const tail = new Float64Array(n)
  const order: number[] = []
  {
    const left = Int32Array.from(waits)
    const queue = [...left.keys()].filter((i) => left[i] === 0)
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!
      order.push(i)
      for (const j of after[i]!) if (--left[j]! === 0) queue.push(j)
    }
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k]!
      let most = 0
      for (const j of after[i]!) most = Math.max(most, tail[j]!)
      tail[i] = tasks[i]!.ms! + most
    }
  }
  const latest = (i: number): number => deadline - tail[i]!
  const bays: Bay[] = []
  for (const w of workers) {
    const bay: Bay = {
      id: w.id,
      cores: w.cores,
      memory: w.memory,
      platform: w.platform,
      spawn: 0,
      join: Math.max(0, w.at),
      open: w.drainIn === undefined,
      end: 0,
      at: [],
      dc: [],
      dm: [],
      hc: [],
      hm: [],
      given: [],
    }
    for (const r of w.running) {
      const end = Math.max(1, leftMs(r.endsIn))
      change(bay, 0, r.cores, r.memory)
      change(bay, end, -r.cores, -r.memory)
      bay.end = Math.max(bay.end, end)
    }
    bays.push(bay)
  }
  const unused = [...fresh.keys()].sort(
    (a, b) => fresh[a]!.cpu - fresh[b]!.cpu || fresh[a]!.memory - fresh[b]!.memory,
  )
  const starts: { id: string; size: Size; at: number }[] = []
  // Each size's workers asked: those starting, then the packing's.
  const asked = new Map<string, number>()
  for (const w of workers)
    if (w.starting === true && w.size !== undefined) asked.set(w.size, (asked.get(w.size) ?? 0) + 1)
  const placed = new Map<string, { worker: string; at: number; ready: number }>()
  let end = 0
  // Ready tasks, least latest start first.
  const ready: number[] = []
  const push = (i: number): void => {
    let k = ready.length
    ready.push(i)
    while (k > 0) {
      const p = (k - 1) >> 1
      if (latest(ready[p]!) <= latest(i)) break
      ready[k] = ready[p]!
      k = p
    }
    ready[k] = i
  }
  const pop = (): number => {
    const top = ready[0]!
    const last = ready.pop()!
    if (ready.length > 0) {
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        if (l >= ready.length) break
        const c = l + 1 < ready.length && latest(ready[l + 1]!) < latest(ready[l]!) ? l + 1 : l
        if (latest(ready[c]!) >= latest(last)) break
        ready[k] = ready[c]!
        k = c
      }
      ready[k] = last
    }
    return top
  }
  for (let i = 0; i < n; i++) if (waits[i] === 0) push(i)
  while (ready.length > 0) {
    const i = pop()
    const t = tasks[i]!
    const ms = t.ms!
    const r = readyAt[i]!
    const by = latest(i)
    let best: Bay | undefined
    let bestAt = Infinity
    let bestCost = Infinity
    for (const bay of bays) {
      if (!suits(bay, t)) continue
      const at = first(bay, r, by, ms, t.cores, t.memory)
      if (at === undefined) continue
      const cost = bay.cores * Math.max(0, at + ms - bay.end)
      if (cost < bestCost || (cost === bestCost && at < bestAt)) {
        best = bay
        bestAt = at
        bestCost = cost
      }
    }
    if (best === undefined) {
      // A new one, the smallest it fits, asked so it joins as the task is ready.
      const k = unused.findIndex((f) => {
        const s = fresh[f]!
        return (
          (t.platform === undefined || s.platform === t.platform) &&
          s.cpu >= t.cores - 1e-9 &&
          s.memory >= t.memory &&
          (t.above === undefined || s.cpu > t.above.cores || s.memory > t.above.memory)
        )
      })
      if (k >= 0) {
        const size = fresh[unused[k]!]!
        unused.splice(k, 1)
        const nth = asked.get(size.name) ?? 0
        asked.set(size.name, nth + 1)
        const w = warm(size.name, nth)
        const spawn = Math.max(0, r - w)
        const id = `\0pack${starts.length}`
        starts.push({ id, size, at: spawn })
        best = {
          id,
          cores: size.cpu,
          memory: size.memory,
          platform: size.platform,
          size,
          spawn,
          join: spawn + w,
          open: true,
          end: 0,
          at: [],
          dc: [],
          dm: [],
          hc: [],
          hm: [],
          given: [],
        }
        bays.push(best)
        bestAt = best.join > r ? best.join : r
      } else {
        // None left to start: the soonest room any has, late.
        for (const bay of bays) {
          if (!suits(bay, t)) continue
          const at = first(bay, r, Infinity, ms, t.cores, t.memory)
          if (at !== undefined && at < bestAt) {
            best = bay
            bestAt = at
          }
        }
        if (best === undefined) continue
      }
    }
    change(best, bestAt, t.cores, t.memory)
    change(best, bestAt + ms, -t.cores, -t.memory)
    best.end = Math.max(best.end, bestAt + ms)
    best.given.push(t.id)
    placed.set(t.id, { worker: best.id, at: bestAt, ready: r })
    end = Math.max(end, bestAt + ms)
    for (const j of after[i]!) {
      readyAt[j] = Math.max(readyAt[j]!, bestAt + ms)
      if (--waits[j]! === 0) push(j)
    }
  }
  let held = 0
  for (const bay of bays) held += bay.cores * Math.max(0, bay.end - bay.spawn)
  return {
    end,
    held,
    placed,
    given: new Map(bays.filter((b) => b.given.length > 0).map((b) => [b.id, b.given])),
    free: new Map(bays.map((b) => [b.id, b.end])),
    starts,
  }
}
