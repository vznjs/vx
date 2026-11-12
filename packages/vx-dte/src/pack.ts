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
  /** Each change in what it holds, in time order, the first at 0. */
  readonly at: number[]
  /** What it holds from each change to the next. */
  readonly hc: number[]
  readonly hm: number[]
  readonly given: string[]
  /** When each server it runs (`PlanTask.servers`) starts there. */
  readonly serves: Map<string, number>
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

export interface PackOptions {
  /** Added to each task's latest start to order them, not to place them. */
  readonly noise?: ArrayLike<number>
  /** How far into its slack, 0 to 1, a task a new worker is started for starts. */
  readonly late?: ArrayLike<number>
  /** Undefined as soon as a task would start past its latest start. */
  readonly strict?: boolean
}

/**
 * The index of a change at `t`, split from the one before it. Levels, not
 * deltas: a running total rebuilt to the end on each insert made a
 * 9000-task pack 3.7 s (2026-11-11).
 */
function split(bay: Bay, t: number): number {
  const i = before(bay, t)
  if (bay.at[i] === t) return i
  bay.at.splice(i + 1, 0, t)
  bay.hc.splice(i + 1, 0, bay.hc[i]!)
  bay.hm.splice(i + 1, 0, bay.hm[i]!)
  return i + 1
}

/** Adds `cores` and `memory` to what `bay` holds over [from, to). */
function hold(bay: Bay, from: number, to: number, cores: number, memory: number): void {
  const a = split(bay, from)
  const b = split(bay, to)
  for (let k = a; k < b; k++) {
    bay.hc[k]! += cores
    bay.hm[k]! += memory
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

/** The first change over [t, t + ms) where `bay` lacks `cores` or `memory`, or -1. */
function blocked(bay: Bay, t: number, ms: number, cores: number, memory: number): number {
  const freeCores = bay.cores + 1e-9 - cores
  const freeMemory = bay.memory - memory
  for (let i = before(bay, t); i < bay.at.length && bay.at[i]! < t + ms; i++)
    if (bay.hc[i]! > freeCores || bay.hm[i]! > freeMemory) return i
  return -1
}

/**
 * The earliest start in [from, until] where `bay` has room for the task, or
 * undefined: past each change that lacks room, never back over it.
 */
function first(
  bay: Bay,
  from: number,
  until: number,
  ms: number,
  cores: number,
  memory: number,
): number | undefined {
  let t = Math.max(from, bay.join)
  while (t <= until + 1e-6) {
    const k = blocked(bay, t, ms, cores, memory)
    if (k < 0) return t
    if (k + 1 >= bay.at.length) return undefined
    t = bay.at[k + 1]!
  }
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
  options?: PackOptions & { readonly strict?: false },
): Packing
export function pack(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  fresh: readonly Size[],
  warm: (size: string, nth: number) => number,
  deadline: number,
  options: PackOptions,
): Packing | undefined
export function pack(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  fresh: readonly Size[],
  warm: (size: string, nth: number) => number,
  deadline: number,
  options: PackOptions = {},
): Packing | undefined {
  const { noise, late, strict = false } = options
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
  const rank = noise === undefined ? latest : (i: number): number => latest(i) + noise[i]!
  // A server runs on each worker that started it until no task left
  // needs it (`Orchestrator.unneeded`): booked there from then on, until
  // its last dependant is placed, then up to the last one's end.
  const dependants = new Map<string, { left: number; base: number; end: number; bays: Bay[] }>()
  for (const t of tasks)
    for (const sv of t.servers ?? []) {
      const d = dependants.get(sv.id)
      if (d === undefined) dependants.set(sv.id, { left: 1, base: sv.cores, end: 0, bays: [] })
      else d.left++
    }
  const serving = (id: string) => dependants.get(id)!
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
      at: [0],
      hc: [0],
      hm: [0],
      given: [],
      serves: new Map(),
    }
    for (const r of w.running) {
      const end = Math.max(1, leftMs(r.endsIn))
      hold(bay, 0, end, r.cores, r.memory)
      bay.end = Math.max(bay.end, end)
    }
    for (const [id, base] of w.serving ?? []) {
      if (!dependants.has(id)) {
        hold(bay, 0, Math.max(1, bay.end), base, 0)
        continue
      }
      hold(bay, 0, Infinity, base, 0)
      bay.serves.set(id, 0)
      serving(id).bays.push(bay)
      serving(id).end = Math.max(serving(id).end, bay.end)
    }
    bays.push(bay)
  }
  // Each size left to start, smallest first, and how many of it.
  const left = new Map<string, number>()
  for (const f of fresh) left.set(f.name, (left.get(f.name) ?? 0) + 1)
  const kinds = [...new Map(fresh.map((f) => [f.name, f])).values()].sort(
    (a, b) => a.cpu - b.cpu || a.memory - b.memory,
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
      if (rank(ready[p]!) <= rank(i)) break
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
        const c = l + 1 < ready.length && rank(ready[l + 1]!) < rank(ready[l]!) ? l + 1 : l
        if (rank(ready[c]!) >= rank(last)) break
        ready[k] = ready[c]!
        k = c
      }
      ready[k] = last
    }
    return top
  }
  // Where each upstream's files lie that only its worker holds (`PlanTask.reads`).
  const heldOn = new Map<string, { worker: string; ms: number }>()
  for (const w of workers)
    for (const [id, ms] of w.holds ?? []) heldOn.set(id, { worker: w.id, ms })
  for (let i = 0; i < n; i++) if (waits[i] === 0) push(i)
  // Tasks no worker had room for yet: a server kept open for its next
  // dependant held the room. Tried again once the rest is placed.
  const deferred: number[] = []
  let lastTry = -1
  for (;;) {
    while (ready.length > 0) {
      const i = pop()
      const t = tasks[i]!
      const r = readyAt[i]!
      const reads = t.reads
      // On a worker other than the one holding an upstream's files, that
      // upstream runs again first: main's deploy ran its 25 s build again
      // when the build's worker left (2026-11-11).
      const again = (bay: string): number => {
        if (reads === undefined) return 0
        let more = 0
        for (const u of reads) {
          const p = placed.get(u)
          if (p !== undefined) {
            if (p.worker !== bay) more += tasks[index.get(u)!]!.ms!
            continue
          }
          const h = heldOn.get(u)
          if (h !== undefined && h.worker !== bay) more += h.ms
        }
        return more
      }
      // Its servers' bases: one a bay runs already is booked only before
      // it starts there, the rest from this one's start on.
      const need = (bay: Bay): number => {
        let cores = t.cores
        for (const sv of t.servers ?? []) if (!bay.serves.has(sv.id)) cores += sv.cores
        return Math.min(cores, bay.cores)
      }
      const stretch = (bay: Bay, at: number, len: number): boolean => {
        for (const sv of t.servers ?? []) {
          const from = bay.serves.get(sv.id)
          if (from === undefined) {
            if (blocked(bay, at + len, Infinity, sv.cores, 0) >= 0) return false
          } else if (at < from && blocked(bay, at, from - at, need(bay) + sv.cores, t.memory) >= 0)
            return false
        }
        return true
      }
      let ms = t.ms!
      let best: Bay | undefined
      let bestMs = ms
      let bestAt = Infinity
      let bestCost = Infinity
      // One idle now could take it: letting it go to ask another later is churn.
      let idle = false
      // The best room's cost on a worker the run has: the margin a new one
      // must beat it by, as a plan of history may be off by as much.
      let real = false
      for (const bay of bays) {
        if (!suits(bay, t)) continue
        const more = again(bay.id)
        const len = t.ms! + more
        const at = first(bay, r, latest(i) - more, len, need(bay), t.memory)
        if (at === undefined || !stretch(bay, at, len)) continue
        if (bay.end === 0 && bay.given.length === 0) idle = true
        const cost = bay.cores * Math.max(0, at + len - bay.end)
        if (cost < bestCost || (cost === bestCost && at < bestAt)) {
          real = bay.size === undefined
          best = bay
          bestAt = at
          bestCost = cost
          bestMs = len
        }
      }
      const fresh = t.ms! + again('')
      const by = latest(i) - (fresh - t.ms!)
      ms = fresh
      // A new one, the smallest it fits, joining as the task is ready (or
      // later, as `late` asks): taken when none has room by its latest start,
      // or when keeping one idle until then costs more than a warm-up.
      const size = kinds.find(
        (s) =>
          left.get(s.name)! > 0 &&
          (t.platform === undefined || s.platform === t.platform) &&
          s.cpu >= t.cores - 1e-9 &&
          s.memory >= t.memory &&
          (t.above === undefined || s.cpu > t.above.cores || s.memory > t.above.memory),
      )
      if (size !== undefined) {
        const nth = asked.get(size.name) ?? 0
        const w = warm(size.name, nth)
        const want = late === undefined ? r : r + late[i]! * Math.max(0, by - r)
        const spawn = Math.max(0, want - w)
        const at = spawn + w
        if (
          best === undefined ||
          (!idle && size.cpu * (at + ms - spawn + (real ? w : 0)) < bestCost)
        ) {
          left.set(size.name, left.get(size.name)! - 1)
          asked.set(size.name, nth + 1)
          const id = `\0pack${starts.length}`
          starts.push({ id, size, at: spawn })
          best = {
            id,
            cores: size.cpu,
            memory: size.memory,
            platform: size.platform,
            size,
            spawn,
            join: at,
            open: true,
            end: 0,
            at: [0],
            hc: [0],
            hm: [0],
            given: [],
            serves: new Map(),
          }
          bays.push(best)
          bestAt = at
          bestMs = ms
        }
      }
      if (best === undefined) {
        if (strict) return undefined
        // None left to start: the soonest room any has, late.
        for (const bay of bays) {
          if (!suits(bay, t)) continue
          const len = t.ms! + again(bay.id)
          const at = first(bay, r, Infinity, len, need(bay), t.memory)
          if (at !== undefined && at < bestAt && stretch(bay, at, len)) {
            best = bay
            bestAt = at
            bestMs = len
          }
        }
        if (best === undefined) {
          deferred.push(i)
          continue
        }
      }
      if (strict && bestAt + bestMs > latest(i) + t.ms! + 1e-6) return undefined
      const to = bestAt + bestMs
      hold(best, bestAt, to, t.cores, t.memory)
      for (const sv of t.servers ?? []) {
        const d = serving(sv.id)
        const from = best.serves.get(sv.id)
        if (from === undefined) {
          hold(best, bestAt, Infinity, sv.cores, 0)
          best.serves.set(sv.id, bestAt)
          d.bays.push(best)
        } else if (bestAt < from) {
          hold(best, bestAt, from, sv.cores, 0)
          best.serves.set(sv.id, bestAt)
        }
        d.end = Math.max(d.end, to)
        if (--d.left === 0) for (const bay of d.bays) hold(bay, d.end, Infinity, -d.base, 0)
      }
      best.end = Math.max(best.end, to)
      best.given.push(t.id)
      placed.set(t.id, { worker: best.id, at: bestAt, ready: r })
      end = Math.max(end, bestAt + bestMs)
      for (const j of after[i]!) {
        readyAt[j] = Math.max(readyAt[j]!, bestAt + bestMs)
        if (--waits[j]! === 0) push(j)
      }
    }
    const before = placed.size
    if (deferred.length === 0 || before === 0) break
    const retry = deferred.splice(0)
    for (const i of retry) push(i)
    // A round that placed none: none ever fits.
    if (retry.length > 0 && lastTry === before) break
    lastTry = before
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
