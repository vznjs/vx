// How many workers a run's rest needs, and which idle ones it can let go:
// its known work played out on the workers it has and on N more, as the
// orchestrator would place it, for each N. The run takes the fewest that
// end within a margin of the best, and plays again at each event: a miss
// found, a task done, a worker joined, history read (M, 2026-10-23: "its
// a TETRIS game. every time we get new data we refine next step").

import type { TaskNode } from '@vzn/vx'
import { shares } from './messages.js'

/**
 * A task's duration when history has none: a test suite's, so a run with
 * no history starts workers for its work rather than one for all of it.
 */
const UNKNOWN_MS = 30_000
/** A worker's warm-up before one has joined: CI's took 15 to 23 s (main, 2026-10-23). */
export const WARM_UP_MS = 20_000
/** How much later than the best a plan may end: a few seconds, or 5%. */
const MARGIN_MS = 5_000
const MARGIN = 0.05

/** One kind of worker, as `dte()` resolved it: memory in bytes, `max` Infinity when uncapped. */
export interface Size {
  readonly name: string
  readonly max: number
  readonly cpu: number
  readonly memory: number
}

/** A task to place: what it asks of a worker, how long it takes, and the plan's tasks it waits on. */
export interface PlanTask {
  readonly id: string
  readonly cores: number
  readonly memory: number
  /** It filled a machine this big last time: only a bigger one takes it, if any worker is. */
  readonly above?: { readonly cores: number; readonly memory: number } | undefined
  readonly ms: number | undefined
  readonly deps: readonly string[]
}

/** A worker the plan can place on: from `at` ms on, with what it runs until each ends. */
export interface PlanWorker {
  readonly id: string
  readonly cores: number
  readonly memory: number
  readonly at: number
  readonly running: readonly {
    readonly cores: number
    readonly memory: number
    readonly endsIn: number
  }[]
  /** Holding no task: the run may let it go. */
  readonly idle: boolean
  /** Started and not joined yet: the run may cancel it. */
  readonly starting?: boolean
}

export interface Plan {
  /** Sizes to start now, in order: each the plan gives work within its warm-up. */
  readonly start: readonly Size[]
  /** Idle workers the rest does not need before a new one could join. */
  readonly release: readonly string[]
  /** When the rest ends, from now. */
  readonly endsInMs: number
  /** When to plan again for a worker the plan needs later, from now; undefined for none. */
  readonly againInMs: number | undefined
}

/**
 * Each task's tail: its usual duration and its longest chain of
 * dependants after it, the most of the run that waits on it starting.
 */
export function tailsMs(
  nodes: ReadonlyMap<string, TaskNode>,
  durationMs: (id: string) => number | undefined,
): (id: string) => number {
  const dependants = new Map<string, string[]>()
  for (const [id, n] of nodes)
    for (const d of n.deps) dependants.set(d, [...(dependants.get(d) ?? []), id])
  const tail = new Map<string, number>()
  const visit = (id: string): number => {
    const known = tail.get(id)
    if (known !== undefined) return known
    tail.set(id, 0)
    const runs = nodes.get(id)?.config.exec?.command !== undefined
    let after = 0
    for (const d of dependants.get(id) ?? []) after = Math.max(after, visit(d))
    const t = after + (runs ? (durationMs(id) ?? UNKNOWN_MS) : 0)
    tail.set(id, t)
    return t
  }
  return visit
}

/**
 * `ids`' tasks as the plan takes them: each that runs a command, with
 * what it asks and the tasks it waits on through the groups between.
 */
export function planTasks(
  ids: Iterable<string>,
  nodes: ReadonlyMap<string, TaskNode>,
  need: (id: string) => { cores: number; memory: number; above?: PlanTask['above'] },
  durationMs: (id: string) => number | undefined,
): PlanTask[] {
  const runs = (id: string): boolean => nodes.get(id)?.config.exec?.command !== undefined
  const ran = new Map<string, string[]>()
  const depsOf = (id: string): string[] => {
    const known = ran.get(id)
    if (known !== undefined) return known
    ran.set(id, [])
    const out = (nodes.get(id)?.deps ?? []).flatMap((d) => (runs(d) ? [d] : depsOf(d)))
    ran.set(id, out)
    return out
  }
  return [...ids].filter(runs).map((id) => {
    const n = need(id)
    return {
      id,
      cores: n.cores,
      memory: n.memory,
      above: n.above,
      ms: durationMs(id),
      deps: depsOf(id),
    }
  })
}

/**
 * The run's known work: of `remaining`, each task that runs a command and
 * missed the cache, handed over to run (`executed`), or waits on a cached
 * one that did, its key folding that one's. An uncached task runs every
 * time and changes no dependant's key (check.bun, under every install).
 * Groups and hits are no work: counted, 85 hits of 109 tasks asked 6
 * workers where 2 did (main, 2026-10-23).
 */
export function missedWork(
  remaining: Iterable<string>,
  nodes: ReadonlyMap<string, TaskNode>,
  executed: ReadonlySet<string>,
  need: (id: string) => { cores: number; memory: number; above?: PlanTask['above'] },
  durationMs: (id: string) => number | undefined,
): PlanTask[] {
  const changed = new Map<string, boolean>()
  // Whether `id`'s key changed: a cached task that missed, or one after it.
  const changes = (id: string): boolean => {
    const known = changed.get(id)
    if (known !== undefined) return known
    changed.set(id, false)
    const n = nodes.get(id)
    const c = (executed.has(id) && n?.config.cache !== undefined) || (n?.deps ?? []).some(changes)
    changed.set(id, c)
    return c
  }
  const missed = (id: string): boolean =>
    executed.has(id) || (nodes.get(id)?.deps ?? []).some(changes)
  return planTasks([...remaining].filter(missed), nodes, need, durationMs)
}

interface Slot {
  readonly id: string
  readonly cores: number
  readonly memory: number
  readonly at: number
  usedCores: number
  usedMemory: number
  running: number
  /** When it is first given a task. */
  first?: number
}

/**
 * When `tasks` end on `workers`, each placed as soon as its dependencies
 * end, longest tail first, on the worker it fits with fewest cores free:
 * the orchestrator's own rule (`shares`). Infinity when one never fits.
 */
export function simulate(tasks: readonly PlanTask[], workers: readonly PlanWorker[]): number {
  return play(tasks, workers).end
}

/** `simulate`, with when each worker is first given a task. */
function play(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
): { end: number; first: Map<string, number> } {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const dependants = new Map<string, string[]>()
  const waits = new Map<string, number>()
  for (const t of tasks) {
    let n = 0
    for (const d of t.deps)
      if (byId.has(d)) {
        n++
        dependants.set(d, [...(dependants.get(d) ?? []), t.id])
      }
    waits.set(t.id, n)
  }
  const tail = new Map<string, number>()
  const tailOf = (id: string): number => {
    const known = tail.get(id)
    if (known !== undefined) return known
    let after = 0
    for (const d of dependants.get(id) ?? []) after = Math.max(after, tailOf(d))
    const t = after + (byId.get(id)!.ms ?? UNKNOWN_MS)
    tail.set(id, t)
    return t
  }
  const slots: Slot[] = workers.map((w) => ({
    id: w.id,
    cores: w.cores,
    memory: w.memory,
    at: w.at,
    usedCores: 0,
    usedMemory: 0,
    running: 0,
  }))
  // Ends to come: [at, slot, cores, memory, task or undefined].
  const ends: [number, Slot, number, number, string | undefined][] = []
  workers.forEach((w, i) => {
    const s = slots[i]!
    for (const r of w.running) {
      s.usedCores += r.cores
      s.usedMemory += r.memory
      s.running++
      ends.push([Math.max(0, r.endsIn), s, r.cores, r.memory, undefined])
    }
  })
  const ready = tasks.filter((t) => waits.get(t.id) === 0)
  let left = tasks.length
  let now = 0
  let last = Math.max(0, ...ends.map((e) => e[0]))
  const bigger = (s: Slot, t: PlanTask): boolean =>
    t.above === undefined || s.cores > t.above.cores || s.memory > t.above.memory
  const anyBigger = (t: PlanTask): boolean => slots.some((s) => bigger(s, t))
  for (;;) {
    ready.sort((a, b) => tailOf(b.id) - tailOf(a.id))
    for (let i = 0; i < ready.length;) {
      const t = ready[i]!
      const pool = anyBigger(t) ? slots.filter((s) => bigger(s, t)) : slots
      let best: Slot | undefined
      for (const s of pool) {
        if (s.at > now) continue
        const fits = s.running === 0 || shares({ cores: s.usedCores, memory: s.usedMemory }, t, s)
        if (!fits) continue
        if (best === undefined || s.cores - s.usedCores < best.cores - best.usedCores) best = s
      }
      if (best === undefined) {
        i++
        continue
      }
      ready.splice(i, 1)
      const cores = Math.min(t.cores, best.cores)
      const memory = Math.min(t.memory, best.memory)
      best.usedCores += cores
      best.usedMemory += memory
      best.running++
      best.first ??= now
      const end = now + (t.ms ?? UNKNOWN_MS)
      ends.push([end, best, cores, memory, t.id])
      last = Math.max(last, end)
    }
    const first = (): Map<string, number> =>
      new Map(slots.flatMap((s) => (s.first === undefined ? [] : [[s.id, s.first] as const])))
    if (left === 0 && ready.length === 0) return { end: last, first: first() }
    // The next moment anything changes: a task ends or a worker joins.
    let next = Infinity
    for (const e of ends) next = Math.min(next, e[0])
    for (const s of slots) if (s.at > now) next = Math.min(next, s.at)
    if (next === Infinity) return { end: left === 0 ? last : Infinity, first: first() }
    now = next
    for (let i = 0; i < ends.length;) {
      const [at, s, cores, memory, id] = ends[i]!
      if (at > now) {
        i++
        continue
      }
      ends.splice(i, 1)
      s.usedCores -= cores
      s.usedMemory -= memory
      s.running--
      if (id === undefined) continue
      left--
      for (const d of dependants.get(id) ?? []) {
        const n = waits.get(d)! - 1
        waits.set(d, n)
        if (n === 0) ready.push(byId.get(d)!)
      }
    }
  }
}

/**
 * The workers to start and to let go. The fewest new ones (`candidates`,
 * in the order the run would start them, each joining after `warmUpMs`)
 * whose plan ends within a margin of the best; of those, the ones it gives
 * work within their warm-up start now, the rest when that nears
 * (`againInMs`): a graph that widens later starts its workers later (M,
 * 2026-10-23). An idle worker goes when the plan still ends in that margin
 * with one started in its place, after its warm-up: needed again sooner,
 * it stays, so none is let go and started again.
 */
export function plan(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  candidates: readonly Size[],
  warmUpMs: number,
  // Whether the run can start one in a let-go one's place: not with
  // workers that join on their own.
  replaceable = true,
): Plan {
  const fresh = (s: { cpu: number; memory: number }, id: string, at: number): PlanWorker => ({
    id,
    cores: s.cpu,
    memory: s.memory,
    at,
    running: [],
    idle: false,
  })
  const added = candidates.map((s, i) => fresh(s, `\0new${i}`, warmUpMs))
  const ends: number[] = []
  for (let n = 0; n <= candidates.length; n++) {
    ends.push(simulate(tasks, [...workers, ...added.slice(0, n)]))
    // Past the plan's own length more cannot end it sooner.
    if (n > 0 && ends[n] === ends[n - 1] && ends[n]! <= warmUpMs) break
  }
  const best = Math.min(...ends)
  const bound = best === Infinity ? Infinity : best + Math.max(MARGIN_MS, best * MARGIN)
  const n = Math.max(
    0,
    ends.findIndex((e) => e <= bound),
  )
  let kept = [...workers, ...added.slice(0, n)]
  const release: string[] = []
  if (best < Infinity) {
    // One starting that the plan ends as well without is cancelled before
    // it joins, last to join first; none is started in its place.
    const starting = workers.filter((w) => w.starting === true).sort((a, b) => b.at - a.at)
    for (const w of starting) {
      const without = kept.filter((k) => k !== w)
      if (simulate(tasks, without) <= bound) {
        kept = without
        release.push(w.id)
      }
    }
    // Biggest first: a big idle one costs the most to keep.
    const idle = workers.filter((w) => w.idle).sort((a, b) => b.cores - a.cores)
    for (const w of idle) {
      const without = kept.filter((k) => k !== w)
      const instead = replaceable
        ? [fresh({ cpu: w.cores, memory: w.memory }, w.id, warmUpMs + MARGIN_MS)]
        : []
      if (simulate(tasks, [...without, ...instead]) <= bound) {
        kept = without
        release.push(w.id)
      }
    }
  }
  const { end, first } = play(tasks, kept)
  const start: Size[] = []
  let againInMs: number | undefined
  for (let i = 0; i < n; i++) {
    const at = first.get(added[i]!.id)
    if (at === undefined) continue
    // Given work within its warm-up and a margin: it starts now.
    if (at <= warmUpMs + MARGIN_MS) start.push(candidates[i]!)
    else againInMs = Math.min(againInMs ?? Infinity, at - warmUpMs - MARGIN_MS)
  }
  return { start, release, endsInMs: end, againInMs }
}

/**
 * The sizes the run would start next, in order: for each task that
 * filled its worker last time (`above`), one of the smallest size bigger
 * than it while the run has none of that size; then sizes in declared
 * order up to each one's max.
 */
export function candidates(
  sizes: readonly Size[],
  started: ReadonlyMap<string, number>,
  above: Iterable<{ cores: number; memory: number }>,
  limit: number,
): Size[] {
  const count = new Map(started)
  const out: Size[] = []
  const add = (s: Size): void => {
    count.set(s.name, (count.get(s.name) ?? 0) + 1)
    out.push(s)
  }
  const up = [...sizes].sort((x, y) => x.cpu - y.cpu || x.memory - y.memory)
  for (const a of above) {
    const z = up.find((s) => s.cpu > a.cores || s.memory > a.memory)
    if (z !== undefined && (count.get(z.name) ?? 0) === 0 && z.max > 0) add(z)
  }
  for (const s of sizes) while (out.length < limit && (count.get(s.name) ?? 0) < s.max) add(s)
  return out
}
