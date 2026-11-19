// A distributed run played on a virtual clock: core hands over each task
// that misses as its dependencies end, the run decides with the live
// run's own planner (`Planner`, as `Orchestrator.pump`) at every event,
// and workers join after their warm-up and run tasks for as long as they
// took, sharing their cores. Pure and deterministic: a run of minutes
// plays in milliseconds. What the summary's Workers table would say
// comes back with it.

import type { TaskNode } from '@vzn/vx'
import type { Size } from '../src/plan/model.js'
import { Planner, type PlannerSize } from '../src/plan/planner.js'

/** One task of the run: as the CI graph declares it, and how it ran if it missed. */
export interface SimTask {
  readonly id: string
  readonly deps: readonly string[]
  readonly exec: boolean
  readonly cache: boolean
  /**
   * It missed: how long its command ran, the cores it kept busy, its peak
   * memory (bytes), and how long its worker took after the command to
   * check and save it (`afterMs`), its cores free (`Orchestrator.unhold`).
   */
  readonly ran?: {
    readonly ms: number
    readonly cores: number
    readonly memory: number
    readonly afterMs?: number
  }
  /** What history said of it before the run, when that differs from how it ran; null: never measured; no cores: its time alone. */
  readonly known?: {
    readonly ms: number
    readonly cores?: number
    readonly memory: number
    readonly afterMs?: number
  } | null
  /** The platform core placed it on (`TaskNode.platform`). */
  readonly platform?: string
  /** Core's probe found it held, and its restore then failed: it runs (`ran`) once ready. */
  readonly restoreFails?: boolean
  /**
   * Uncached, it leaves files its dependants read (`leaves`): they run on
   * its worker, or run it again first. Else an uncached one leaves none.
   */
  readonly leaves?: boolean
}

export interface SimOptions {
  readonly sizes: readonly Size[]
  /** How long the n-th worker started (1 first), the k-th of its size (`k`), takes to join. */
  readonly warmUpMs?: (n: number, size: string, k: number) => number
  /** Each size's warm-up an earlier run learned (`learned.warmUps`); else 20 s. */
  readonly warmUpsMs?: ReadonlyMap<string, number>
  /** Each size's join spread an earlier run learned (`learned.spreads`): how far apart its joins may land before one does. */
  readonly spreadsMs?: ReadonlyMap<string, number>
  /** The tasks the forecast says miss (`likelyMisses`), before any does. */
  readonly likely?: ReadonlySet<string>
  /** The platform a task naming none runs on (`homeOf`). */
  readonly home?: string
  /** The cores an unmeasured task keeps busy (`dte({ unmeasured })`). */
  readonly unmeasuredCores?: number
  /**
   * Whether core's cache probe answered before the first plan (default
   * true): a held task leaves the run's remaining work at once. False is
   * a probe with no answer: only `likely` is expected until tasks miss.
   */
  readonly probe?: boolean
  /** How long a hit takes to restore (default 0: it ends at once). */
  readonly restoreMs?: number
  /**
   * When history lands (default 0, before any task is ready): until then
   * every task is unmeasured, as on CI, where the default branch's
   * timings come a moment into the run. The first decision waits for it,
   * as the plugin's first ask does.
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
  /** Joined, nothing running, while the run had work left. */
  idleMs: number
  /** Joined, nothing running, while a task of its platform was ready and not started. */
  idleQueuedMs: number
  cpuMs: number
  onlineMs: number
  readonly cores: number
  readonly memory: number
  readonly platform: string | undefined
  /** The tasks it ran. */
  readonly ran: string[]
  /** The most cores its tasks kept busy at once. */
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
  /** Tasks sent to a worker whose running tasks already used all its cores before the decision sent them. */
  readonly overSent: number
  /** Workers asked while one of their size, asked before, was past when it was due to join (`Orchestrator.queued`). */
  readonly askedBehind: number
  /** Each executed task's ms from ready to started. */
  readonly waitedMs: ReadonlyMap<string, number>
  /** Each executed task's start. */
  readonly startedAt: ReadonlyMap<string, number>
  /** Each executed task's end. */
  readonly endedAt: ReadonlyMap<string, number>
  /** Core-ms the run held workers for, warm-ups included: every core from its ask to its leave. */
  readonly heldMs: number
}

interface Running {
  readonly id: string
  readonly cores: number
  readonly memory: number
  /** Its work left, in ms of it running alone. */
  left: number
}

interface Live extends SimWorker {
  readonly size: Size
  readonly joinAt: number
  readonly running: Map<string, Running>
}

const DEFAULT_WARM_UP_MS = 20_000

export function simulate(graph: readonly SimTask[], options: SimOptions): SimResult {
  const warmUpOf = options.warmUpMs ?? (() => DEFAULT_WARM_UP_MS)
  const home = options.home ?? options.sizes[0]?.platform ?? ''
  const byId = new Map(graph.map((t) => [t.id, t]))
  const platformOf = (t: SimTask): string => t.platform ?? home
  const nodes = new Map<string, TaskNode>(
    graph.map((t) => [
      t.id,
      {
        id: t.id,
        deps: t.deps.filter((d) => byId.has(d)),
        platform: platformOf(t),
        config: t.exec ? { exec: { command: 'x' } } : {},
      } as unknown as TaskNode,
    ]),
  )
  let learned = (options.historyAt ?? 0) <= 0
  const known = (id: string) => {
    if (!learned) return undefined
    const t = byId.get(id)!
    return t.known === undefined ? t.ran : (t.known ?? undefined)
  }
  const probe = options.probe ?? true
  // What the run expects to run before any task misses: the forecast, and the probe's misses.
  const expected = new Set(options.likely ?? [])
  if (probe)
    for (const t of graph)
      if (t.exec && t.ran !== undefined && t.restoreFails !== true) expected.add(t.id)
  const sizes: PlannerSize[] = options.sizes.map((s) => ({
    name: s.name,
    cores: s.cpu,
    memory: s.memory,
    max: s.max,
    platform: s.platform ?? home,
    warmUpMs: options.warmUpsMs?.get(s.name) ?? DEFAULT_WARM_UP_MS,
    spreadMs: options.spreadsMs?.get(s.name) ?? 0,
  }))
  const planner = new Planner({
    nodes,
    platform: (n) => n.platform ?? home,
    sizes,
    known: (id) => {
      const k = known(id)
      return k === undefined ? undefined : { ms: k.ms, cores: k.cores, afterMs: k.afterMs }
    },
    expected,
    ...(options.unmeasuredCores === undefined ? {} : { unmeasuredCores: options.unmeasuredCores }),
  })

  let now = 0
  const done = new Set<string>()
  const executed = new Set<string>()
  const workers: Live[] = []
  const byWorker = new Map<string, Live>()
  const started = new Map<string, number>()
  const goneAt: { size: string; at: number }[] = []
  let churn = 0
  let overSent = 0
  let askedBehind = 0
  let due = Infinity
  // Each task that leaves files, and the workers holding them (`Orchestrator.kept`).
  const keptOn = new Map<string, Set<string>>()
  const readsOf = new Map<string, string[]>()
  const reads = (id: string): string[] => {
    let r = readsOf.get(id)
    if (r !== undefined) return r
    const out = new Set<string>()
    for (const d of byId.get(id)!.deps) {
      if (!byId.has(d)) continue
      if (byId.get(d)!.leaves === true) out.add(d)
      for (const x of reads(d)) out.add(x)
    }
    readsOf.set(id, (r = [...out]))
    return r
  }
  const holder = (id: string): string | undefined => {
    for (const u of reads(id))
      for (const on of keptOn.get(u) ?? []) {
        const w = byWorker.get(on)
        if (w !== undefined && w.joinedAt !== undefined && w.leftAt === undefined) return on
      }
    return undefined
  }

  // Core: a task whose dependencies ended either runs (a miss) or ends now.
  const waiting = new Map(graph.map((t) => [t.id, t.deps.filter((d) => byId.has(d)).length]))
  const dependants = new Map<string, string[]>()
  for (const t of graph)
    for (const d of t.deps) if (byId.has(d)) dependants.set(d, [...(dependants.get(d) ?? []), t.id])
  const readyAt = new Map<string, number>()
  const waitedMs = new Map<string, number>()
  const startedAt = new Map<string, number>()
  const endedAt = new Map<string, number>()
  // A hit restoring, or a miss saving after its command: each ends at its time.
  const ending = new Map<string, number>()
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
      readyAt.set(id, now)
      executed.add(id)
      planner.ready(id)
      return
    }
    if (t.exec) planner.drop(id, now)
    if (t.ran === undefined && t.cache && (options.restoreMs ?? 0) > 0)
      ending.set(id, now + options.restoreMs!)
    else end(id)
  }
  // The probe's hits leave the run's work at once.
  if (probe) for (const t of graph) if (t.exec && t.ran === undefined) planner.drop(t.id, 0)

  const queued = (size: string): boolean =>
    workers.some(
      (w) =>
        w.size.name === size &&
        w.joinAt > now &&
        w.cancelledAt === undefined &&
        planner.overdue(w.id, now),
    )
  const spawn = (s: PlannerSize): string => {
    if (queued(s.name)) askedBehind++
    const size = options.sizes.find((x) => x.name === s.name)!
    const k = (started.get(s.name) ?? 0) + 1
    started.set(s.name, k)
    const id = `${s.name}#${k}`
    if (goneAt.some((g) => g.size === s.name && now - g.at < s.warmUpMs)) churn++
    const w: Live = {
      id,
      size,
      spawnedAt: now,
      joinAt: now + warmUpOf(workers.length + 1, s.name, k),
      tasks: 0,
      busyMs: 0,
      idleMs: 0,
      idleQueuedMs: 0,
      cpuMs: 0,
      onlineMs: 0,
      cores: size.cpu,
      memory: size.memory,
      platform: s.platform,
      ran: [],
      peakBooked: 0,
      peakMemory: 0,
      running: new Map(),
    }
    workers.push(w)
    byWorker.set(id, w)
    return id
  }
  const load = (w: Live): number => {
    let s = 0
    for (const r of w.running.values()) s += r.cores
    return s
  }
  const memoryUsed = (w: Live): number => {
    let s = 0
    for (const r of w.running.values()) s += r.memory
    return s
  }
  const decide = (): void => {
    if (!learned) return
    const d = planner.decide(now, spawn, {
      on: (task, worker, at) => {
        const w = byWorker.get(worker)!
        const pin = holder(task)
        if (pin !== undefined && pin !== worker) return false
        const m = known(task)?.memory ?? 0
        return at ? w.memory - memoryUsed(w) >= Math.min(m, w.memory) : true
      },
      load: (worker) => load(byWorker.get(worker)!),
      // One asked now queues behind a worker of its size the CI has not started past when it was due (`Orchestrator.queued`).
      size: (_task, size) => !queued(size.name),
      // It holds files a task to come reads (`Orchestrator.kept`).
      stay: (worker) => {
        for (const [u, on] of keptOn)
          if (on.has(worker) && graph.some((t) => !done.has(t.id) && reads(t.id).includes(u)))
            return true
        return false
      },
    })
    const before = new Map<Live, number>()
    const loadBefore = (w: Live): number => before.get(w) ?? load(w)
    for (const [, worker] of d.start) {
      const w = byWorker.get(worker)!
      if (!before.has(w)) before.set(w, load(w))
    }
    for (const [id, worker] of d.start) {
      const w = byWorker.get(worker)!
      const t = byId.get(id)!
      const ran = t.ran!
      // full as the planner saw it: what this decision itself starts is not yet measured
      if (loadBefore(w) >= w.cores - 1e-9) overSent++
      // Its upstreams' files not here: each runs again first (`Orchestrator.remake`).
      let again = 0
      for (const u of reads(id))
        if (keptOn.get(u)?.has(w.id) !== true) {
          again += byId.get(u)!.ran?.ms ?? 0
          keptOn.get(u)?.add(w.id)
        }
      w.running.set(id, { id, cores: ran.cores, memory: ran.memory, left: ran.ms + again })
      w.tasks++
      w.ran.push(id)
      waitedMs.set(id, now - readyAt.get(id)!)
      startedAt.set(id, now)
      w.peakBooked = Math.max(w.peakBooked, load(w))
      w.peakMemory = Math.max(w.peakMemory, memoryUsed(w))
    }
    for (const worker of d.leave) {
      const w = byWorker.get(worker)!
      if (w.joinedAt === undefined) w.cancelledAt = now
      else w.leftAt = now
      goneAt.push({ size: w.size.name, at: now })
    }
    due = d.due
  }

  const live = (w: Live): boolean => w.leftAt === undefined && w.cancelledAt === undefined
  // Hand over what is ready at the start.
  for (const t of graph) if (waiting.get(t.id) === 0) ready(t.id)
  decide()
  let guard = 0
  while (done.size < graph.length) {
    if (++guard > 10_000_000) throw new Error('sim: no progress')
    let next = due > now ? due : Infinity
    if (!learned) next = Math.min(next, options.historyAt!)
    for (const at of ending.values()) next = Math.min(next, at)
    for (const w of workers) {
      if (!live(w)) continue
      if (w.joinedAt === undefined) next = Math.min(next, w.joinAt)
      const s = Math.max(1, load(w) / w.cores)
      for (const r of w.running.values()) next = Math.min(next, now + r.left * s)
    }
    if (next === Infinity)
      throw new Error(`sim: stuck at ${now} ms with ${graph.length - done.size} left`)
    const dt = next - now
    const queuedOn = new Set<string>()
    for (const id of readyAt.keys()) if (!startedAt.has(id)) queuedOn.add(platformOf(byId.get(id)!))
    for (const w of workers) {
      if (!live(w) || w.joinedAt === undefined) continue
      const l = load(w)
      const s = Math.max(1, l / w.cores)
      if (w.running.size > 0) {
        w.busyMs += dt
        w.cpuMs += dt * Math.min(l, w.cores)
      } else {
        w.idleMs += dt
        if (queuedOn.has(w.platform ?? home)) w.idleQueuedMs += dt
      }
      for (const r of w.running.values()) r.left -= dt / s
    }
    now = next
    if (!learned && now >= options.historyAt!) {
      learned = true
      planner.learn()
    }
    for (const w of workers) {
      if (!live(w)) continue
      if (w.joinedAt === undefined && w.joinAt <= now) {
        w.joinedAt = now
        planner.joined(w.id, now)
      }
      for (const r of [...w.running.values()])
        if (r.left <= 1e-6) {
          w.running.delete(r.id)
          planner.finished(r.id, now, now - startedAt.get(r.id)!)
          const t = byId.get(r.id)!
          if (t.leaves === true) keptOn.set(r.id, new Set([w.id]))
          ending.set(r.id, now + (t.ran?.afterMs ?? 0))
        }
    }
    for (const [id, at] of [...ending])
      if (at <= now) {
        ending.delete(id)
        if (startedAt.has(id)) endedAt.set(id, now)
        end(id)
      }
    decide()
  }
  let heldMs = 0
  for (const w of workers) {
    const until = w.leftAt ?? w.cancelledAt ?? now
    if (w.leftAt === undefined && w.cancelledAt === undefined) w.leftAt = now
    if (w.joinedAt !== undefined) w.onlineMs = (w.leftAt ?? until) - w.joinedAt
    heldMs += w.cores * (until - w.spawnedAt)
  }
  const online = workers.reduce((a, w) => a + w.cores * w.onlineMs, 0)
  const cpu = workers.reduce((a, w) => a + w.cpuMs, 0)
  return {
    endMs: now,
    workers: workers.map(({ running: _r, size: _s, joinAt: _j, ...w }) => w),
    churn,
    executed: executed.size,
    utilization: online > 0 ? cpu / online : 0,
    overSent,
    askedBehind,
    waitedMs,
    startedAt,
    endedAt,
    heldMs,
  }
}

/**
 * The best the run could end: the planner knowing every miss and its
 * time before it starts (the engine given exact numbers, the ideal by
 * which a run is judged), on up to `max` workers of `size`, each joining
 * after `warmUpMs`.
 */
export function bestMs(
  graph: readonly SimTask[],
  size: Size,
  warmUpMs = DEFAULT_WARM_UP_MS,
): number {
  const exact = graph.map((t) => {
    const { known: _k, restoreFails: _f, ...rest } = t
    return rest
  })
  return simulate(exact, {
    sizes: [size],
    warmUpMs: () => warmUpMs,
    warmUpsMs: new Map([[size.name, warmUpMs]]),
  }).endMs
}
