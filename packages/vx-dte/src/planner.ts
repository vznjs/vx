// How many workers a run's rest needs, and which idle ones it can let go:
// its known work played out on the workers it has and on N more, as the
// orchestrator would place it, for each N. The run takes the fewest that
// end within a margin of the best, and plays again at each event: a miss
// found, a task done, a worker joined, history read (M, 2026-10-23: "its
// a TETRIS game. every time we get new data we refine next step").

import type { TaskNode } from '@vzn/vx'
import { assign, ordered, type Bin, type Need } from './dispatch.js'
import { DEFAULT_STRATEGY, type Strategy } from './strategy.js'

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
  /** Its machines' platform (`WorkerSize.platform`). */
  readonly platform?: string | undefined
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
  /** The platform core placed it on (`TaskNode.platform`): only a worker of it runs it. */
  readonly platform?: string | undefined
}

/** A worker the plan can place on: from `at` ms on, with what it runs until each ends. */
export interface PlanWorker {
  readonly id: string
  readonly cores: number
  readonly memory: number
  readonly at: number
  readonly running: readonly {
    /** The task: one the plan's tasks wait on waits until it ends. */
    readonly id?: string
    readonly cores: number
    readonly memory: number
    readonly endsIn: number
  }[]
  /** Holding no task: the run may let it go. */
  readonly idle: boolean
  /** Started and not joined yet: the run may cancel it. */
  readonly starting?: boolean
  readonly platform?: string | undefined
  /** The size it was started as (`Size.name`): what its warm-up is learned by. */
  readonly size?: string | undefined
}

/** A worker's warm-up, one for all, or by its size (`Size.name`; none for one that joined on its own). */
export type WarmUp = number | ((size: string | undefined) => number)

const warmOf = (w: WarmUp): ((size: string | undefined) => number) =>
  typeof w === 'number' ? () => w : w

export interface Plan {
  /** Sizes to start now, in order: each the plan gives work within its warm-up. */
  readonly start: readonly Size[]
  /** Idle workers the rest does not need before a new one could join. */
  readonly release: readonly string[]
  /** When the rest ends, from now. */
  readonly endsInMs: number
  /**
   * The latest it may end, from now: the run's deadline, pass it back as
   * `limitMs` while no new work is known, so the margin is spent once.
   */
  readonly boundMs: number
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
  need: (id: string) => Need,
  durationMs: (id: string) => number | undefined,
  home?: string,
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
      cores: n.ask?.cores ?? n.cores,
      memory: n.ask?.memory ?? n.memory,
      above: n.above,
      ms: durationMs(id),
      deps: depsOf(id),
      platform: nodes.get(id)?.platform ?? home,
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
  need: (id: string) => Need,
  durationMs: (id: string) => number | undefined,
  home?: string,
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
  return planTasks([...remaining].filter(missed), nodes, need, durationMs, home)
}

/**
 * The tasks a plan counts as missed: those handed over to run, the
 * misses core's probe found, and of the commit's forecast (`likely`) only
 * those still `remaining`. One the probe found held left `remaining`, and
 * kept in the forecast its dependants counted as work: main e3c76a2 asked
 * workers for 121 tasks, and 16 ran (2026-10-23).
 */
export function knownMisses(
  likely: ReadonlySet<string>,
  sure: ReadonlySet<string>,
  executed: ReadonlySet<string>,
  remaining: ReadonlySet<string>,
): ReadonlySet<string> {
  if (likely.size === 0 && sure.size === 0) return executed
  return new Set([...[...likely].filter((id) => remaining.has(id)), ...sure, ...executed])
}

interface Slot extends Bin {
  readonly at: number
  /** When it is first given a task. */
  first?: number
}

/**
 * When `tasks` end on `workers`, each placed as soon as its dependencies
 * end, longest tail first, on the worker it fits with fewest cores free:
 * the orchestrator's own rule (`assign`). Infinity when one never fits.
 */
export function simulate(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  how: Strategy = DEFAULT_STRATEGY,
): number {
  return play(tasks, workers, how).end
}

/** `simulate`, with when each worker is first given a task. */
function play(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  how: Strategy,
): { end: number; first: Map<string, number> } {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const dependants = new Map<string, string[]>()
  const waits = new Map<string, number>()
  // A dependency running now ends when it does; one ended or a hit, now.
  const runningIds = new Set<string>()
  for (const w of workers) for (const r of w.running) if (r.id !== undefined) runningIds.add(r.id)
  for (const t of tasks) {
    let n = 0
    for (const d of t.deps)
      if (byId.has(d) || runningIds.has(d)) {
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
    platform: w.platform,
    at: w.at,
    used: { cores: 0, memory: 0 },
    running: 0,
  }))
  // Ends to come: [at, slot, cores, memory, task or undefined].
  const ends: [number, Slot, number, number, string | undefined][] = []
  workers.forEach((w, i) => {
    const s = slots[i]!
    for (const r of w.running) {
      s.used.cores += r.cores
      s.used.memory += r.memory
      s.running++
      ends.push([Math.max(0, r.endsIn), s, r.cores, r.memory, r.id])
    }
  })
  const ready = tasks.filter((t) => waits.get(t.id) === 0)
  const widest = Math.max(1, ...workers.map((w) => w.cores))
  let left = tasks.length
  let now = 0
  let last = Math.max(0, ...ends.map((e) => e[0]))
  for (;;) {
    const order = ordered(
      ready.map((t) => t.id),
      how.order,
      tailOf,
      (id) => byId.get(id)!,
      widest,
    )
    ready.splice(0, ready.length, ...order.map((id) => byId.get(id)!))
    const joined = slots.filter((s) => s.at <= now)
    // A task that filled a size waits for a bigger one still to join.
    const later = (above: { cores: number; memory: number }): boolean =>
      slots.some((s) => s.at > now && (s.cores > above.cores || s.memory > above.memory))
    const to = assign(
      ready.map((t) => ({ id: t.id, need: t })),
      joined,
      later,
      how.place,
    )
    for (const [id, best] of to) {
      const t = byId.get(id)!
      ready.splice(ready.indexOf(t), 1)
      best.first ??= now
      const end = now + (t.ms ?? UNKNOWN_MS)
      ends.push([end, best, Math.min(t.cores, best.cores), Math.min(t.memory, best.memory), t.id])
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
      s.used.cores -= cores
      s.used.memory -= memory
      s.running--
      if (id === undefined) continue
      if (byId.has(id)) left--
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
 * in the order the run would start them, each joining after its size's `warmUpMs`)
 * whose plan ends within a margin of the best; of those, the ones it gives
 * work within their warm-up start now, the rest when that nears
 * (`againInMs`): a graph that widens later starts its workers later (M,
 * 2026-10-23). An idle worker goes when the plan still ends in that margin
 * with one started in its place a warm-up later, joining after its own:
 * needed again sooner, it stays, so none is let go and started again.
 */
export function plan(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  candidates: readonly Size[],
  warmUpMs: WarmUp,
  // Whether the run can start one in a let-go one's place: not with
  // workers that join on their own.
  replaceable = true,
  // The latest an earlier plan of the same work allowed, from now.
  limitMs = Infinity,
  how: Strategy = DEFAULT_STRATEGY,
): Plan {
  const warm = warmOf(warmUpMs)
  const fresh = (
    s: { cpu: number; memory: number; platform?: string | undefined; size?: string | undefined },
    id: string,
    at: number,
  ): PlanWorker => ({
    id,
    cores: s.cpu,
    memory: s.memory,
    platform: s.platform,
    ...(s.size === undefined ? {} : { size: s.size }),
    at,
    running: [],
    idle: false,
  })
  const added = candidates.map((s, i) => fresh({ ...s, size: s.name }, `\0new${i}`, warm(s.name)))
  const ends: number[] = []
  for (let n = 0; n <= candidates.length; n++) {
    ends.push(simulate(tasks, [...workers, ...added.slice(0, n)], how))
    // Past the plan's own length more cannot end it sooner.
    if (n > 0 && ends[n] === ends[n - 1] && ends[n]! <= added[n - 1]!.at) break
  }
  const best = Math.min(...ends)
  // Margin spent at each decision adds up: releases 4 s apart each lost
  // 4 s of 5 (tests/sim.test.ts, a growing graph). Spent once, unless the
  // rest can no longer end by then.
  const bound =
    best === Infinity
      ? Infinity
      : Math.max(best, Math.min(best + Math.max(MARGIN_MS, best * MARGIN), limitMs))
  const n = Math.max(
    0,
    ends.findIndex((e) => e <= bound),
  )
  let kept = [...workers, ...added.slice(0, n)]
  const release: string[] = []
  if (best < Infinity) {
    // One starting that the plan ends as well without is cancelled before
    // it joins, last to join first; none is started in its place: a new
    // one of its shape is dropped instead. Main c27c238 cancelled four
    // 17 s into their warm-up and asked seven new ones at once.
    const starting = workers.filter((w) => w.starting === true).sort((a, b) => b.at - a.at)
    for (const w of starting) {
      const twin = kept.find(
        (k) =>
          k.id.startsWith('\0new') &&
          k.cores === w.cores &&
          k.memory === w.memory &&
          k.platform === w.platform,
      )
      const without = kept.filter((k) => k !== (twin ?? w))
      if (simulate(tasks, without, how) <= bound) {
        kept = without
        if (twin === undefined) release.push(w.id)
      }
    }
    // Biggest first: a big idle one costs the most to keep.
    const idle = workers.filter((w) => w.idle).sort((a, b) => b.cores - a.cores)
    for (const w of idle) {
      const without = kept.filter((k) => k !== w)
      if (simulate(tasks, without, how) <= bound) {
        kept = without
        release.push(w.id)
        continue
      }
      // Needed again, it goes only when its next task is two warm-ups
      // away: a stand-in then starts a warm-up after it left. Sooner, the
      // next plan starts one at once: let go as 10 joined at 20 s, one was
      // started again at 20.06 (tests/sim.test.ts, a09b987 forecast).
      if (!replaceable) continue
      const next = play(tasks, kept, how).first.get(w.id)
      if (next !== undefined && next < 2 * warm(w.size) + MARGIN_MS) continue
      const instead = fresh(
        { cpu: w.cores, memory: w.memory, platform: w.platform, size: w.size },
        w.id,
        next ?? Infinity,
      )
      if (simulate(tasks, [...without, instead], how) <= bound) {
        kept = without
        release.push(w.id)
      }
    }
  }
  const { end, first } = play(tasks, kept, how)
  const start: Size[] = []
  let againInMs: number | undefined
  for (let i = 0; i < n; i++) {
    const at = first.get(added[i]!.id)
    if (at === undefined) continue
    // Given work within its warm-up and a margin: it starts now.
    const warmUp = added[i]!.at
    if (at <= warmUp + MARGIN_MS) start.push(candidates[i]!)
    else againInMs = Math.min(againInMs ?? Infinity, at - warmUp - MARGIN_MS)
  }
  return { start, release, endsInMs: end, boundMs: bound, againInMs }
}

/**
 * The sizes the run would start next, in order: for each task that
 * filled its worker last time (`above`), one of the smallest size bigger
 * than it while the run has none of that size; for each platform tasks
 * run on, its sizes in declared order, up to one per task of it; then
 * sizes in declared order up to each one's max.
 */
export function candidates(
  sizes: readonly Size[],
  started: ReadonlyMap<string, number>,
  above: Iterable<{ cores: number; memory: number }>,
  limit: number,
  platforms: ReadonlyMap<string, number> = new Map(),
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
  // A platform the declared order reaches late gets its workers too, one
  // a round each: listed after all of another's, a plan took twelve Linux
  // workers to reach the Mac one (main c27c238 asked 13, cancelled 7).
  const wants = new Map(platforms)
  for (let added = true; added;) {
    added = false
    for (const [platform, tasks] of wants) {
      if (tasks === 0) continue
      const s = sizes.find((x) => x.platform === platform && (count.get(x.name) ?? 0) < x.max)
      if (s === undefined) continue
      add(s)
      wants.set(platform, tasks - 1)
      added = true
    }
  }
  for (const s of sizes) while (out.length < limit && (count.get(s.name) ?? 0) < s.max) add(s)
  return out
}

/**
 * What the run does now, from all it knows: its known work (`missedWork`)
 * less what runs already, played on its workers and on the candidates it
 * may start (`plan`). The live run (`plugin.ts`) and the simulation that
 * holds it to its invariants (tests/sim.ts) both decide here.
 */
export function decide(input: {
  readonly remaining: Iterable<string>
  readonly nodes: ReadonlyMap<string, TaskNode>
  readonly executed: ReadonlySet<string>
  readonly need: (id: string) => Need
  readonly durationMs: (id: string) => number | undefined
  readonly workers: readonly PlanWorker[]
  readonly running: ReadonlySet<string>
  readonly sizes: readonly Size[]
  readonly started: ReadonlyMap<string, number>
  /** No worker may be started: a planned run's last, or one without an adapter. */
  readonly final: boolean
  readonly warmUpMs: WarmUp
  readonly replaceable: boolean
  /** The last plan's `boundMs`, less the time since: kept while `known` holds all its work. */
  readonly limitMs?: number | undefined
  /** The work earlier plans knew. */
  readonly known?: ReadonlySet<string>
  /** How it orders, places and scales (`need` books already). */
  readonly how?: Strategy
  /** The platform a task naming none runs on (`homeOf`). */
  readonly home?: string | undefined
}): Plan & { readonly tasks: readonly PlanTask[] } {
  const how = input.how ?? DEFAULT_STRATEGY
  const tasks = missedWork(
    input.remaining,
    input.nodes,
    input.executed,
    input.need,
    input.durationMs,
    input.home,
  ).filter((t) => !input.running.has(t.id))
  const platforms = new Map<string, number>()
  for (const t of tasks)
    if (t.platform !== undefined) platforms.set(t.platform, (platforms.get(t.platform) ?? 0) + 1)
  const sizes = input.final
    ? []
    : candidates(
        input.sizes,
        input.started,
        tasks.flatMap((t) => t.above ?? []),
        tasks.length,
        platforms,
      )
  if (how.scale === 'backlog')
    return { ...backlog(tasks, input.workers, sizes, input.warmUpMs, how), tasks }
  const p = plan(
    tasks,
    input.workers,
    sizes,
    input.warmUpMs,
    input.replaceable,
    // New work moves the deadline; work done or known already does not.
    tasks.every((t) => input.known?.has(t.id) === true) ? input.limitMs : undefined,
    how,
  )
  return { ...p, tasks }
}

/**
 * Spark's dynamic allocation: workers enough for the cores that what is
 * ready or running asks, started at once; an idle one past that leaves.
 * No play-out: it sees only the work that waits now.
 */
function backlog(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  candidates: readonly Size[],
  warmUpMs: WarmUp,
  how: Strategy,
): Plan {
  const ids = new Set(tasks.map((t) => t.id))
  const running = new Set<string>()
  for (const w of workers) for (const r of w.running) if (r.id !== undefined) running.add(r.id)
  const widest = Math.max(1, ...workers.map((w) => w.cores), ...candidates.map((c) => c.cpu))
  let asked = 0
  for (const t of tasks)
    if (t.deps.every((d) => !ids.has(d) && !running.has(d))) asked += Math.min(t.cores, widest)
  for (const w of workers) for (const r of w.running) asked += r.cores
  let have = 0
  for (const w of workers) have += w.cores
  const start: Size[] = []
  for (const c of candidates) {
    if (have >= asked - 1e-9) break
    start.push(c)
    have += c.cpu
  }
  const release: string[] = []
  for (const w of workers)
    if (w.idle && have - w.cores >= asked - 1e-9) {
      release.push(w.id)
      have -= w.cores
    }
  const kept = [
    ...workers.filter((w) => !release.includes(w.id)),
    ...start.map((c, i): PlanWorker => ({
      id: `\0new${i}`,
      cores: c.cpu,
      memory: c.memory,
      platform: c.platform,
      size: c.name,
      at: warmOf(warmUpMs)(c.name),
      running: [],
      idle: false,
    })),
  ]
  const end = simulate(tasks, kept, how)
  return { start, release, endsInMs: end, boundMs: end, againInMs: undefined }
}
