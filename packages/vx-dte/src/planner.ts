// How many workers a run's rest needs, and which idle ones it can let go:
// its known work played out on the workers it has and on N more, as the
// orchestrator would place it, for each N. The run takes the fewest that
// end within a margin of the best, and plays again at each event: a miss
// found, a task done, a worker joined, history read (2026-10-23: "its
// a TETRIS game. every time we get new data we refine next step").

import type { TaskNode } from '@vzn/vx'
import {
  assign,
  dead,
  kindOf,
  ordered,
  type Ask,
  type Bin,
  type Bounds,
  type Need,
} from './dispatch.js'
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

/** History the run's finished tasks must have had before `slowdown` says anything. */
const SLOWDOWN_MS = 20_000

/**
 * How much longer than history the run's finished tasks took (`took` ms,
 * `forecast` ms), at least 1, once they had 20 s of history: the plan
 * stretches what is left by it. A task past its forecast was planned to
 * end now, so a run whose tasks took twice theirs planned 27 s left for
 * 100 s, asked a worker, cancelled it as not needed, and asked again (PR
 * #4192, 2026-10-23).
 */
export function slowdown(done: Iterable<{ took: number; forecast: number | undefined }>): number {
  let took = 0
  let forecast = 0
  for (const d of done)
    if (d.forecast !== undefined && d.forecast > 0) {
      took += d.took
      forecast += d.forecast
    }
  return forecast < SLOWDOWN_MS ? 1 : Math.max(1, took / forecast)
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
    for (const d of n.deps) {
      const list = dependants.get(d)
      if (list === undefined) dependants.set(d, [id])
      else list.push(id)
    }
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
 * time, so it is work before it is handed over, and changes no dependant's
 * key (check.bun, under every install). Counted only once handed over,
 * main e38d1d2's first plan missed check.build-cold behind its install and
 * asked one Mac for a 37 s lane that ran to 120 s (2026-10-24).
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
  const missed = (id: string): boolean => {
    const n = nodes.get(id)
    return (
      executed.has(id) ||
      (n !== undefined && (n.config.cache === undefined || n.deps.some(changes)))
    )
  }
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
): { end: number; first: Map<string, number>; ends: Map<string | undefined, number> } {
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
        // Pushed, not copied: copying made one install under 9000 tasks
        // 40 million copies a play (2026-10-25).
        const list = dependants.get(d)
        if (list === undefined) dependants.set(d, [t.id])
        else list.push(t.id)
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
  // Ready tasks, ordered again only once one joins (`graphene`: or
  // leaves): each step sorted every ready task, and a run of 9000 spent
  // its orchestrator planning (2026-10-25).
  const ready = new Ready(tasks)
  let joining = tasks.filter((t) => waits.get(t.id) === 0)
  let readyCount = joining.length
  const spent = new Set<string>()
  const bounds: Bounds = { done: false, open: true, free: 0, cores: 0, memory: 0 }
  // Ready tasks by what they need: no ready task needs less than the
  // least of these, and a pass ends once no slot takes that.
  const needs = new Map<string, { cores: number; memory: number; n: number }>()
  // Their least, read again only once a kind on it leaves: each step read
  // every kind, and 9000 kinds made it quadratic (2026-10-25).
  let floor: { cores: number; memory: number } | undefined
  const count = (t: PlanTask, by: number): void => {
    const k = ready.kindOf(t.id)
    const e = needs.get(k)
    if (e === undefined) {
      needs.set(k, { cores: t.cores, memory: t.memory, n: by })
      if (floor !== undefined)
        floor = { cores: Math.min(floor.cores, t.cores), memory: Math.min(floor.memory, t.memory) }
    } else if ((e.n += by) === 0) {
      needs.delete(k)
      if (floor !== undefined && (e.cores <= floor.cores || e.memory <= floor.memory))
        floor = undefined
    }
  }
  for (const t of joining) count(t, 1)
  const widest = Math.max(1, ...workers.map((w) => w.cores))
  let left = tasks.length
  let now = 0
  let last = Math.max(0, ...ends.map((e) => e[0]))
  // When each platform's last task ends.
  const byPlatform = new Map<string | undefined, number>()
  for (;;) {
    if (joining.length > 0 || ready.stale) {
      // By the longest chain, those still ready keep their order and the
      // joining are merged in: sorted again with each join, a 9000-task
      // tree sorted 17 million a plan (2026-10-25).
      const merge = how.order === 'critical-path' && !ready.stale
      const order = ordered(
        (merge ? joining : [...ready.live(), ...joining]).map((t) => t.id),
        how.order,
        tailOf,
        (id) => byId.get(id)!,
        widest,
      )
      if (merge) ready.add(order, tailOf)
      else ready.reset(order)
      joining = []
    }
    const joined = slots.filter((s) => s.at <= now)
    // A task that filled a size waits for a bigger one still to join.
    const later = (above: { cores: number; memory: number }, platform?: string): boolean =>
      slots.some(
        (s) =>
          s.at > now &&
          (platform === undefined || s.platform === platform) &&
          (s.cores > above.cores || s.memory > above.memory),
      )
    const to = assign(ready.asks(spent, bounds, needs.size), joined, later, how.place, {
      floor: (floor ??= floorOf(needs.values())),
      kinds: needs.size,
      spent,
      bounds,
    })
    // `graphene` ranks against the longest chain still ready.
    if (to.size > 0 && how.order === 'graphene') ready.stale = true
    for (const [id, best] of to) {
      const t = byId.get(id)!
      ready.take(id)
      readyCount--
      count(t, -1)
      best.first ??= now
      const end = now + (t.ms ?? UNKNOWN_MS)
      ends.push([end, best, Math.min(t.cores, best.cores), Math.min(t.memory, best.memory), t.id])
      last = Math.max(last, end)
      byPlatform.set(best.platform, Math.max(byPlatform.get(best.platform) ?? 0, end))
    }
    const first = (): Map<string, number> =>
      new Map(slots.flatMap((s) => (s.first === undefined ? [] : [[s.id, s.first] as const])))
    if (left === 0 && readyCount === 0) return { end: last, first: first(), ends: byPlatform }
    // The next moment anything changes: a task ends or a worker joins.
    let next = Infinity
    for (const e of ends) next = Math.min(next, e[0])
    for (const s of slots) if (s.at > now) next = Math.min(next, s.at)
    if (next === Infinity)
      return { end: left === 0 ? last : Infinity, first: first(), ends: byPlatform }
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
        if (n === 0) {
          joining.push(byId.get(d)!)
          readyCount++
          count(byId.get(d)!, 1)
        }
      }
    }
  }
}

/**
 * The workers to start and to let go. The fewest new ones (`candidates`,
 * in the order the run would start them, each joining after its size's `warmUpMs`)
 * whose plan ends within a margin of the best; of those, the ones it gives
 * work within their warm-up start now, the rest when that nears
 * (`againInMs`): a graph that widens later starts its workers later
 * (2026-10-23). An idle worker goes when the plan still ends in that margin
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
  // Sizes come in turns, so the prefix can hold one the plan ends as soon
  // without: a second Mac the plan needed came after a second Linux worker
  // it did not, and main e118ccf cancelled that one unjoined (2026-10-24).
  // Dropped only when neither the end nor its platform's moves past the
  // margin: to the run's end alone, a 110 s guess of an unmeasured chain
  // cut every other platform to it.
  let before = best < Infinity && n > 0 ? play(tasks, kept, how) : undefined
  if (before !== undefined)
    for (let i = n - 1; i >= 0; i--) {
      const platform = added[i]!.platform
      const without = kept.filter((k) => k !== added[i])
      const after = play(tasks, without, how)
      if (
        after.end <= before.end &&
        (after.ends.get(platform) ?? 0) <= (before.ends.get(platform) ?? 0) + MARGIN_MS
      ) {
        kept = without
        before = after
      }
    }
  const release: string[] = []
  // Played with the rest: left out, the next idle one and the plan's end
  // counted on a worker the run lets go.
  const standIns: PlanWorker[] = []
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
      // Asked, it goes only when the plan gives it no task: within the
      // margin, the next plan's estimates moved a second later and
      // cancelled 7 asked one at a time (PR #4214); ending the run no
      // sooner, main 005e8f2 cancelled a mac and asked one again 18 s on.
      if (
        twin === undefined
          ? !play(tasks, kept, how).first.has(w.id)
          : simulate(tasks, without, how) <= bound
      ) {
        kept = without
        if (twin === undefined) release.push(w.id)
      }
    }
    // Biggest first: a big idle one costs the most to keep. Joined, its
    // warm-up is spent: it goes when the plan gives it no task, not when
    // the run ends within the margin without it (main e05bd71 let a mac go
    // that way and asked another 4 s later).
    const idle = workers.filter((w) => w.idle).sort((a, b) => b.cores - a.cores)
    // A stand-in is one of the run's next starts of its size, not kept for
    // other work. With none (its size's `max` spent: one let go still
    // counts), the arm worker of a max-1 size went idle between two arm
    // tasks, was let go, and the second found no worker (fuzz, 2026-10-25).
    const spare = new Map<string, number>()
    candidates.forEach((s, i) => {
      if (!kept.includes(added[i]!)) spare.set(s.name, (spare.get(s.name) ?? 0) + 1)
    })
    for (const w of idle) {
      const without = kept.filter((k) => k !== w)
      const next = play(tasks, [...kept, ...standIns], how).first.get(w.id)
      if (next === undefined) {
        kept = without
        release.push(w.id)
        continue
      }
      // Needed again, it goes only when its next task is two warm-ups
      // away: a stand-in then starts a warm-up after it left. Sooner, the
      // next plan starts one at once: let go as 10 joined at 20 s, one was
      // started again at 20.06 (tests/sim.test.ts, a09b987 forecast).
      if (!replaceable) continue
      if (next < 2 * warm(w.size) + MARGIN_MS) continue
      const left = w.size === undefined ? 0 : (spare.get(w.size) ?? 0)
      if (left === 0) continue
      const instead = fresh(
        { cpu: w.cores, memory: w.memory, platform: w.platform, size: w.size },
        w.id,
        next,
      )
      if (simulate(tasks, [...without, ...standIns, instead], how) <= bound) {
        kept = without
        release.push(w.id)
        standIns.push(instead)
        spare.set(w.size!, left - 1)
      }
    }
  }
  const { end, first } = play(tasks, [...kept, ...standIns], how)
  const start: Size[] = []
  let againInMs: number | undefined
  for (let i = 0; i < n; i++) {
    const at = first.get(added[i]!.id)
    if (at === undefined) continue
    // Given work within its warm-up and a margin: it starts now.
    const warmUp = added[i]!.at
    // Within a millisecond counts: `againInMs` of 1e-10 replanned the
    // same plan 100,000 times at one instant (tests/sim.test.ts).
    if (at < warmUp + MARGIN_MS + 1) start.push(candidates[i]!)
    else againInMs = Math.min(againInMs ?? Infinity, at - warmUp - MARGIN_MS)
  }
  return { start, release, endsInMs: end, boundMs: bound, againInMs }
}

/**
 * The sizes the run would start next, in order: for each task that
 * filled its worker last time (`above`), one of the smallest size of its platform bigger
 * than it while the run has none of that size; for each platform tasks
 * run on, its sizes in declared order, up to one per task of it; then
 * sizes in declared order up to each one's max.
 */
export function candidates(
  sizes: readonly Size[],
  started: ReadonlyMap<string, number>,
  above: Iterable<{ cores: number; memory: number; platform?: string | undefined }>,
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
    const z = up.find(
      (s) =>
        (a.platform === undefined || s.platform === a.platform) &&
        (s.cpu > a.cores || s.memory > a.memory),
    )
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
  /**
   * Sizes with a worker asked and not joined past its warm-up: the CI
   * queued it, and one asked now queues behind it. None of them starts.
   */
  readonly queued?: ReadonlySet<string>
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
        input.queued === undefined
          ? input.sizes
          : input.sizes.filter((s) => !input.queued!.has(s.name)),
        input.started,
        tasks.flatMap((t) => (t.above === undefined ? [] : [{ ...t.above, platform: t.platform }])),
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
  // Cores asked and had, all told and of each platform a task names: only
  // a worker of it runs such a task, so spare Linux cores left a Mac task
  // waiting for a Mac worker never started.
  let asked = 0
  let have = 0
  const askedOf = new Map<string, number>()
  const haveOf = new Map<string, number>()
  const add = (m: Map<string, number>, p: string | undefined, n: number): void => {
    if (p !== undefined) m.set(p, (m.get(p) ?? 0) + n)
  }
  for (const t of tasks)
    if (t.deps.every((d) => !ids.has(d) && !running.has(d))) {
      const cores = Math.min(t.cores, widest)
      asked += cores
      add(askedOf, t.platform, cores)
    }
  for (const w of workers)
    for (const r of w.running) {
      asked += r.cores
      add(askedOf, w.platform, r.cores)
    }
  for (const w of workers) {
    have += w.cores
    add(haveOf, w.platform, w.cores)
  }
  const short = (p: string | undefined): boolean =>
    p !== undefined && (haveOf.get(p) ?? 0) < (askedOf.get(p) ?? 0) - 1e-9
  const start: Size[] = []
  for (const c of candidates) {
    if (have >= asked - 1e-9 && !short(c.platform)) continue
    start.push(c)
    have += c.cpu
    add(haveOf, c.platform, c.cpu)
  }
  const release: string[] = []
  for (const w of workers)
    if (
      w.idle &&
      have - w.cores >= asked - 1e-9 &&
      (w.platform === undefined ||
        (haveOf.get(w.platform) ?? 0) - w.cores >= (askedOf.get(w.platform) ?? 0) - 1e-9)
    ) {
      release.push(w.id)
      have -= w.cores
      add(haveOf, w.platform, -w.cores)
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

/** The most kinds `Ready.asks` jumps across; past it, it reads every task. */
const MAX_JUMP_KINDS = 32

/**
 * Ready tasks in the order `ordered` gave, by kind (`kindOf`): `assign`
 * reads them in that order, a kind it found spent skipped in one jump,
 * where it read every ready task each step (2026-10-25). A task is its
 * place in the play's tasks, and its rank (`before`) is fixed once it
 * joins: rebuilt with each join, a 9000-task tree hashed every ready
 * task 17 million times a plan (2026-10-25).
 */
class Ready {
  private readonly ids: readonly string[]
  private readonly at: Map<string, number>
  private readonly kindAt: readonly string[]
  private readonly taken: Uint8Array
  /** The rank: the lower `primary` first, then the lower `seq`. */
  private readonly primary: Float64Array
  private readonly seq: Float64Array
  private next = 0
  /** In rank order; taken ones linger until the next join. */
  private order: number[] = []
  private kinds = new Map<string, number[]>()
  /** Each kind's first task not taken. */
  private readonly head = new Map<string, number>()
  /** No task before this place in `order` is left: a pass began at 0 and read 9000 taken ones (2026-10-25). */
  private lo = 0
  /** Order it again before the next step. */
  stale = false

  constructor(private readonly tasks: readonly PlanTask[]) {
    this.ids = tasks.map((t) => t.id)
    this.at = new Map(this.ids.map((id, i) => [id, i]))
    this.kindAt = tasks.map(kindOf)
    this.taken = new Uint8Array(tasks.length)
    this.primary = new Float64Array(tasks.length)
    this.seq = new Float64Array(tasks.length)
  }

  kindOf(id: string): string {
    return this.kindAt[this.at.get(id)!]!
  }

  take(id: string): void {
    this.taken[this.at.get(id)!] = 1
  }

  live(): PlanTask[] {
    return this.order.flatMap((i) => (this.taken[i] === 1 ? [] : [this.tasks[i]!]))
  }

  /** Joins `ids`, longest tail first, behind every ready task of a tail as long. */
  add(ids: readonly string[], tail: (id: string) => number): void {
    const batch = ids.map((id) => {
      const i = this.at.get(id)!
      this.primary[i] = -tail(id)
      this.seq[i] = this.next++
      return i
    })
    this.join(batch)
  }

  /** Ready tasks are `ids` alone, in that order. */
  reset(ids: readonly string[]): void {
    this.order = []
    this.kinds = new Map()
    this.head.clear()
    this.stale = false
    const batch = ids.map((id) => {
      const i = this.at.get(id)!
      this.primary[i] = 0
      this.seq[i] = this.next++
      return i
    })
    this.join(batch)
  }

  private before(a: number, b: number): boolean {
    const pa = this.primary[a]!
    const pb = this.primary[b]!
    return pa < pb || (pa === pb && this.seq[a]! < this.seq[b]!)
  }

  /** `a` without its taken ones, and `b`, in rank order. */
  private merge(a: readonly number[], b: readonly number[]): number[] {
    const out: number[] = []
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && this.taken[a[i]!] === 1) i++
      else if (j === b.length || (i < a.length && this.before(a[i]!, b[j]!))) out.push(a[i++]!)
      else out.push(b[j++]!)
    }
    return out
  }

  private join(batch: readonly number[]): void {
    this.order = this.merge(this.order, batch)
    this.lo = 0
    const by = new Map<string, number[]>()
    for (const i of batch) {
      const k = this.kindAt[i]!
      const q = by.get(k)
      if (q === undefined) by.set(k, [i])
      else q.push(i)
    }
    // Kinds keep the order's: a kind left with no task is gone, as one
    // ordered again from scratch.
    const kinds = new Map<string, number[]>()
    for (const [k, q] of this.kinds) {
      const merged = this.merge(q, by.get(k) ?? [])
      by.delete(k)
      if (merged.length > 0) kinds.set(k, merged)
    }
    for (const [k, q] of by) kinds.set(k, q)
    this.kinds = kinds
    this.head.clear()
  }

  /** In order, past each kind in `spent` as `assign` reads it then. */
  *asks(spent: Set<string>, bounds?: Bounds, kinds?: number): Generator<Ask> {
    // Measured needs are unrounded, so kinds can be as many as tasks: a
    // jump across every kind then cost more than a read of every task.
    if (this.kinds.size > MAX_JUMP_KINDS) {
      while (this.lo < this.order.length && this.taken[this.order[this.lo]!] === 1) this.lo++
      for (let p = this.lo; p < this.order.length; p++) {
        const i = this.order[p]!
        const kind = this.kindAt[i]!
        if (this.taken[i] === 1 || spent.has(kind)) continue
        if (bounds?.done === true || (kinds !== undefined && spent.size >= kinds)) return
        const t = this.tasks[i]!
        if (bounds !== undefined && dead(t, bounds)) spent.add(kind)
        else yield { id: t.id, need: t, kind }
      }
      return
    }
    const at = new Map<string, number>()
    let cursor = -1
    for (;;) {
      let next = -1
      let nextKind = ''
      for (const [k, q] of this.kinds) {
        if (spent.has(k)) continue
        let p = at.get(k) ?? this.headOf(k, q)
        if (p < q.length && cursor !== -1 && !this.before(cursor, q[p]!))
          p = this.after(q, p, cursor)
        while (p < q.length && this.taken[q[p]!] === 1) p++
        at.set(k, p)
        if (p < q.length && (next === -1 || this.before(q[p]!, next))) {
          next = q[p]!
          nextKind = k
        }
      }
      if (next === -1) return
      at.set(nextKind, at.get(nextKind)! + 1)
      cursor = next
      const t = this.tasks[next]!
      yield { id: t.id, need: t, kind: nextKind }
    }
  }

  private headOf(k: string, q: readonly number[]): number {
    let h = this.head.get(k) ?? 0
    while (h < q.length && this.taken[q[h]!] === 1) h++
    this.head.set(k, h)
    return h
  }

  /** The first place from `p` in `q` ranked past `cursor`. */
  private after(q: readonly number[], p: number, cursor: number): number {
    let hi = q.length
    while (p < hi) {
      const mid = (p + hi) >> 1
      if (!this.before(cursor, q[mid]!)) p = mid + 1
      else hi = mid
    }
    return p
  }
}

function floorOf(needs: Iterable<{ cores: number; memory: number }>): {
  cores: number
  memory: number
} {
  let cores = Infinity
  let memory = Infinity
  for (const n of needs) {
    cores = Math.min(cores, n.cores)
    memory = Math.min(memory, n.memory)
  }
  return { cores, memory }
}
