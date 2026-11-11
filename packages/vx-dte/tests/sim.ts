// A distributed run played on a virtual clock: core hands over each task
// that misses as its dependencies end, the run decides (`decide`) and
// places (`Queue`, as `Orchestrator.pump`) with the plugin's own code at every event, and
// workers join after their warm-up and run tasks for as long as they
// took. Pure and deterministic: a run of minutes plays in milliseconds.
// What the summary's Workers table would say comes back with it.

import type { TaskNode } from '@vzn/vx'
import { type Need, Placing, Queue, type Soon } from '../src/dispatch.js'
import { needOf } from '../src/plugin.js'
import { booked, DEFAULT_STRATEGY, type Strategy } from '../src/strategy.js'
import {
  decide,
  keepLast,
  simulate as play,
  sized,
  slowdown,
  spreadMs,
  tailsMs,
  type Forecast,
  type PlanTask,
  type PlanWorker,
  leftMs,
  type Size,
  UNKNOWN_MS,
} from '../src/planner.js'

/** One task of the run: as the CI graph declares it, and how it ran if it missed. */
export interface SimTask {
  readonly id: string
  readonly deps: readonly string[]
  readonly exec: boolean
  readonly cache: boolean
  /** It missed: how long it ran, the cores it kept busy, its peak memory (bytes). */
  readonly ran?: { readonly ms: number; readonly cores: number; readonly memory: number }
  /** What history said of it before the run, when that differs from how it ran; null: never measured; no cores: its time alone. */
  readonly known?: { readonly ms: number; readonly cores?: number; readonly memory: number } | null
  /** The platform core placed it on (`TaskNode.platform`). */
  readonly platform?: string
  /** Core's probe found it held, and its restore then failed: it runs (`ran`) once ready. */
  readonly restoreFails?: boolean
}

export interface SimOptions {
  readonly sizes: readonly Size[]
  /** How long the n-th worker started (1 first) takes to join. */
  readonly warmUpMs?: (n: number) => number
  /** The tasks the forecast says miss (`likelyMisses`), before any does. */
  readonly likely?: ReadonlySet<string>
  /** How it orders, places, books and scales; default `DEFAULT_STRATEGY`. */
  readonly how?: Strategy
  /** The platform a task naming none runs on (`homeOf`). */
  readonly home?: string
  /** What an unmeasured task counts for in the worker ask (`dte({ unmeasured })`). */
  readonly unmeasured?: Need
  /**
   * Whether core's cache probe answered before the first plan (default
   * true): a held task leaves the run's remaining work at once. False is
   * a probe with no answer: a hit stays remaining until it restores.
   */
  readonly probe?: boolean
  /** How long a hit takes to restore (default 0: it ends at once). */
  readonly restoreMs?: number
  /**
   * When history lands (default 0, before any task is ready): until then
   * every task is unmeasured, as on CI, where the default branch's
   * timings come a moment into the run. The first plan waits for it, as
   * the plugin's first ask does; the waiting rank and book again by it
   * (`Orchestrator.rerank`).
   */
  readonly historyAt?: number
}

export interface SimWorker {
  readonly id: string
  readonly spawnedAt: number
  joinedAt?: number
  leftAt?: number
  cancelledAt?: number
  tasks: number
  busyMs: number
  /** Joined, nothing running, while a task the plan lets go there waited in the queue. */
  idleQueuedMs: number
  /** Joined, nothing running, while the run had work left. */
  idleMs: number
  cpuMs: number
  onlineMs: number
  readonly cores: number
  readonly memory: number
  readonly platform: string | undefined
  /** The tasks it ran. */
  readonly ran: string[]
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
  /** Each executed task's ms from ready to started. */
  readonly waitedMs: ReadonlyMap<string, number>
  /** Each executed task's start. */
  readonly startedAt: ReadonlyMap<string, number>
  /** Each executed task's end. */
  readonly endedAt: ReadonlyMap<string, number>
}

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
        ...(t.platform === undefined ? {} : { platform: t.platform }),
        config: {
          ...(t.exec ? { exec: { command: 'x' } } : {}),
          ...(t.cache ? { cache: true } : {}),
        },
      } as unknown as TaskNode,
    ]),
  )
  let learned = (options.historyAt ?? 0) <= 0
  const known = (id: string) => {
    if (!learned) return undefined
    const t = byId.get(id)!
    return t.known === undefined ? t.ran : (t.known ?? undefined)
  }
  // Each task's need made once: the run's own is kept on its job.
  const needs = new Map<string, Need>()
  const need = (id: string): Need => {
    const had = needs.get(id)
    if (had !== undefined) return had
    const made = measured(id)
    needs.set(id, made)
    return made
  }
  const measured = (id: string): Need => {
    const k = known(id)
    const b = booked(
      k?.cores === undefined
        ? needOf(undefined, options.unmeasured)
        : { cores: Math.max(0.25, k.cores), memory: k.memory },
      how.book,
    )
    const platform = byId.get(id)!.platform ?? options.home
    return sized(platform === undefined ? b : { ...b, platform }, options.sizes)
  }
  const durationMs = (id: string): number | undefined => known(id)?.ms
  let tails = tailsMs(nodes, durationMs)
  const tail = (id: string): number => tails(id)

  let now = 0
  const done = new Set<string>()
  const queue = new Queue(how, tail, need)
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
  // Tasks that run a command and have not ended, by platform: as the plugin counts them.
  const leftOf = new Map<string, number>()
  for (const t of graph)
    if (t.exec) {
      const p = t.platform ?? options.home ?? ''
      leftOf.set(p, (leftOf.get(p) ?? 0) + 1)
    }
  const end = (id: string): void => {
    done.add(id)
    const t = byId.get(id)!
    if (t.exec) {
      const p = t.platform ?? options.home ?? ''
      leftOf.set(p, leftOf.get(p)! - 1)
    }
    for (const d of dependants.get(id) ?? []) {
      const n = waiting.get(d)! - 1
      waiting.set(d, n)
      if (n === 0) ready(d)
    }
  }
  const readyAt = new Map<string, number>()
  const waitedMs = new Map<string, number>()
  const startedAt = new Map<string, number>()
  const endedAt = new Map<string, number>()
  // What ended, summed as `slowdown` sums it: read whole at each event, it
  // made a 10 000-task sim quadratic.
  const finished = { took: 0, forecast: 0 }
  const ready = (id: string): void => {
    const t = byId.get(id)!
    if (t.exec && t.ran !== undefined) {
      readyAt.set(id, now)
      executed.add(id)
      queue.add([id])
    } else if (t.ran === undefined && t.cache && (options.restoreMs ?? 0) > 0)
      restoring.set(id, now + options.restoreMs!)
    else end(id)
  }
  const restoring = new Map<string, number>()

  const joined = (): Live[] =>
    workers.filter((w) => w.joinedAt !== undefined && w.leftAt === undefined)
  const starting = (): Live[] =>
    workers.filter((w) => w.joinedAt === undefined && w.cancelledAt === undefined)

  // Workers whose tasks use all their cores now, and tasks sent to one.
  const overloaded = new Set<string>()
  let overSent = 0
  // As the plugin (`Dispatching.next`): what is about to be ready once `id` is given.
  const children = new Map<string, string[]>()
  for (const t of graph)
    for (const d of t.deps) (children.get(d) ?? children.set(d, []).get(d)!).push(t.id)
  const nextOf = (id: string, endsAt: ReadonlyMap<string, number>): Soon[] =>
    (children.get(id) ?? []).flatMap((d) => {
      const t = byId.get(d)!
      if (!t.exec || t.ran === undefined || readyAt.has(d) || done.has(d)) return []
      let at = durationMs(id) ?? UNKNOWN_MS
      for (const x of t.deps) {
        if (x === id || done.has(x)) continue
        const e = endsAt.get(x)
        if (e === undefined) return []
        at = Math.max(at, e - now)
      }
      return [{ need: need(d), at, rank: tail(d), ms: durationMs(d) ?? UNKNOWN_MS }]
    })
  // As the plugin (`Orchestrator.drain`): from then on a worker takes no task.
  const drainAt = new Map<string, number>()
  // As the plugin (`Plan.placed`): the worker the last plan gave each task.
  // And when each it starts late may go (`Plan.after`).
  const placing = new Placing()
  const dispatch = (): void => {
    const draining = (w: Live): boolean => (drainAt.get(w.id) ?? Infinity) <= now
    const all = joined().map((w) => {
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
        platform: w.platform,
        ends: [...w.running.values()].map(
          (r) =>
            [
              Math.max(1, leftMs(r.startedAt + (r.knownMs ?? UNKNOWN_MS) - now)),
              Math.min(r.booked.cores, w.cores),
              Math.min(r.booked.memory, w.memory),
            ] as const,
        ),
        w,
      }
    })
    // Tasks about to be ready: every dependency running or ended (`Orchestrator.soon`).
    const endsAt = new Map<string, number>()
    for (const w of joined())
      for (const r of w.running.values())
        endsAt.set(r.id, now + Math.max(1, leftMs(r.startedAt + (r.knownMs ?? UNKNOWN_MS) - now)))
    const soon: Soon[] = []
    for (const t of graph) {
      if (!t.exec || t.ran === undefined || readyAt.has(t.id) || done.has(t.id)) continue
      let at = 0
      let ok = t.deps.length > 0
      for (const d of t.deps) {
        if (done.has(d)) continue
        const e = endsAt.get(d)
        if (e === undefined) {
          ok = false
          break
        }
        at = Math.max(at, e - now)
      }
      if (ok)
        soon.push({ need: need(t.id), at, rank: tail(t.id), ms: durationMs(t.id) ?? UNKNOWN_MS })
    }
    soon.sort((a, b) => b.rank - a.rank)
    // The live run's own rule (`Orchestrator.pump`).
    // The draining last, for what no other takes now: a run never waits on a drain.
    const to = new Map<string, (typeof all)[number]>()
    for (const bins of [all.filter((b) => !draining(b.w)), all.filter((b) => draining(b.w))])
      if (bins.length > 0)
        for (const [id, b] of queue.pass(bins, {
          deps: (id) => byId.get(id)!.deps,
          ms: durationMs,
          // An exact plan keeps the room itself.
          ...(placing.exact
            ? {}
            : { soon: soon.slice(0, 4 * bins.length + 8), next: (id) => nextOf(id, endsAt) }),
          want: (id) => placing.want(id),
          gate: (id) => placing.gate(id, now),
        })) {
          to.set(id, b)
        }
    for (const [id, bin] of to) {
      const w = bin.w
      if (overloaded.has(w.id)) overSent++
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
      w.ran.push(id)
      waitedMs.set(id, now - readyAt.get(id)!)
      startedAt.set(id, now)
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

  // As the plugin: the last plan, which stands while what it saw holds.
  const last: { forecast?: Forecast } = {}
  const replan = (): void => {
    if (!learned) return
    const likely = options.likely ?? new Set<string>()
    if (executed.size === 0 && likely.size === 0) return
    // As the plugin: what is left takes as much longer than history as what ended did.
    const slow = slowdown([finished])
    const ms = (id: string): number | undefined => {
      const m = durationMs(id)
      return m === undefined ? undefined : m * slow
    }
    // As the plugin: the fastest join of the size this run, else the first worker's.
    const warmUp = (size: string | undefined): number => {
      let least: number | undefined
      for (const w of workers)
        if (w.joinedAt !== undefined && sizeOf.get(w.id)?.name === size)
          least = Math.min(least ?? Infinity, w.joinedAt - w.spawnedAt)
      return least ?? warmUpOf(1)
    }
    // As the plugin (`Orchestrator.spreadsMs`).
    const spread = (size: string): number =>
      spreadMs(
        workers.flatMap((w) =>
          w.joinedAt !== undefined && sizeOf.get(w.id)?.name === size
            ? [w.joinedAt - w.spawnedAt]
            : [],
        ),
      )
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
        platform: w.platform,
        // As the orchestrator: its declared size, which a stand-in starts again.
        size: sizeOf.get(w.id)?.name,
        at: 0,
        ...(drainAt.has(w.id) ? { drainIn: Math.max(0, drainAt.get(w.id)! - now) } : {}),
        idle: jobs.length === 0,
        running: jobs.map((r) => ({
          id: r.id,
          cores: Math.min(
            w.cores,
            Math.max(Math.min(r.booked.cores, w.cores) * over, r.booked.ask?.cores ?? 0),
          ),
          memory: Math.min(Math.max(r.booked.memory, r.booked.ask?.memory ?? 0), w.memory),
          endsIn: (r.knownMs ?? 0) * slow - (now - r.startedAt),
        })),
      })
    }
    const queued = new Set<string>()
    for (const w of starting()) {
      const size = sizeOf.get(w.id)!.name
      if (now - w.spawnedAt > warmUp(size)) queued.add(size)
      planWorkers.push({
        id: w.id,
        cores: w.cores,
        memory: w.memory,
        platform: w.platform,
        size,
        at: Math.max(0, warmUp(size) - (now - w.spawnedAt)),
        idle: false,
        running: [],
        starting: true,
      })
    }
    const held = (t: SimTask): boolean =>
      options.probe !== false &&
      t.cache &&
      (t.ran === undefined || (t.restoreFails === true && !executed.has(t.id)))
    // Read only when the plan reads every task: a plan followed reads none.
    const remaining = {
      *[Symbol.iterator](): Iterator<string> {
        for (const t of graph) if (!done.has(t.id) && !held(t)) yield t.id
      },
    }
    const p = decide({
      remaining,
      nodes,
      executed: likely.size === 0 ? executed : new Set([...likely, ...executed]),
      need,
      durationMs: ms,
      workers: keepLast(planWorkers, options.sizes, started, (p) => (leftOf.get(p) ?? 0) > 0),
      running,
      sizes: options.sizes,
      started,
      final: false,
      warmUpMs: warmUp,
      spreadMs: spread,
      replaceable: true,
      limitMs: deadline === undefined ? undefined : deadline - now,
      known: planned,
      how,
      home: options.home,
      queued,
      last,
      now,
    })
    deadline = now + p.boundMs
    for (const t of p.tasks) planned.add(t.id)
    for (const d of p.drain) drainAt.set(d.id, now + d.inMs)
    placing.set(p, now)
    replaced = p.placed !== undefined
    if (p.release.length > 0 && !remaining[Symbol.iterator]().next().done)
      for (const id of p.release) {
        const w = workers.find((x) => x.id === id)!
        const s = sizeOf.get(id)!
        // As the plugin: one let go after it joined still counts against
        // its size's max; only one cancelled before it joined does not.
        if (w.joinedAt === undefined) {
          w.cancelledAt = now
          started.set(s.name, started.get(s.name)! - 1)
        } else if (w.running.size === 0) w.leftAt = now
        else continue
        goneAt.push({ size: s.name, at: now })
      }
    again = p.againInMs === undefined ? undefined : now + p.againInMs
    for (const s of p.start) {
      if (goneAt.some((g) => g.size === s.name && now - g.at < warmUp(s.name))) churn++
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
        platform: s.platform,
        ran: [],
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
  // One pass an event, as the run pumps once a message: a plan starts or
  // lets workers go, and none it starts joins at once, so a second pass
  // placed nothing and was a quarter of a 10 000-task sim (2026-11-05).
  // As the plugin (`Orchestrator.place`): a new plan's placing is passed
  // at once, its gates moved.
  let replaced = false
  const step = (): void => {
    dispatch()
    replaced = false
    replan()
    if (replaced) dispatch()
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
    next = Math.min(next, placing.next(now) ?? Infinity)
    for (const at of restoring.values()) next = Math.min(next, at)
    if (!learned) next = Math.min(next, options.historyAt!)
    if (next === Infinity) throw new Error(`sim: stuck at ${now} ms with ${queue.size} queued`)
    const dt = next - now
    // Those the plan lets go now: one it starts later or elsewhere keeps no worker idle.
    let mayGo: (string | undefined)[] | undefined
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
        if (queue.size === 0) continue
        mayGo ??= queue.ids().flatMap((id) => {
          const g = placing.gate(id, now)
          return g === 'wait' ? [] : [g.only]
        })
        if (mayGo.some((only) => only === undefined || only === w.id)) w.idleQueuedMs += dt
      }
    }
    now = next
    if (again !== undefined && again <= now) again = undefined
    if (!learned && options.historyAt! <= now) {
      learned = true
      needs.clear()
      tails = tailsMs(nodes, durationMs)
      // As the plugin's refine (`Orchestrator.rerank`).
      queue.rerank()
    }
    for (const w of starting())
      if (joinAt.get(w.id)! <= now) {
        w.joinedAt = now
        placing.joined(w.id, w.id, sizeOf.get(w.id)?.name)
      }
    for (const [id, at] of restoring)
      if (at <= now) {
        restoring.delete(id)
        end(id)
      }
    for (const w of joined())
      for (const r of [...w.running.values()])
        if (r.left <= 1e-6) {
          w.running.delete(r.id)
          w.has.add(r.id)
          endedAt.set(r.id, now)
          if (r.knownMs !== undefined && r.knownMs > 0) {
            finished.took += now - r.startedAt
            finished.forecast += r.knownMs
          }
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
    waitedMs,
    startedAt,
    endedAt,
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
