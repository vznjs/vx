// A distributed run played on a virtual clock: core hands over each task
// that misses as its dependencies end, the run decides (`decide`) and
// dispatches (`assign`) with the plugin's own code at every event, and
// workers join after their warm-up and run tasks for as long as they
// took. Pure and deterministic: a run of minutes plays in milliseconds.
// What the summary's Workers table would say comes back with it.

import type { TaskNode } from '@vzn/vx'
import { assign, ordered, type Need } from '../src/dispatch.js'
import { booked, DEFAULT_STRATEGY, type Strategy } from '../src/strategy.js'
import {
  decide,
  simulate as play,
  tailsMs,
  type PlanTask,
  type PlanWorker,
  type Size,
} from '../src/planner.js'

/** One task of the run: as the CI graph declares it, and how it ran if it missed. */
export interface SimTask {
  readonly id: string
  readonly deps: readonly string[]
  readonly exec: boolean
  readonly cache: boolean
  /** It missed: how long it ran, the cores it kept busy, its peak memory (bytes). */
  readonly ran?: { readonly ms: number; readonly cores: number; readonly memory: number }
  /** What history said of it before the run, when that differs from how it ran; null: never measured. */
  readonly known?: { readonly ms: number; readonly cores: number; readonly memory: number } | null
}

export interface SimOptions {
  readonly sizes: readonly Size[]
  /** How long the n-th worker started (1 first) takes to join. */
  readonly warmUpMs?: (n: number) => number
  /** The tasks the forecast says miss (`likelyMisses`), before any does. */
  readonly likely?: ReadonlySet<string>
  /** How it orders, places, books and scales; default `DEFAULT_STRATEGY`. */
  readonly how?: Strategy
}

export interface SimWorker {
  readonly id: string
  readonly spawnedAt: number
  joinedAt?: number
  leftAt?: number
  cancelledAt?: number
  tasks: number
  busyMs: number
  /** Joined, nothing running, while a task waited in the queue. */
  idleQueuedMs: number
  /** Joined, nothing running, while the run had work left. */
  idleMs: number
  cpuMs: number
  onlineMs: number
  readonly cores: number
  readonly memory: number
  /** The most it was booked at once, cores and memory. */
  peakBooked: number
  peakMemory: number
}

export interface SimResult {
  readonly endMs: number
  readonly workers: readonly SimWorker[]
  /** A worker let go or cancelled, then one of its size started within a warm-up. */
  readonly churn: number
  readonly executed: number
  readonly utilization: number
  /** Tasks sent to a worker whose running tasks already used all its cores. */
  readonly overSent: number
}

const UNMEASURED: Need = { cores: Infinity, memory: Infinity }

interface Running {
  readonly id: string
  readonly booked: Need
  readonly cores: number
  /** Its work left, in ms of it running alone. */
  left: number
  readonly startedAt: number
  readonly knownMs: number | undefined
}

interface Live extends SimWorker {
  readonly running: Map<string, Running>
  readonly has: Set<string>
}

export function simulate(graph: readonly SimTask[], options: SimOptions): SimResult {
  const warmUpOf = options.warmUpMs ?? (() => 20_000)
  const how = options.how ?? DEFAULT_STRATEGY
  const byId = new Map(graph.map((t) => [t.id, t]))
  const nodes = new Map<string, TaskNode>(
    graph.map((t) => [
      t.id,
      {
        id: t.id,
        deps: [...t.deps],
        config: {
          ...(t.exec ? { exec: { command: 'x' } } : {}),
          ...(t.cache ? { cache: {} } : {}),
        },
      } as unknown as TaskNode,
    ]),
  )
  const known = (id: string) => {
    const t = byId.get(id)!
    return t.known === undefined ? t.ran : (t.known ?? undefined)
  }
  const need = (id: string): Need => {
    const k = known(id)
    return booked(
      k === undefined ? UNMEASURED : { cores: Math.max(0.25, k.cores), memory: k.memory },
      how.book,
    )
  }
  const durationMs = (id: string): number | undefined => known(id)?.ms
  const tail = tailsMs(nodes, durationMs)

  let now = 0
  const done = new Set<string>()
  const queue: string[] = []
  const executed = new Set<string>()
  const workers: Live[] = []
  const started = new Map<string, number>()
  const goneAt: { size: string; at: number }[] = []
  let churn = 0
  let again: number | undefined
  // The run's deadline (`Plan.boundMs`), and the work its plans knew.
  let deadline: number | undefined
  const planned = new Set<string>()
  let index = 0
  const sizeOf = new Map<string, Size>()

  // Core: a task whose dependencies ended either runs (a miss) or ends now.
  const waiting = new Map(graph.map((t) => [t.id, t.deps.filter((d) => byId.has(d)).length]))
  const dependants = new Map<string, string[]>()
  for (const t of graph)
    for (const d of t.deps) dependants.set(d, [...(dependants.get(d) ?? []), t.id])
  const end = (id: string): void => {
    done.add(id)
    for (const d of dependants.get(id) ?? []) {
      const n = waiting.get(d)! - 1
      waiting.set(d, n)
      if (n === 0) ready(d)
    }
  }
  const ready = (id: string): void => {
    const t = byId.get(id)!
    if (t.exec && t.ran !== undefined) {
      executed.add(id)
      queue.push(id)
    } else end(id)
  }

  const joined = (): Live[] =>
    workers.filter((w) => w.joinedAt !== undefined && w.leftAt === undefined)
  const starting = (): Live[] =>
    workers.filter((w) => w.joinedAt === undefined && w.cancelledAt === undefined)

  // Workers whose tasks use all their cores now, and tasks sent to one.
  const overloaded = new Set<string>()
  let overSent = 0
  const dispatch = (): void => {
    const widest = Math.max(1, ...joined().map((w) => w.cores))
    queue.splice(0, queue.length, ...ordered(queue, how.order, tail, need, widest))
    const bins = joined().map((w) => {
      let cores = 0
      let memory = 0
      let load = 0
      for (const r of w.running.values()) {
        cores += Math.min(r.booked.cores, w.cores)
        memory += Math.min(r.booked.memory, w.memory)
        load += r.cores
      }
      // As the orchestrator's `used`: booked, or its load when that is more.
      cores = Math.max(cores, Math.min(load, w.cores))
      if (load >= w.cores - 1e-9) overloaded.add(w.id)
      else overloaded.delete(w.id)
      return {
        id: w.id,
        cores: w.cores,
        memory: w.memory,
        used: { cores, memory },
        running: w.running.size,
        has: w.has,
        w,
      }
    })
    const to = assign(
      queue.map((id) => ({ id, need: need(id), up: byId.get(id)!.deps })),
      bins,
      undefined,
      how.place,
    )
    for (const [id, bin] of to) {
      const w = bin.w
      if (overloaded.has(w.id)) overSent++
      queue.splice(queue.indexOf(id), 1)
      const ran = byId.get(id)!.ran!
      w.running.set(id, {
        id,
        booked: need(id),
        cores: ran.cores,
        left: ran.ms,
        startedAt: now,
        knownMs: durationMs(id),
      })
      w.tasks++
      let booked = 0
      let memory = 0
      for (const r of w.running.values()) {
        booked += Math.min(r.booked.cores, w.cores)
        memory += Math.min(r.booked.memory, w.memory)
      }
      w.peakBooked = Math.max(w.peakBooked, booked)
      w.peakMemory = Math.max(w.peakMemory, memory)
    }
  }

  const replan = (): void => {
    const likely = options.likely ?? new Set<string>()
    if (executed.size === 0 && likely.size === 0) return
    const warmUp = warmUpOf(1)
    const planWorkers: PlanWorker[] = []
    const running = new Set<string>()
    for (const w of joined()) {
      const jobs = [...w.running.values()]
      for (const r of jobs) running.add(r.id)
      let held = 0
      let load = 0
      for (const r of jobs) {
        held += Math.min(r.booked.cores, w.cores)
        load += r.cores
      }
      const over = held > 0 ? Math.max(1, Math.min(load, w.cores) / held) : 1
      planWorkers.push({
        id: w.id,
        cores: w.cores,
        memory: w.memory,
        at: 0,
        idle: jobs.length === 0,
        running: jobs.map((r) => ({
          id: r.id,
          cores: Math.min(w.cores, Math.min(r.booked.cores, w.cores) * over),
          memory: Math.min(r.booked.memory, w.memory),
          endsIn: Math.max(0, (r.knownMs ?? 0) - (now - r.startedAt)),
        })),
      })
    }
    for (const w of starting())
      planWorkers.push({
        id: w.id,
        cores: w.cores,
        memory: w.memory,
        at: Math.max(0, warmUp - (now - w.spawnedAt)),
        idle: false,
        running: [],
        starting: true,
      })
    const remaining = graph.map((t) => t.id).filter((id) => !done.has(id))
    const p = decide({
      remaining,
      nodes,
      executed: likely.size === 0 ? executed : new Set([...likely, ...executed]),
      need,
      durationMs,
      workers: planWorkers,
      running,
      sizes: options.sizes,
      started,
      final: false,
      warmUpMs: warmUp,
      replaceable: true,
      limitMs: deadline === undefined ? undefined : deadline - now,
      known: planned,
      how,
    })
    deadline = now + p.boundMs
    for (const t of p.tasks) planned.add(t.id)
    if (p.release.length > 0 && remaining.length > 0)
      for (const id of p.release) {
        const w = workers.find((x) => x.id === id)!
        if (w.joinedAt === undefined) w.cancelledAt = now
        else if (w.running.size === 0) w.leftAt = now
        else continue
        const s = sizeOf.get(id)!
        started.set(s.name, started.get(s.name)! - 1)
        goneAt.push({ size: s.name, at: now })
      }
    again = p.againInMs === undefined ? undefined : now + p.againInMs
    for (const s of p.start) {
      if (goneAt.some((g) => g.size === s.name && now - g.at < warmUp)) churn++
      index++
      const id = `${s.name}#${index}`
      started.set(s.name, (started.get(s.name) ?? 0) + 1)
      sizeOf.set(id, s)
      workers.push({
        id,
        spawnedAt: now,
        tasks: 0,
        busyMs: 0,
        idleQueuedMs: 0,
        idleMs: 0,
        cpuMs: 0,
        onlineMs: 0,
        cores: s.cpu,
        memory: s.memory,
        peakBooked: 0,
        peakMemory: 0,
        running: new Map(),
        has: new Set(),
      })
      // Joining is a later event.
      joinAt.set(id, now + warmUpOf(index))
    }
  }
  const joinAt = new Map<string, number>()

  // Ready roots, then events until every task ended.
  // Roots first, then each: a root that ends at once readies its dependants itself.
  for (const id of graph.filter((t) => waiting.get(t.id) === 0).map((t) => t.id)) ready(id)
  const step = (): void => {
    dispatch()
    replan()
    dispatch()
  }
  step()
  for (let guard = 0; done.size < graph.length; guard++) {
    if (guard > 100_000) throw new Error('sim: no progress')
    // The next event: a task ends, a worker joins, the plan's timer.
    let next = Infinity
    for (const w of joined()) {
      const rate = rateOf(w)
      for (const r of w.running.values()) next = Math.min(next, now + r.left / rate)
    }
    for (const w of starting()) next = Math.min(next, joinAt.get(w.id)!)
    if (again !== undefined) next = Math.min(next, again)
    if (next === Infinity) throw new Error(`sim: stuck at ${now} ms with ${queue.length} queued`)
    const dt = next - now
    for (const w of joined()) {
      const rate = rateOf(w)
      let cpu = 0
      for (const r of w.running.values()) {
        r.left -= dt * rate
        cpu += r.cores
      }
      w.onlineMs += dt
      w.cpuMs += Math.min(cpu, w.cores) * dt
      if (w.running.size > 0) w.busyMs += dt
      else {
        w.idleMs += dt
        if (queue.length > 0) w.idleQueuedMs += dt
      }
    }
    now = next
    if (again !== undefined && again <= now) again = undefined
    for (const w of starting()) if (joinAt.get(w.id)! <= now) w.joinedAt = now
    for (const w of joined())
      for (const r of [...w.running.values()])
        if (r.left <= 1e-6) {
          w.running.delete(r.id)
          w.has.add(r.id)
          end(r.id)
        }
    step()
  }
  for (const w of joined()) w.leftAt = now
  let cpu = 0
  let had = 0
  for (const w of workers) {
    cpu += w.cpuMs
    had += w.cores * w.onlineMs
  }
  return {
    endMs: now,
    workers,
    churn,
    executed: executed.size,
    overSent,
    utilization: had === 0 ? 0 : cpu / had,
  }
}

/** Its tasks' pace: whole while they ask no more cores than it has, shared when they do. */
function rateOf(w: Live): number {
  let cores = 0
  for (const r of w.running.values()) cores += r.cores
  return cores <= w.cores ? 1 : w.cores / cores
}

/**
 * The best the run could end, knowing every miss before it starts: the
 * fewest ms over 1 to `max` workers of `size`, all joined after the warm-up.
 */
export function bestMs(graph: readonly SimTask[], size: Size, warmUpMs = 20_000): number {
  const byId = new Map(graph.map((t) => [t.id, t]))
  // A miss waits only on misses: a hit or a group ends at once.
  const up = (id: string, seen: Set<string>): string[] =>
    byId.get(id)!.deps.flatMap((d) => {
      if (seen.has(d) || !byId.has(d)) return []
      seen.add(d)
      return byId.get(d)!.ran === undefined ? up(d, seen) : [d]
    })
  const tasks: PlanTask[] = graph.flatMap((t) =>
    t.ran === undefined || !t.exec
      ? []
      : [
          {
            id: t.id,
            cores: t.ran.cores,
            memory: t.ran.memory,
            ms: t.ran.ms,
            deps: up(t.id, new Set()),
          },
        ],
  )
  let best = Infinity
  for (let n = 1; n <= size.max; n++) {
    const workers = Array.from({ length: n }, (_, i) => ({
      id: `w${i}`,
      cores: size.cpu,
      memory: size.memory,
      at: warmUpMs,
      running: [],
      idle: true,
    }))
    best = Math.min(best, play(tasks, workers))
  }
  return best
}
