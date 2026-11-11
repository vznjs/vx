// How many workers a run's rest needs, and which idle ones it can let go:
// its known work played out on the workers it has and on N more, as the
// orchestrator would place it. The best end is all N's; one of the N
// starts only when a task reaches its latest start for that end with no
// room elsewhere. The run plays again at each event: a miss
// found, a task done, a worker joined, history read (2026-10-23: "its
// a TETRIS game. every time we get new data we refine next step").

import type { TaskNode } from '@vzn/vx'
import {
  assign,
  dead,
  allFailAlike,
  failsAlike,
  fits,
  kindOf,
  ordered,
  type Ask,
  type Bin,
  holdFor,
  type Bounds,
  type Kept,
  type Need,
  type Soon,
  type Span,
} from './dispatch.js'
import { DEFAULT_STRATEGY, type Strategy } from './strategy.js'

/** Where a task naming no platform runs, or (several worker types) where each task runs. */
type Home = string | ((node: TaskNode) => string | undefined)

/**
 * A task's duration when history has none: a test suite's, so a run with
 * no history starts workers for its work rather than one for all of it.
 */
export const UNKNOWN_MS = 30_000
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
  /** Its number in the run's graph and its deps' (`planTasks`): a plan's shape reads them, not ids. */
  readonly n?: number
  readonly depsN?: Int32Array
  /** Its servers' bases (`Need.servers`): booked once on each worker. */
  readonly servers?: Need['servers']
}

/** The run's tasks numbered once, and each one's deps by number. */
interface Numbered {
  readonly of: Map<string, Node>
  readonly ids: readonly string[]
}

/** A task of the run's graph: its number, whether it runs, the tasks that run it waits on. */
interface Node {
  readonly n: number
  readonly node: TaskNode
  readonly runs: boolean
  deps?: string[]
  depsN?: Int32Array
}

/** The numbering each `depsN` is of. */
const numberedOf = new WeakMap<Int32Array, Numbered>()

/** A number for each of `nodes`, once a run. */
const numbers = new WeakMap<ReadonlyMap<string, TaskNode>, Numbered>()

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
    /** Below 0: past its time by as much. */
    readonly endsIn: number
  }[]
  /** Holding no task: the run may let it go. */
  readonly idle: boolean
  /** Started and not joined yet: the run may cancel it. */
  readonly starting?: boolean
  readonly platform?: string | undefined
  /** The size it was started as (`Size.name`): what its warm-up is learned by. */
  readonly size?: string | undefined
  /** The servers it runs, each with the base booked there. */
  readonly serving?: ReadonlyMap<string, number> | undefined
  /** One the run may start: the play starts it only when a task needs it (`play`'s `deadline`), joining `at` ms after. */
  readonly dormant?: boolean
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
 * What a plan foresees past its decisions, so the run follows it without
 * playing it again: when each worker's last task in it ends (one idle
 * before that is between tasks), when each start it wants later is due,
 * and when each started now ends its work.
 */
interface Ahead {
  /** When the window it played moves on, from now: plan again then. */
  readonly untilInMs: number | undefined
  readonly freeInMs: ReadonlyMap<string, number>
  /** The tasks it gives each worker. */
  readonly given: ReadonlyMap<string, readonly string[]>
  readonly later: readonly {
    readonly size: Size
    readonly inMs: number
    readonly freeInMs: number
    readonly joinInMs: number
    readonly given: readonly string[]
  }[]
  /** For each started now, when its work ends, when it joins and what it runs. */
  readonly started: readonly {
    readonly freeInMs: number
    readonly joinInMs: number
    readonly given: readonly string[]
  }[]
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
  home?: Home,
): PlanTask[] {
  // The graph is the run's, fixed: each task is numbered and its deps
  // walked once a run, not at each plan (2026-11-05: a 5000-task sim
  // spent a quarter here), and read by one lookup (2026-11-06).
  let num = numbers.get(nodes)
  if (num === undefined) {
    const of = new Map<string, Node>()
    const all: string[] = []
    for (const [id, node] of nodes) {
      of.set(id, { n: all.length, node, runs: node.config.exec?.command !== undefined })
      all.push(id)
    }
    numbers.set(nodes, (num = { of, ids: all }))
  }
  const { of } = num
  const depsOf = (e: Node): string[] => {
    if (e.deps !== undefined) return e.deps
    e.deps = []
    // Each once: a group's deps joined as lists held a task once per path
    // to it, and a diamond of groups 380 projects deep listed 2e9 for
    // one task's 570; the first plan never returned (2026-11-11).
    const out = new Set<string>()
    for (const d of e.node.deps) {
      const x = of.get(d)
      if (x === undefined) continue
      if (x.runs) out.add(d)
      else for (const dd of depsOf(x)) out.add(dd)
    }
    return (e.deps = [...out])
  }
  const out: PlanTask[] = []
  for (const id of ids) {
    const e = of.get(id)
    if (e === undefined || !e.runs) continue
    const n = need(id)
    const deps = depsOf(e)
    if (e.depsN === undefined) {
      e.depsN = Int32Array.from(deps, (d) => of.get(d)!.n)
      numberedOf.set(e.depsN, num)
    }
    out.push({
      id,
      cores: n.ask?.cores ?? n.cores,
      memory: n.ask?.memory ?? n.memory,
      above: n.above,
      ms: durationMs(id),
      deps,
      platform: typeof home === 'function' ? home(e.node) : (e.node.platform ?? home),
      n: e.n,
      depsN: e.depsN,
      ...(n.servers === undefined ? {} : { servers: n.servers }),
    })
  }
  return out
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
  home?: Home,
): PlanTask[] {
  const changed = new Map<string, boolean>()
  // Whether `id`'s key changed: a cached task that missed, or one after it.
  const changes = (id: string): boolean => {
    const known = changed.get(id)
    if (known !== undefined) return known
    changed.set(id, false)
    const n = nodes.get(id)
    const c = (executed.has(id) && n?.config.cache === true) || (n?.deps ?? []).some(changes)
    changed.set(id, c)
    return c
  }
  const missed = (id: string): boolean => {
    const n = nodes.get(id)
    return (
      executed.has(id) || (n !== undefined && (n.config.cache !== true || n.deps.some(changes)))
    )
  }
  return planTasks([...remaining].filter(missed), nodes, need, durationMs, home)
}

/**
 * `workers` as a plan may let them go: of a platform whose sizes can start
 * no other (`max` spent; one let go still counts), the last idle one stays
 * while a task of that platform has not ended (`left`). A hit core's probe
 * found can still miss when its restore fails, and only a worker of its
 * platform runs it: main let its one arm worker go, check.binary.linux-arm64
 * came back as a miss, and the run waited out its timeout (2026-11-06).
 */
export function keepLast(
  workers: readonly PlanWorker[],
  sizes: readonly Size[],
  started: ReadonlyMap<string, number>,
  left: (platform: string) => boolean,
): readonly PlanWorker[] {
  const of = new Map<string, PlanWorker[]>()
  for (const w of workers) {
    if (w.platform === undefined) continue
    const all = of.get(w.platform)
    if (all === undefined) of.set(w.platform, [w])
    else all.push(w)
  }
  let kept: Set<PlanWorker> | undefined
  for (const [platform, all] of of) {
    // A busy one is not let go; one starting, cancelled, frees its start.
    if (all.some((w) => !w.idle && w.starting !== true)) continue
    const idle = all.find((w) => w.idle && w.starting !== true)
    if (idle === undefined) continue
    const own = sizes.filter((s) => s.platform === platform)
    if (own.length === 0 || own.some((s) => (started.get(s.name) ?? 0) < s.max)) continue
    if (!left(platform)) continue
    ;(kept ??= new Set()).add(idle)
  }
  return kept === undefined
    ? workers
    : workers.map((w) => (kept!.has(w) ? { ...w, idle: false } : w))
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

/** A dormant worker a play started, and when the task it started for got ready. */
interface Wake {
  readonly id: string
  /** From when it had room: its first task's ready, no sooner than its warm-up. */
  readonly readyAt: number
}

/**
 * What a running task has left: past its time, as long again as it is
 * over, not none. Counted as ending now, a filler running three times its
 * history kept the room a critical task was held, the plan started no
 * worker for it, and it waited 100 s (2026-11-10).
 */
export const leftMs = (endsIn: number): number => (endsIn >= 0 ? endsIn : -endsIn)

/** How many times its guess a task of no history may run: its chain's start comes that much sooner. */
const RISK = 2

/**
 * How many times its chain a task's latest start leaves before the end:
 * history is a guess, and a task with slack that waits on it ran late
 * when tasks took up to 3 times theirs. Counted once, 0.5 to 3 times off
 * ended 2.2% late against 1.1% for starting at once; three times, 0.7%
 * (lab, 2026-11-10: "Wall time > efficiency").
 */
const CHAIN_TIMES = 3
/** Lanes a core: what a play's claims count room in. */
const LANES = 4

interface Slot extends Bin {
  at: number
  /** Not started: `play` starts it when a task needs it, and it joins `warm` ms on. */
  dormant?: boolean
  readonly warm: number
  /** When each quarter-core is free, soonest first (`claim`): made as first read. */
  lanes?: number[]
  /** Its tasks' ends to come, cores and memory: when it has room again. */
  readonly endsAt: [at: number, cores: number, memory: number][]
  /** When it is first given a task. */
  first?: number
  /** When its last task ends. */
  free?: number
  /** When its last task given in the play ends. */
  last?: number
  /** The tasks given it in the play. */
  given?: string[]
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
  // Played no further: past it the rest ends no sooner than its longest
  // chain from there (2026-11-05: "We can plan as we go till next level";
  // "it can look ahead 2 warmups").
  horizon = Infinity,
  // Given, a worker is started only when a ready task needs it: none
  // started or running has room for it before its latest start (this
  // less its chain), so a task with slack waits for room the run pays
  // for anyway, and the critical path never waits (2026-11-10: "start
  // them when economically the best ... Otherwise we spawn as soon as
  // possible").
  deadline?: number,
  // Read for its wakes only: it ends once no dormant one is left to start.
  wakesOnly = false,
): {
  end: number
  /** It stopped at `horizon` with work left. */
  cut?: boolean
  first: Map<string, number>
  ends: Map<string | undefined, number>
  free: () => Map<string, number>
  given: () => Map<string, readonly string[]>
  /** The dormant workers it started (`deadline`), in order. */
  wakes: readonly Wake[]
} {
  // A dependency running now ends when it does; one ended or a hit, now.
  const runningIds = new Set<string>()
  for (const w of workers) for (const r of w.running) if (r.id !== undefined) runningIds.add(r.id)
  const { byId, after, afterAt, indexOf, waitedAt, tailOf, tailAt, riskAt, blindAt, kinds } =
    shapeOf(tasks, runningIds)
  // By place, not id: maps keyed by id were a 5000-task play's most time (2026-11-05).
  const waits = waitedAt.slice()
  // Econ plays keep room for tasks about to be ready (`holdFor`): each
  // task's dependencies not started yet, and when the last started ends.
  const unstarted = deadline === undefined ? undefined : waitedAt.slice()
  const readyAt = deadline === undefined ? undefined : new Float64Array(tasks.length)
  const coming = new Set<number>()
  if (unstarted !== undefined)
    for (const w of workers)
      for (const r of w.running)
        for (const d of (r.id === undefined ? undefined : after.get(r.id)) ?? []) {
          readyAt![d] = Math.max(readyAt![d]!, leftMs(r.endsIn))
          if (--unstarted[d]! === 0) coming.add(d)
        }
  const slots: Slot[] = workers.map((w) => ({
    id: w.id,
    cores: w.cores,
    memory: w.memory,
    platform: w.platform,
    at: w.dormant === true ? Infinity : w.at,
    ...(w.dormant === true ? { dormant: true } : {}),
    warm: w.at,
    endsAt: [],
    used: { cores: [...(w.serving?.values() ?? [])].reduce((a, b) => a + b, 0), memory: 0 },
    running: 0,
    serving: new Set(w.serving?.keys()),
  }))
  // Ends to come: [at, slot, cores, memory, task or undefined].
  const ends = new Ends()
  workers.forEach((w, i) => {
    const s = slots[i]!
    for (const r of w.running) {
      s.used.cores += r.cores
      s.used.memory += r.memory
      s.running++
      ends.push(leftMs(r.endsIn), s, r.cores, r.memory, -1, r.id)
      s.endsAt.push([leftMs(r.endsIn), r.cores, r.memory])
      s.free = Math.max(s.free ?? 0, leftMs(r.endsIn))
    }
  })
  // Ready tasks, ordered again only once one joins (`graphene`: or
  // leaves): each step sorted every ready task, and a run of 9000 spent
  // its orchestrator planning (2026-10-25).
  const ready = new Ready(tasks, kinds)
  let joining = tasks.filter((_, i) => waits[i] === 0)
  let readyCount = joining.length
  const spent = new Set<string>()
  const kept: Kept[] = []
  // Proved to fail, as `assign` would skip it: yielded to it, each ask was
  // most of a plan of 3,800 tasks (2026-11-11).
  const proved: Proof = {
    one: (place) =>
      unstarted !== undefined &&
      failsAlike(kept, tasks[place]!, tailAt(place), tasks[place]!.ms ?? UNKNOWN_MS),
    all: (span) => unstarted !== undefined && allFailAlike(kept, span),
    rank: tailAt,
  }
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
  let last = Math.max(0, ends.last())
  // Core-ms of the tasks not yet given.
  const workLeft = new Map<string | undefined, number>()
  const spend = (t: PlanTask, by: number): void => {
    const w = by * t.cores * (t.ms ?? UNKNOWN_MS)
    workLeft.set(undefined, (workLeft.get(undefined) ?? 0) + w)
    if (t.platform !== undefined) workLeft.set(t.platform, (workLeft.get(t.platform) ?? 0) + w)
  }
  if (horizon < Infinity) for (const t of tasks) spend(t, 1)
  // When each platform's last task ends.
  const byPlatform = (): Map<string | undefined, number> => {
    const out = new Map<string | undefined, number>()
    for (const s of slots)
      if (s.last !== undefined) out.set(s.platform, Math.max(out.get(s.platform) ?? 0, s.last))
    return out
  }
  // The joined slots, read again once the next one joins.
  let joined: Slot[] = []
  let nextJoin = -Infinity
  // A task that filled a size waits for a bigger one still to join.
  const later = (above: { cores: number; memory: number }, platform?: string): boolean =>
    slots.some(
      (s) =>
        s.at > now &&
        (platform === undefined || s.platform === platform) &&
        (s.cores > above.cores || s.memory > above.memory),
    )
  let dormant = slots.filter((s) => s.dormant === true)
  // Each ask's rank and time, for the holds: only in econ plays.
  function* ranked(asks: Iterable<Ask>): Generator<Ask> {
    if (unstarted === undefined) return yield* asks
    for (const a of asks) {
      const t = byId.get(a.id)!
      yield { ...a, rank: tailOf(a.id), ms: t.ms ?? UNKNOWN_MS }
    }
  }
  const wakes: Wake[] = []
  /** Ready places whose chain runs through a task of no history, in rank order. */
  let blindQ: number[] = []
  let blindHead = 0
  /** `t`'s quarter-cores on `s`, at least one, at most all. */
  const lanesFor = (s: Slot, t: PlanTask): number =>
    Math.min(s.lanes!.length, Math.max(1, Math.ceil(t.cores * LANES - 1e-9)))
  /** `k` of `s`'s soonest-free lanes, busy from `from` until `until`. */
  const occupy = (s: Slot, k: number, from: number, until: number): void => {
    const lanes = s.lanes!
    k = Math.min(lanes.length, Math.max(1, k))
    for (let i = 0; i < k; i++)
      lanes[i] = Math.max(until, lanes[i]! > from ? lanes[i]! + until - from : until)
    lanes.sort((a, b) => a - b)
  }
  /**
   * Whether `x` may take `t`, as `assign` places: its platform, and
   * bigger than a size `t` filled while any worker of the run is.
   */
  const suits = (x: Slot, t: PlanTask): boolean => {
    if (t.platform !== undefined && x.platform !== t.platform) return false
    const a = t.above
    if (a === undefined || x.cores > a.cores || x.memory > a.memory) return true
    return !slots.some(
      (y) =>
        (t.platform === undefined || y.platform === t.platform) &&
        (y.cores > a.cores || y.memory > a.memory),
    )
  }
  /**
   * The dormant ones it started, in order, after those still joining
   * with nothing given: a task late before any joined took a new one
   * over one already asked (2026-11-10).
   */
  const woken: Slot[] =
    deadline === undefined
      ? []
      : slots.filter((s) => s.dormant !== true && s.at > now && s.running === 0)
  for (const s of woken)
    s.lanes = Array.from({ length: Math.max(1, Math.round(s.cores * LANES)) }, () => s.at)
  /**
   * `t` given `s` at `at`, maybe past: a worker started at a task's
   * latest start had room since that task got ready, so later tasks at
   * theirs fill it back to then, as if it had started for the first as
   * soon as it could. Its end counts no sooner than now.
   */
  const giveAt = (t: PlanTask, s: Slot, at: number): void => {
    const place = indexOf.get(t.id)!
    const ms = t.ms ?? UNKNOWN_MS
    const end = Math.max(now, at + ms)
    const cores = Math.min(t.cores, s.cores)
    const memory = Math.min(t.memory, s.memory)
    ready.take(t.id)
    readyCount--
    count(t, -1)
    s.first = Math.min(s.first ?? Infinity, at)
    ;(s.given ??= []).push(t.id)
    s.free = Math.max(s.free ?? 0, end)
    s.last = Math.max(s.last ?? 0, end)
    last = Math.max(last, end)
    s.used.cores += cores
    s.used.memory += memory
    s.running++
    s.endsAt.push([end, cores, memory])
    ends.push(end, s, cores, memory, place, undefined)
    occupy(s, lanesFor(s, t), at, at + ms)
    if (horizon < Infinity) spend(t, -1)
    for (const d of afterAt(place)) {
      readyAt![d] = Math.max(readyAt![d]!, end)
      if (--unstarted![d]! === 0) coming.add(d)
    }
  }
  /**
   * `t`, at its latest start: into the room of a worker the play
   * started, back to when that one's first task got ready; else a
   * dormant one starts for it. Whether it gave or started one.
   */
  const late = (t: PlanTask, latest: number, start = true): boolean => {
    const r = readyAt![indexOf.get(t.id)!]!
    let into: Slot | undefined
    let intoAt = Infinity
    for (const x of woken) {
      if (!suits(x, t)) continue
      const at = Math.max(r, x.lanes![lanesFor(x, t) - 1]!)
      if (at < intoAt) {
        into = x
        intoAt = at
      }
    }
    // Room now, or as the worker it would take joins: no new one.
    if (!start)
      return (
        into !== undefined &&
        intoAt <= Math.max(now, into.at) + 1e-6 &&
        (giveAt(t, into, intoAt), true)
      )
    // A new one only when it gives sooner than the room the play already
    // pays for: past its latest start, a task of no history woke one
    // each, at 7.6 times the least worker time (2026-11-10).
    const s = dormant.find((x) => suits(x, t))
    const fresh = s === undefined ? Infinity : Math.max(s.warm, r)
    if (into === undefined || intoAt > Math.max(latest, now) + 1e-6) {
      // None to start: assign gives it room as it frees, not a lane of
      // the future (a 6000-task plan claimed those for 21 s, 2026-11-10).
      if (s === undefined) return false
      if (into !== undefined && intoAt <= fresh) return (giveAt(t, into, intoAt), true)
      s.dormant = false
      s.at = Math.max(now, s.warm)
      dormant = dormant.filter((x) => x !== s)
      s.lanes = Array.from({ length: Math.max(1, Math.round(s.cores * LANES)) }, () => fresh)
      woken.push(s)
      wakes.push({ id: s.id, readyAt: fresh })
      into = s
      intoAt = fresh
    }
    giveAt(t, into, intoAt)
    return true
  }
  /**
   * Each ready task at its latest start (`deadline` less its chain):
   * into the room of a worker the play started, back to when that one's
   * first task got ready; else a dormant one starts for it. Ranked by
   * chain, the waiting at their latest start come first, so a step reads
   * only those: each waiting one checked against each worker at each
   * step planned 9000 in a minute (2026-11-10). Whether it gave or
   * started one now.
   */
  const wake = (by: number): boolean => {
    let changed = false
    // Chains through a task of no history, each as it gets ready; one
    // finding no worker leaves the rest, in rank order, for later.
    for (; blindHead < blindQ.length; blindHead++) {
      const t = tasks[blindQ[blindHead]!]!
      if (!ready.live(t.id)) continue
      if (!late(t, now, false)) break
      changed = true
    }
    // With no worker left to start, a task takes only room that frees by
    // its latest start, never past `by`: with none such, none is read
    // (9000 ready tasks, each read at each step past the end, 2026-11-10).
    const room = dormant.length > 0 || woken.some((x) => x.lanes![0]! <= Math.max(by, now) + 1e-6)
    // Unset, not Infinity: a whole worker is asked as Infinity cores.
    let failed: number | undefined
    for (const t of room ? ready.from() : []) {
      if (by - tailOf(t.id) * CHAIN_TIMES > now + 1e-6) break
      const latest = by - riskAt(indexOf.get(t.id)!) * CHAIN_TIMES
      if (latest > now + 1e-6) continue
      // Each read here asks for room by now: one of any platform, ready by
      // now, that found none in so many lanes and no worker to start leaves
      // none for as many.
      const k = Math.max(1, Math.ceil(t.cores * LANES - 1e-9))
      const plain = t.platform === undefined && t.above === undefined
      if (plain && failed !== undefined && k >= failed) continue
      if (late(t, latest)) changed = true
      else if (plain && readyAt![indexOf.get(t.id)!]! <= now + 1e-6) {
        failed = k
        if (k === 1) break
      }
    }
    nextJoin = -Infinity
    return changed
  }
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
      if (deadline !== undefined) {
        for (const id of order) {
          const i = indexOf.get(id)!
          if (blindAt(i)) blindQ.push(i)
        }
        if (!merge) {
          blindQ = [...new Set(blindQ.slice(blindHead))]
          blindHead = 0
        }
      }
      joining = []
    }
    if (now >= nextJoin) {
      joined = slots.filter((s) => s.at <= now)
      nextJoin = Infinity
      for (const s of slots) if (s.at > now) nextJoin = Math.min(nextJoin, s.at)
    }
    // With none ready nothing is given: a third of a sim's steps (2026-11-05).
    // Nor with no worker room for the least ready: holds keep room only
    // from the asks, which `assign` then reads none of. Each step held for
    // a worker's count of tasks on full workers (2026-11-11).
    if (
      unstarted !== undefined &&
      readyCount > 0 &&
      joined.some((s) => fits(s, (floor ??= floorOf(needs.values()))))
    ) {
      const soon: Soon[] = []
      for (const d of coming) {
        if (waits[d] === 0) {
          coming.delete(d)
          continue
        }
        const t = tasks[d]!
        soon.push({ need: t, at: readyAt![d]! - now, rank: tailAt(d), ms: t.ms ?? UNKNOWN_MS })
      }
      soon.sort((a, b) => b.rank - a.rank)
      for (const s of joined)
        s.ends = s.endsAt.filter((e) => e[0] > now).map(([at, c, m]) => [at - now, c, m] as const)
      holdFor(joined, soon.slice(0, 4 * joined.length + 8))
    }
    const to =
      readyCount === 0
        ? NONE
        : assign(ranked(ready.asks(spent, bounds, needs.size, proved)), joined, later, how.place, {
            floor: (floor ??= floorOf(needs.values())),
            kinds: needs.size,
            spent,
            kept,
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
      ;(best.given ??= []).push(id)
      best.free = Math.max(best.free ?? 0, now + (t.ms ?? UNKNOWN_MS))
      if (best.lanes !== undefined) occupy(best, lanesFor(best, t), now, now + (t.ms ?? UNKNOWN_MS))
      if (unstarted !== undefined)
        for (const d of afterAt(indexOf.get(id)!)) {
          readyAt![d] = Math.max(readyAt![d]!, now + (t.ms ?? UNKNOWN_MS))
          if (--unstarted[d]! === 0) coming.add(d)
        }
      if (deadline !== undefined)
        best.endsAt.push([
          now + (t.ms ?? UNKNOWN_MS),
          Math.min(t.cores, best.cores),
          Math.min(t.memory, best.memory),
        ])
      const end = now + (t.ms ?? UNKNOWN_MS)
      ends.push(
        end,
        best,
        Math.min(t.cores, best.cores),
        Math.min(t.memory, best.memory),
        indexOf.get(id)!,
        undefined,
      )
      last = Math.max(last, end)
      best.last = Math.max(best.last ?? 0, end)
      if (horizon < Infinity) spend(t, -1)
    }
    const first = (): Map<string, number> =>
      new Map(slots.flatMap((s) => (s.first === undefined ? [] : [[s.id, s.first] as const])))
    const free = (): Map<string, number> =>
      new Map(slots.flatMap((s) => (s.free === undefined ? [] : [[s.id, s.free] as const])))
    const given = (): Map<string, readonly string[]> =>
      new Map(slots.flatMap((s) => (s.given === undefined ? [] : [[s.id, s.given] as const])))
    if (deadline !== undefined && readyCount > 0 && wake(deadline)) {
      nextJoin = -Infinity
      continue
    }
    if (wakesOnly && dormant.length === 0)
      return { end: Infinity, cut: true, first: first(), ends: byPlatform(), free, given, wakes }
    if (left === 0 && readyCount === 0)
      return { end: last, first: first(), ends: byPlatform(), free, given, wakes }
    // The next moment anything changes: a task ends or a worker joins.
    let next = ends.next()
    for (const s of slots) if (s.at > now) next = Math.min(next, s.at)
    // The first waiting task's latest start: a worker may start for it then.
    if (deadline !== undefined && dormant.length > 0 && readyCount > 0) {
      const h = ready.first()
      if (h !== undefined && deadline - riskAt(indexOf.get(h.id)!) * CHAIN_TIMES > now + 1e-6)
        next = Math.min(next, deadline - riskAt(indexOf.get(h.id)!) * CHAIN_TIMES)
    }
    if (next >= horizon && next < Infinity) {
      // No sooner than its longest chain, nor than its work spread on
      // every core it has: the workers it asks later are the next plan's.
      // Of each platform on its own workers, and all of it on all.
      const work = new Map(workLeft)
      const cores = new Map<string | undefined, number>()
      for (const s of slots) {
        cores.set(undefined, (cores.get(undefined) ?? 0) + s.cores)
        if (s.platform !== undefined) cores.set(s.platform, (cores.get(s.platform) ?? 0) + s.cores)
      }
      // A running task's rest on its own platform too: counted on all
      // alone, a Mac fewer read the Linux end later (2026-11-07).
      for (const e of ends.all()) {
        const w = e.cores * (e.at - now)
        work.set(undefined, (work.get(undefined) ?? 0) + w)
        const p = e.s.platform
        if (p !== undefined) work.set(p, (work.get(p) ?? 0) + w)
      }
      let end = last
      for (const [p, w] of work) end = Math.max(end, now + w / Math.max(cores.get(p) ?? 0, 1e-9))
      for (const t of ready.live()) end = Math.max(end, now + tailOf(t.id))
      for (const e of ends.all())
        for (const d of (e.place >= 0 ? afterAt(e.place) : after.get(e.id!)) ?? [])
          end = Math.max(end, e.at + tailAt(d))
      return { end, cut: true, first: first(), ends: byPlatform(), free, given, wakes }
    }
    if (next === Infinity)
      return {
        end: left === 0 ? last : Infinity,
        first: first(),
        ends: byPlatform(),
        free,
        given,
        wakes,
      }
    now = next
    while (ends.next() <= now) {
      const { s, cores, memory, place, id } = ends.pop()
      s.used.cores -= cores
      s.used.memory -= memory
      s.running--
      if (place >= 0) left--
      else if (id === undefined) continue
      for (const d of (place >= 0 ? afterAt(place) : after.get(id!)) ?? []) {
        if (--waits[d]! === 0) {
          joining.push(tasks[d]!)
          readyCount++
          count(tasks[d]!, 1)
        }
      }
    }
  }
}

const NONE: ReadonlyMap<string, Slot> = new Map()

interface End {
  at: number
  seq: number
  s: Slot
  cores: number
  memory: number
  /** The task's place in the play, or -1 for one running when it began (`id`). */
  place: number
  id: string | undefined
}

/**
 * A play's ends to come, soonest first, ties in the order given: a scan
 * of every running task at each step was most of a 20 000-task play
 * (2026-11-05).
 */
class Ends {
  private readonly heap: End[] = []
  private seq = 0
  private readonly before = (a: End, b: End): boolean =>
    a.at < b.at || (a.at === b.at && a.seq < b.seq)
  push(
    at: number,
    s: Slot,
    cores: number,
    memory: number,
    place: number,
    id: string | undefined,
  ): void {
    const h = this.heap
    const e: End = { at, seq: this.seq++, s, cores, memory, place, id }
    let i = h.length
    h.push(e)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.before(e, h[p]!)) break
      h[i] = h[p]!
      i = p
    }
    h[i] = e
  }
  next(): number {
    return this.heap[0]?.at ?? Infinity
  }
  all(): readonly End[] {
    return this.heap
  }
  last(): number {
    let most = 0
    for (const e of this.heap) most = Math.max(most, e.at)
    return most
  }
  pop(): End {
    const h = this.heap
    const top = h[0]!
    const e = h.pop()!
    if (h.length > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= h.length) break
        const c = l + 1 < h.length && this.before(h[l + 1]!, h[l]!) ? l + 1 : l
        if (!this.before(h[c]!, e)) break
        h[i] = h[c]!
        i = c
      }
      h[i] = e
    }
    return top
  }
}

/** What `play` reads of `tasks` alone, for each play of one plan. */
interface Shape {
  readonly byId: { get(id: string): PlanTask | undefined }
  /** Each running task's dependants, by their place in the tasks. */
  readonly after: ReadonlyMap<string, readonly number[]>
  /** Each task's dependants by its place, and its place by id: a lookup by id at each end was most of a play. */
  readonly afterAt: (place: number) => Int32Array
  readonly indexOf: { get(id: string): number | undefined }
  /** How many dependencies each task, by its place, waits on before the play begins. */
  readonly waitedAt: Int32Array
  readonly tailOf: (id: string) => number
  readonly tailAt: (place: number) => number
  /** `tailAt`, each task of no history counted `RISK` times its guess: how soon its chain must start. */
  readonly riskAt: (place: number) => number
  /** Whether its chain runs through a task of no history: no slack it can prove. */
  readonly blindAt: (place: number) => boolean
  readonly kinds: Kinds
}

/**
 * `tasks`' shape, made once while what runs stays the same: a plan plays
 * them 20 to 40 times, and each play made it again, its tails and kinds
 * too (2026-11-05).
 */
function shapeOf(tasks: readonly PlanTask[], running: ReadonlySet<string>): Shape {
  const runs = [...running].sort().join('\0')
  const had = shapes.get(tasks)
  if (had !== undefined && had.runs === runs) return had.shape
  // Of a running task only, by id: one in the work is by its place.
  const after = new Map<string, number[]>()
  const waitedAt = new Int32Array(tasks.length)
  const first = tasks[0]?.depsN
  const num =
    first !== undefined && tasks.every((t) => t.depsN !== undefined)
      ? numberedOf.get(first)
      : undefined
  let edges = 0
  for (let i = 0; i < tasks.length; i++) edges += tasks[i]!.deps.length
  // Each dependency's place in the work, -1 when not in it.
  const depAt = new Int32Array(edges)
  let indexOf: { get(id: string): number | undefined }
  if (num !== undefined) {
    // By the run's numbers, not ids: a map of a million ids, made and
    // read at each plan, was most of its time (2026-11-06).
    const place = new Int32Array(num.ids.length).fill(-1)
    for (let i = 0; i < tasks.length; i++) place[tasks[i]!.n!] = i
    // Indexed: iterators over a million tasks' deps were a third of the shape.
    for (let e = 0, i = 0; i < tasks.length; i++) {
      const ds = tasks[i]!.depsN!
      for (let k = 0; k < ds.length; k++) depAt[e++] = place[ds[k]!]!
    }
    indexOf = {
      get: (id) => {
        const n = num.of.get(id)?.n
        const j = n === undefined ? -1 : place[n]!
        return j < 0 ? undefined : j
      },
    }
  } else {
    // One map by id, the rest by place: a map of each by id made a
    // 10 000-task plan's shape a third of its time (2026-11-05).
    const of = new Map<string, number>()
    for (let i = 0; i < tasks.length; i++) of.set(tasks[i]!.id, i)
    let e = 0
    for (const t of tasks) for (const d of t.deps) depAt[e++] = of.get(d) ?? -1
    indexOf = of
  }
  // Each task's dependants in one array, by place: an array each, pushed
  // to, was most of a million-task shape (2026-11-06).
  const start = new Int32Array(tasks.length + 1)
  for (let e = 0, i = 0; i < tasks.length; i++) {
    const deps = tasks[i]!.deps
    let n = 0
    for (let k = 0; k < deps.length; k++, e++) {
      const j = depAt[e]!
      if (j >= 0) {
        start[j + 1]!++
        n++
      } else if (running.has(deps[k]!)) {
        n++
        const at = after.get(deps[k]!)
        if (at === undefined) after.set(deps[k]!, [i])
        else at.push(i)
      }
    }
    waitedAt[i] = n
  }
  for (let i = 0; i < tasks.length; i++) start[i + 1]! += start[i]!
  const list = new Int32Array(start[tasks.length]!)
  const fill = start.slice(0, tasks.length)
  for (let e = 0, i = 0; i < tasks.length; i++)
    for (let k = tasks[i]!.deps.length; k > 0; k--, e++) {
      const j = depAt[e]!
      if (j >= 0) list[fill[j]!++] = i
    }
  const afterAt = (i: number): Int32Array => list.subarray(start[i]!, start[i + 1]!)
  const tail = new Float64Array(tasks.length).fill(-1)
  const tailAt = (i: number): number => {
    if (tail[i]! >= 0) return tail[i]!
    let most = 0
    for (let k = start[i]!; k < start[i + 1]!; k++) most = Math.max(most, tailAt(list[k]!))
    return (tail[i] = most + (tasks[i]!.ms ?? UNKNOWN_MS))
  }
  const tailOf = (id: string): number => tailAt(indexOf.get(id)!)
  // The same with each task history has no time for counted RISK times its guess.
  const risk = new Float64Array(tasks.length).fill(-1)
  const riskAt = (i: number): number => {
    if (risk[i]! >= 0) return risk[i]!
    let most = 0
    for (let k = start[i]!; k < start[i + 1]!; k++) most = Math.max(most, riskAt(list[k]!))
    return (risk[i] = most + (tasks[i]!.ms ?? UNKNOWN_MS * RISK))
  }
  const blind = new Int8Array(tasks.length).fill(-1)
  const blindAt = (i: number): boolean => {
    if (blind[i]! >= 0) return blind[i] === 1
    let any = tasks[i]!.ms === undefined
    for (let k = start[i]!; !any && k < start[i + 1]!; k++) any = blindAt(list[k]!)
    blind[i] = any ? 1 : 0
    return any
  }
  const byId = { get: (id: string) => tasks[indexOf.get(id)!] }
  const shape = {
    byId,
    after,
    afterAt,
    indexOf,
    waitedAt,
    tailOf,
    tailAt,
    riskAt,
    blindAt,
    kinds: { at: indexOf, kindAt: lazyKinds(tasks) },
  }
  shapes.set(tasks, { runs, shape })
  return shape
}
const shapes = new WeakMap<readonly PlanTask[], { runs: string; shape: Shape }>()

/** Each task's place in `tasks` and its kind (`kindOf`). */
interface Kinds {
  readonly at: { get(id: string): number | undefined }
  readonly kindAt: (place: number) => string
}

/**
 * Each task's kind, made as a play first reads it: made for every task,
 * a million float-to-string keys were a fifth of a plan, and a play
 * windowed to two warm-ups reads few of them (2026-11-06).
 */
function lazyKinds(tasks: readonly PlanTask[]): (place: number) => string {
  // Packed: an array of holes filled by place read as a dictionary, most
  // of a 3,800-task plan of varied needs (2026-11-11). No kind is empty.
  const kinds = Array.from<string>({ length: tasks.length }).fill('')
  return (i) => kinds[i] || (kinds[i] = kindOf(tasks[i]!))
}

function kindsOf(tasks: readonly PlanTask[]): Kinds {
  return { at: new Map(tasks.map((t, i) => [t.id, i])), kindAt: lazyKinds(tasks) }
}

/**
 * No play of `tasks` ends sooner: each chain of them in a row, from when
 * the running tasks it waits on end, and each running task's end.
 */
function chainMs(tasks: readonly PlanTask[], workers: readonly PlanWorker[]): number {
  const runningIds = new Set<string>()
  const endsAt = new Map<string, number>()
  for (const w of workers)
    for (const r of w.running)
      if (r.id !== undefined) {
        runningIds.add(r.id)
        endsAt.set(r.id, Math.max(endsAt.get(r.id) ?? 0, leftMs(r.endsIn)))
      }
  const { tailAt, after } = shapeOf(tasks, runningIds)
  let most = 0
  for (const w of workers) for (const r of w.running) most = Math.max(most, leftMs(r.endsIn))
  // From the running tasks' dependants: each task's deps read by id was
  // most of a million-task plan's bound (2026-11-06).
  const from = new Float64Array(tasks.length)
  for (const [id, ds] of after)
    for (const i of ds) from[i] = Math.max(from[i]!, endsAt.get(id) ?? 0)
  for (let i = 0; i < tasks.length; i++) most = Math.max(most, from[i]! + tailAt(i))
  return most
}

/** Two workers a play cannot tell apart, but by their place. */
const twins = (a: PlanWorker, b: PlanWorker): boolean =>
  a.cores === b.cores && a.memory === b.memory && a.platform === b.platform && a.at === b.at

type Played = ReturnType<typeof play>

/**
 * `kept` less each of `added` (its last ones, in the order the run would
 * start them) the run ends as soon without, tried last first. Sizes come in
 * turns, so a prefix holds ones it ends as soon without: a second Mac the
 * plan needed came after a second Linux worker it did not, and main e118ccf
 * cancelled that one unjoined (2026-10-24). Dropped when the end moves no
 * later and its platform's moves no further than the margin, or still ends
 * two warm-ups before the run: room for runners the CI queues. To the run's
 * end alone, a 110 s guess of an unmeasured chain cut every other platform
 * to it; to its platform's alone, 4 Macs started for work 2 ended 40 s
 * before the Linux work (main a1950a2, 2026-11-07: "we optimize for total
 * wall time"). The live plan and the footer's advice both trim by it.
 */
function dropSpare(
  added: readonly PlanWorker[],
  kept: readonly PlanWorker[],
  before: Played,
  run: (ws: readonly PlanWorker[]) => Played,
): { kept: PlanWorker[]; before: Played } {
  let out = [...kept]
  for (let i = added.length - 1, dropped = false; i >= 0; i--) {
    const w = added[i]!
    // Its twin after it stayed, and nothing moved since: without this
    // one the play is that one's again, so it stays too. Each was a
    // play of the whole run (2026-11-05).
    if (i < added.length - 1 && !dropped && twins(w, added[i + 1]!)) continue
    const without = out.filter((k) => k !== w)
    // Given no task in a whole play, the play without it is the same.
    if (!before.first.has(w.id) && before.cut !== true) {
      out = without
      dropped = true
      continue
    }
    const after = run(without)
    const ends = after.ends.get(w.platform) ?? 0
    dropped =
      after.end <= before.end &&
      (ends <= (before.ends.get(w.platform) ?? 0) + MARGIN_MS ||
        ends <= before.end - Math.max(MARGIN_MS, 2 * w.at))
    if (dropped) {
      out = without
      before = after
    }
  }
  return { kept: out, before }
}

/** A worker of `s` that joins `at`. */
function fresh(
  s: { cpu: number; memory: number; platform?: string | undefined; size?: string | undefined },
  id: string,
  at: number,
): PlanWorker {
  return {
    id,
    cores: s.cpu,
    memory: s.memory,
    platform: s.platform,
    ...(s.size === undefined ? {} : { size: s.size }),
    at,
    running: [],
    idle: false,
  }
}

/**
 * The workers to start and to let go. Of the new ones (`candidates`, in
 * the order the run would start them, each joining after its size's
 * `warmUpMs`), those a task needs to end by the best (all of them
 * started); of those, the ones it gives
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
): Plan & Ahead {
  const warm = warmOf(warmUpMs)
  const added = candidates.map((s, i) => fresh({ ...s, size: s.name }, `\0new${i}`, warm(s.name)))
  // Two warm-ups ahead: a worker asked now joins after one, and the next
  // plan, a warm-up on, sees the one after.
  const horizon =
    2 *
      Math.max(
        warm(undefined),
        ...candidates.map((c) => warm(c.name)),
        ...workers.map((w) => w.at),
      ) +
    MARGIN_MS +
    // And a task given at its end runs through: work counted as cores
    // spread over the rest asked too few workers for a few long tasks.
    tasks.reduce((most, t) => Math.max(most, t.ms ?? UNKNOWN_MS), 0)
  // Each set of workers played once a plan: the releases and the final
  // play each played the same set again.
  const plays = new Map<string, ReturnType<typeof play>>()
  const memo = (
    ws: readonly PlanWorker[],
    deadline?: number,
    until = horizon,
    wakesOnly = false,
  ): ReturnType<typeof play> => {
    const key = `${deadline}\0${until}\0${wakesOnly}\n${ws.map((w) => `${w.id}\0${w.at}\0${w.dormant === true}`).join('\n')}`
    let p = plays.get(key)
    if (p === undefined) plays.set(key, (p = play(tasks, ws, how, until, deadline, wakesOnly)))
    return p
  }
  // Given no task in the play, and none past its window.
  const unused = (p: ReturnType<typeof play>, id: string): boolean =>
    !p.first.has(id) && p.cut !== true
  const floor = chainMs(tasks, workers)
  const none = memo(workers).end
  // The best end: every new one started now, each joining after its warm-up.
  const best = none <= floor ? none : Math.min(none, memo([...workers, ...added]).end)
  // Margin spent at each decision adds up: releases 4 s apart each lost
  // 4 s of 5 (tests/sim.test.ts, a growing graph). Spent once, unless the
  // rest can no longer end by then.
  const bound =
    best === Infinity
      ? Infinity
      : Math.max(best, Math.min(best + Math.max(MARGIN_MS, best * MARGIN), limitMs))
  // The new ones, started by the play only when a task needs one to end
  // by the best: fewest workers, and the critical path never waits. The
  // fewest within a margin of the best ended runs up to 2% late at 1.4 to
  // 2.8 times the least worker time, against 1.2 to 2 for this, on
  // random, layered, wide and chain graphs (2026-11-10).
  const asleep =
    none <= best || best === Infinity ? [] : added.map((a) => ({ ...a, dormant: true }))
  // Played twice: once to learn which it starts, at their tasks' latest
  // start; again with each joining as soon as its task is ready, no
  // sooner than its warm-up, as the run starts it: one a task needs
  // anyway starts as soon as it can, and the rest of its room goes to
  // tasks with slack (2026-11-10: "Otherwise we spawn as soon as
  // possible"). One check a step of the first waiting task: a check of
  // each waiting one against each worker planned 9000 in a minute.
  const run = (ws: readonly PlanWorker[]): ReturnType<typeof play> => {
    if (asleep.length === 0) return memo(ws)
    // Played through: a task with slack past the window still starts its
    // worker as it gets ready, not a window before its latest start.
    // Read for its wakes: played on past the last, each plan of 3,800
    // tasks played the rest of the run (2026-11-11).
    const lazy = memo([...ws, ...asleep], best, Infinity, true)
    const at = new Map(lazy.wakes.map((w) => [w.id, w.readyAt]))
    const early = memo(
      [
        ...ws,
        ...asleep.map((a) => {
          const r = at.get(a.id)
          return r === undefined ? a : { ...a, dormant: false, at: Math.max(a.at, r) }
        }),
      ],
      best,
    )
    // Started for a task only at its latest start, a worker can come
    // too late for the work behind it: then its own end is the plan's.
    // Every new one at once instead started five a moment into a run of
    // no history and cancelled them all before they joined (main 2163fff).
    const own = memo(ws)
    return own.end <= early.end ? own : early
  }
  let kept: PlanWorker[] = [...workers]
  const release: string[] = []
  // Played with the rest: left out, the next idle one and the plan's end
  // counted on a worker the run lets go.
  const standIns: PlanWorker[] = []
  if (best < Infinity) {
    // One starting that the play gives no task is cancelled before it
    // joins, last to join first. Within a margin, the next plan's
    // estimates moved a second later and cancelled 7 asked one at a time
    // (PR #4214).
    const starting = workers.filter((w) => w.starting === true).sort((a, b) => b.at - a.at)
    for (const w of starting)
      if (unused(run(kept), w.id)) {
        kept = kept.filter((k) => k !== w)
        release.push(w.id)
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
    const woken = run(kept).first
    candidates.forEach((s, i) => {
      if (!woken.has(added[i]!.id)) spare.set(s.name, (spare.get(s.name) ?? 0) + 1)
    })
    for (const w of idle) {
      const without = kept.filter((k) => k !== w)
      const played = run([...kept, ...standIns])
      // Given nothing in a window with work past it: needed past it, maybe.
      const next = played.first.get(w.id) ?? (played.cut === true ? horizon : undefined)
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
      // No later than with it: a run already past its bound (a task of no
      // history ran long) kept 30 idle workers to its end (2026-11-10).
      if (run([...without, ...standIns, instead]).end <= Math.max(bound, played.end)) {
        kept = without
        release.push(w.id)
        standIns.push(instead)
        spare.set(w.size!, left - 1)
      }
    }
  }
  const { end, first, free, cut, given } = run([...kept, ...standIns])
  const start: Size[] = []
  const frees = free()
  const gave = given()
  const started: Ahead['started'][number][] = []
  const later: Ahead['later'][number][] = []
  let againInMs: number | undefined
  for (let i = 0; i < added.length; i++) {
    const id = added[i]!.id
    const at = first.get(id)
    if (at === undefined) continue
    // Given work within its warm-up and a margin: it starts now.
    const warmUp = added[i]!.at
    // Within a millisecond counts: `againInMs` of 1e-10 replanned the
    // same plan 100,000 times at one instant (tests/sim.test.ts).
    if (at < warmUp + MARGIN_MS + 1) {
      start.push(candidates[i]!)
      started.push({ freeInMs: frees.get(id)!, joinInMs: warmUp, given: gave.get(id)! })
    } else {
      const inMs = at - warmUp - MARGIN_MS
      againInMs = Math.min(againInMs ?? Infinity, inMs)
      later.push({
        size: candidates[i]!,
        inMs,
        freeInMs: frees.get(id)!,
        joinInMs: warmUp,
        given: gave.get(id)!,
      })
    }
  }
  later.sort((a, b) => a.inMs - b.inMs)
  // Work past the window: plan again a warm-up on, the window moved.
  const untilInMs = cut === true ? (horizon - MARGIN_MS) / 2 : undefined
  return {
    start,
    release,
    endsInMs: end,
    boundMs: Math.max(bound, end),
    againInMs: untilInMs === undefined ? againInMs : Math.min(againInMs ?? Infinity, untilInMs),
    untilInMs,
    freeInMs: frees,
    given: gave,
    later,
    started,
  }
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
  /** The platform a task naming none runs on (`homeOf`), or where each task runs (several worker types). */
  readonly home?: Home | undefined
  /**
   * Sizes with a worker asked and not joined past its warm-up: the CI
   * queued it, and one asked now queues behind it. None of them starts.
   */
  readonly queued?: ReadonlySet<string>
  /**
   * The run's last plan, kept here: while what it saw holds, the next is
   * that plan again, not played anew, and hands back no `tasks` when it
   * read none. With `now`, the run's clock.
   */
  readonly last?: { forecast?: Forecast }
  readonly now?: number
}): Plan & { readonly tasks: readonly PlanTask[] } {
  const how = input.how ?? DEFAULT_STRATEGY
  const now = input.now ?? 0
  const had = input.last?.forecast
  // Following a plan reads only what events move: the workers, their
  // joins, each task as it starts and ends. Every task read at each of a
  // 5000-task run's events made it quadratic (2026-11-05: "Why do we
  // recheck every task against plan? There is no point").
  if (how.scale !== 'backlog' && had !== undefined) {
    const step = follow(had, undefined, input, undefined, now)
    // No work read, none to hand back: each step handed back the plan's
    // whole work, and the run read it all at each event.
    // A start or a release hands back the work it plans for, as the run reports it.
    if (step !== undefined && step !== 'full')
      return shown(
        input.last!,
        had,
        step,
        now,
        step.start.length > 0 || step.release.length > 0 ? had.work : [],
      )
  }
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
  const step = had === undefined ? undefined : follow(had, tasks, input, sizes, now)
  if (step !== undefined && step !== 'full') return shown(input.last!, had!, step, now, tasks)
  const { freeInMs, given, later, started, untilInMs, ...p } = plan(
    tasks,
    input.workers,
    sizes,
    input.warmUpMs,
    input.replaceable,
    // New work moves the deadline; work done or known already does not.
    tasks.every((t) => input.known?.has(t.id) === true) ? input.limitMs : undefined,
    how,
  )
  if (input.last !== undefined)
    input.last.forecast = forecastOf(
      p,
      { freeInMs, given, later, started, untilInMs },
      tasks,
      input,
      now,
    )
  return { ...p, tasks }
}

/**
 * What a plan saw, to tell whether the next would differ: its work and
 * each task's time, its workers as starting, idle or busy, the tasks
 * already past their time, the sizes queued, when it wanted to look again.
 */
export interface Forecast {
  readonly at: number
  readonly plan: Plan
  /** The work it played. */
  readonly work: readonly PlanTask[]
  /** Each waiting task's time, and each waiting or running task's cores and memory. */
  readonly ms: ReadonlyMap<string, number | undefined>
  readonly need: ReadonlyMap<string, readonly [cores: number, memory: number]>
  /** The workers it saw, and those it started as they show. */
  readonly workers: ReadonlySet<string>
  /** How many workers the run has as planned. */
  readonly count: number
  /** When each worker's last planned task ends, on the run's clock. */
  readonly free: ReadonlyMap<string, number>
  /** The tasks planned on each worker. */
  readonly given: ReadonlyMap<string, readonly string[]>
  /** When each worker still starting joins, on the run's clock. */
  readonly join: ReadonlyMap<string, number>
  /** Those of each worker started and not seen yet, in the order started. */
  readonly fresh: readonly {
    readonly free: number
    readonly join: number
    readonly given: readonly string[]
  }[]
  /** Starts the plan wants later, each when due, on the run's clock. */
  readonly later: readonly {
    readonly size: Size
    readonly at: number
    readonly free: number
    readonly join: number
    readonly given: readonly string[]
  }[]
  /** Work it saw that has since been seen running: work that left otherwise moves the plan. */
  readonly seen: Set<string>
  /** When each task seen running ends, on the run's clock. */
  readonly ends: ReadonlyMap<string, number>
  /** How many tasks the run had handed over, and those it had when planned. */
  readonly executed: number
  readonly before: ReadonlySet<string>
  /**
   * How far it read the handed-over set, kept across its steps: a Set's
   * iterator sees what is added after it, so each id is read once. Each
   * step read the whole set, O(n) an event (2026-11-05).
   */
  readonly scan: { of?: ReadonlySet<string> | undefined; it?: Iterator<string>; read: number }
  /** Each size's warm-up as it saw it: a join tells the run's own. */
  readonly warm: readonly number[]
  /** When its window moves on, on the run's clock. */
  readonly until: number
  readonly late: ReadonlySet<string>
  readonly queued: string
  readonly final: boolean
}

type Seen = Pick<
  Parameters<typeof decide>[0],
  'workers' | 'queued' | 'final' | 'sizes' | 'started' | 'warmUpMs' | 'executed' | 'nodes'
>

/**
 * Running tasks past their time by more than `slack`: one that runs that
 * long moves the plan (2026-11-05: "Reality changes by leave some
 * margin. 5% or sth").
 */
function lateOf(workers: readonly PlanWorker[], slack: number): Set<string> {
  const out = new Set<string>()
  for (const w of workers)
    for (const r of w.running) if (r.endsIn < -slack && r.id !== undefined) out.add(r.id)
  return out
}

/** Each waiting and running task's cores and memory, as a plan saw them. */
function needsOf(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
): Map<string, readonly [number, number]> {
  const out = new Map<string, readonly [number, number]>(
    tasks.map((t) => [t.id, [t.cores, t.memory] as const]),
  )
  for (const w of workers)
    for (const r of w.running) if (r.id !== undefined) out.set(r.id, [r.cores, r.memory])
  return out
}

/** Whether `is` moved from `was` past 5%, or past `least` when they are small. */
const moved = (was: number, is: number, least: number): boolean =>
  Math.abs(is - was) > Math.max(least, Math.abs(was) * MARGIN)

/** How late a task may run, or how far its time may move, before the plan is made again: 5% of the run's. */
const slackOf = (p: Plan): number => Math.max(MARGIN_MS / 5, p.endsInMs * MARGIN)

const warmsOf = (input: Seen): number[] => {
  const warm = warmOf(input.warmUpMs)
  return [warm(undefined), ...input.sizes.map((s) => warm(s.name))]
}

function forecastOf(
  p: Plan,
  ahead: Ahead,
  tasks: readonly PlanTask[],
  input: Seen,
  now: number,
): Forecast {
  return {
    at: now,
    plan: p,
    work: tasks,
    ms: new Map(tasks.map((t) => [t.id, t.ms])),
    need: needsOf(tasks, input.workers),
    workers: new Set(input.workers.map((w) => w.id).filter((id) => !p.release.includes(id))),
    count: input.workers.length + p.start.length - p.release.length,
    free: new Map([...ahead.freeInMs].map(([id, ms]) => [id, now + ms])),
    join: new Map(
      input.workers.flatMap((w) => (w.starting === true ? [[w.id, now + w.at] as const] : [])),
    ),
    given: ahead.given,
    fresh: ahead.started.map((a) => ({
      free: now + a.freeInMs,
      join: now + a.joinInMs,
      given: a.given,
    })),
    later: ahead.later.map((l) => ({
      size: l.size,
      at: now + l.inMs,
      free: now + l.freeInMs,
      join: now + l.inMs + l.joinInMs,
      given: l.given,
    })),
    seen: new Set(),
    ends: new Map(
      input.workers.flatMap((w) =>
        w.running.flatMap((r) => (r.id === undefined ? [] : [[r.id, now + r.endsIn] as const])),
      ),
    ),
    executed: input.executed.size,
    before: new Set(input.executed),
    scan: { read: 0 },
    warm: warmsOf(input),
    until: ahead.untilInMs === undefined ? Infinity : now + ahead.untilInMs,
    late: lateOf(input.workers, slackOf(p)),
    queued: [...(input.queued ?? [])].sort().join('\0'),
    final: input.final,
  }
}

/** The plan `had` made, followed a step: its decisions now, its times less the time since. */
function shown(
  last: { forecast?: Forecast },
  had: Forecast,
  step: Step,
  now: number,
  tasks: readonly PlanTask[],
): Plan & { readonly tasks: readonly PlanTask[] } {
  last.forecast = step.next
  const again = Math.min(step.next.later[0]?.at ?? Infinity, step.next.until)
  const since = now - had.at
  return {
    start: step.start,
    release: step.release,
    endsInMs: Math.max(0, had.plan.endsInMs - since),
    boundMs: had.plan.boundMs - since,
    againInMs: Number.isFinite(again) ? again - now : undefined,
    tasks,
  }
}

type Step = { start: Size[]; release: string[]; next: Forecast }

/**
 * The plan `f` made, followed one step on when it still stands: no new
 * work, no task's time, cores or memory moved past 5%, no worker joined
 * or left but as planned, no task ran past its time. Its starts come due
 * and its workers with their work done go, as it foresaw; undefined
 * plays it anew. Planned at every task's end, a run of 1000 tasks
 * replayed itself 10 000 times (2026-11-05: "It's just about filling
 * boxes to full"; "If simulated all goes with plan so there should be no
 * replans").
 *
 * Without `tasks` (and `sizes`), only what events move is read: work it
 * did not see is `full`, read every task first.
 */
function follow(
  f: Forecast,
  tasks: readonly PlanTask[] | undefined,
  input: Seen,
  sizes: readonly Size[] | undefined,
  now: number,
): Step | 'full' | undefined {
  if (now >= f.until) return undefined
  if (f.final !== input.final) return undefined
  if ([...(input.queued ?? [])].sort().join('\0') !== f.queued) return undefined
  if (input.workers.length !== f.count) return undefined
  const warm = warmsOf(input)
  for (let i = 0; i < warm.length; i++)
    if (moved(f.warm[i]!, warm[i]!, MARGIN_MS / 5)) return undefined
  const slack = slackOf(f.plan)
  // Only what moved since is read: each task as it starts, runs and ends.
  // A waiting one's time moves with the run's, which those show.
  const ends = new Map<string, number>()
  let began = 0
  for (const w of input.workers)
    for (const r of w.running) {
      if (r.id === undefined) continue
      const was = f.need.get(r.id)
      // As for time, so for resources (2026-11-05: "And resource usage").
      if (
        was !== undefined &&
        (moved(was[0], r.cores, 0.05) || moved(was[1], r.memory, 64 * 2 ** 20))
      )
        return undefined
      const end = f.ends.get(r.id)
      if (end !== undefined) {
        ends.set(r.id, end)
        continue
      }
      // Started since: work the plan saw, as long as it played it.
      if (!f.ms.has(r.id)) return undefined
      const ms = f.ms.get(r.id)
      if (ms !== undefined && r.endsIn > ms + Math.max(MARGIN_MS / 5, ms * MARGIN)) return undefined
      ends.set(r.id, now + r.endsIn)
      f.seen.add(r.id)
      began++
    }
  // Ended since: sooner than played moves the plan, and so does one of
  // no known time ending.
  for (const [id, at] of f.ends)
    if (!ends.has(id) && (now < at - slack || (f.ms.has(id) && f.ms.get(id) === undefined)))
      return undefined
  for (const id of lateOf(input.workers, slack)) if (!f.late.has(id)) return undefined
  // More handed over than started, or fewer known: work it did not see,
  // maybe. Read it.
  if (input.executed.size > f.executed + began || input.executed.size < f.executed) {
    // Handed over and not started yet is work it saw: only one it did not
    // see sends the plan to read every task.
    if (tasks === undefined) {
      if (input.executed.size < f.executed) return 'full'
      const scan = f.scan
      if (scan.of !== input.executed) {
        scan.of = input.executed
        scan.it = input.executed.values()
        scan.read = 0
      }
      for (; scan.read < input.executed.size; scan.read++) {
        const r = scan.it!.next()
        // One left the set: the count no longer says where it read to.
        if (r.done === true) {
          scan.of = undefined
          return 'full'
        }
        const id = r.value
        if (
          !f.ms.has(id) &&
          !f.before.has(id) &&
          input.nodes.get(id)?.config.exec?.command !== undefined
        ) {
          scan.read++
          return 'full'
        }
      }
    } else {
      for (const t of tasks) if (!f.ms.has(t.id)) return undefined
      // Work that left without running (a hit, or no longer asked) frees
      // what the plan gave it.
      const waiting = new Set(tasks.map((t) => t.id))
      for (const id of f.ms.keys())
        if (!waiting.has(id) && !f.seen.has(id) && !ends.has(id)) return undefined
    }
  }
  const workers = new Set(f.workers)
  const free = new Map(f.free)
  const given = new Map(f.given)
  const join = new Map(f.join)
  const fresh = [...f.fresh]
  const release: string[] = []
  for (const w of input.workers) {
    if (!workers.has(w.id)) {
      // One the plan started, shown: it takes the next started's work.
      const next = fresh.shift()
      if (next === undefined) return undefined
      workers.add(w.id)
      free.set(w.id, next.free)
      given.set(w.id, next.given)
      join.set(w.id, next.join)
    }
    // Joined sooner or later than played, past the margin.
    const joins = join.get(w.id)
    if (joins !== undefined) {
      if (w.starting === true) {
        if (now > joins + slack) return undefined
      } else {
        if (now < joins - slack) return undefined
        join.delete(w.id)
      }
    }
    // Idle between its tasks, as played; with its work done, it goes.
    if (!w.idle || w.starting === true) continue
    const at = free.get(w.id)
    if (at === undefined || now >= at - slack) {
      // Its work done in a window with work past it: maybe needed there,
      // and one let go still counts against its size's max. A Mac let go
      // so left a Mac task no worker, and the run never ended (#4989).
      if (f.until < Infinity) return undefined
      // A task planned on it not started: its last one ended and the next
      // not handed to it yet. Let go, that one had no worker and the run
      // never ended (a two-task chain on a max-1 size, its rest within the
      // slack). Played again, the plan sees what waits for it.
      if (given.get(w.id)?.some((id) => !f.seen.has(id)) === true) return undefined
      release.push(w.id)
      workers.delete(w.id)
    }
  }
  const start: Size[] = []
  const later = [...f.later]
  while (later.length > 0 && now >= later[0]!.at) {
    const { size, free: ends, join: joins, given: runs } = later.shift()!
    // Its size taken up since: the plan no longer fits the run. Read
    // from what the run started, not from every task: each start read
    // them all (2026-11-05).
    if (sizes === undefined) {
      const kind = input.sizes.find((s) => s.name === size.name)
      if (
        input.final ||
        kind === undefined ||
        input.queued?.has(size.name) === true ||
        (input.started.get(size.name) ?? 0) >= kind.max
      )
        return undefined
    } else if (!sizes.some((s) => s.name === size.name)) return undefined
    start.push(size)
    fresh.push({ free: ends, join: joins, given: runs })
  }
  const next: Forecast = {
    ...f,
    workers,
    count: f.count + start.length - release.length,
    free,
    given,
    join,
    fresh,
    later,
    ends,
    executed: input.executed.size,
  }
  return { start, release, next }
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

/** The most kinds `Ready.asks` jumps across; past it, it jumps across the cores' classes. */
const MAX_JUMP_KINDS = 32
/** Classes a doubling of cores spans (`classOf`). */
const CLASSES = 4
/** The class of a task that names a platform or a size to beat: never passed whole. */
const ODD = -Infinity
/** A task's cores' class: about 2^(c / CLASSES) to 2^((c + 1) / CLASSES), its span kept as joined. */
const classOf = (t: PlanTask): number =>
  t.platform !== undefined || t.above !== undefined
    ? ODD
    : Math.floor(Math.log2(Math.max(t.cores, 1e-6)) * CLASSES)

/**
 * Ready tasks in the order `ordered` gave, by kind (`kindOf`): `assign`
 * reads them in that order, a kind it found spent skipped in one jump,
 * where it read every ready task each step (2026-10-25). A task is its
 * place in the play's tasks, and its rank (`before`) is fixed once it
 * joins: rebuilt with each join, a 9000-task tree hashed every ready
 * task 17 million times a plan (2026-10-25).
 */
/** Ready tasks `assign` would skip (`Kept`): one, or a `Span` of them all. */
interface Proof {
  one(place: number): boolean
  all(span: Span): boolean
  rank(place: number): number
}

/** Ready tasks a `Span` sums (`Ready.leap`). */
const BLOCK_BITS = 4
const BLOCK = 1 << BLOCK_BITS

class Ready {
  private readonly at: Kinds['at']
  private readonly kindAt: (place: number) => string
  private readonly taken: Uint8Array
  /** The rank: the lower `primary` first, then the lower `seq`. */
  private readonly primary: Float64Array
  private readonly seq: Float64Array
  private next = 0
  /** In rank order; taken ones linger until the next join. */
  private order: number[] = []
  private kinds = new Map<string, number[]>()
  /**
   * Ready tasks by their cores' class (`classOf`), in rank order, each
   * class's first not taken and the most memory one asked: what `asks`
   * jumps across when kinds are too many.
   */
  private classes = new Map<number, number[]>()
  private readonly classHead = new Map<number, number>()
  /** The fewest and most cores and the most memory a task of each class asked. */
  private readonly classSpan = new Map<number, [number, number, number]>()
  /** Each kind's first task not taken. */
  private readonly head = new Map<string, number>()
  /** No task before this place in `order` is left: a pass began at 0 and read 9000 taken ones (2026-10-25). */
  private lo = 0
  /** Order it again before the next step. */
  stale = false
  /** Joins so far: a queue's `spans` hold until the next. */
  private joins = 0
  private readonly spans = new WeakMap<readonly number[], { at: number; spans: Span[] }>()
  /** Taken ones still in `order`: past its live ones, it is read again without them. */
  private dead = 0
  /** Each kind's tasks not taken: a kind with none leaves `kinds`. */
  private readonly liveOf = new Map<string, number>()

  constructor(
    private readonly tasks: readonly PlanTask[],
    kinds: Kinds = kindsOf(tasks),
  ) {
    this.at = kinds.at
    this.kindAt = kinds.kindAt
    this.taken = new Uint8Array(tasks.length)
    this.primary = new Float64Array(tasks.length)
    this.seq = new Float64Array(tasks.length)
  }

  kindOf(id: string): string {
    return this.kindAt(this.at.get(id)!)
  }

  take(id: string): void {
    const i = this.at.get(id)!
    this.taken[i] = 1
    this.dead++
    const k = this.kindAt(i)
    const n = this.liveOf.get(k)! - 1
    if (n > 0) this.liveOf.set(k, n)
    else {
      this.liveOf.delete(k)
      this.kinds.delete(k)
      this.head.delete(k)
    }
  }

  /** Whether `id` was added and not taken. */
  live(id: string): boolean
  live(): PlanTask[]
  live(id?: string): PlanTask[] | boolean {
    if (id !== undefined) return this.taken[this.at.get(id)!] !== 1
    return this.order.flatMap((i) => (this.taken[i] === 1 ? [] : [this.tasks[i]!]))
  }

  /** Those not taken, by rank. */
  *from(): Generator<PlanTask> {
    for (let i = this.lo; i < this.order.length; i++)
      if (this.taken[this.order[i]!] !== 1) yield this.tasks[this.order[i]!]!
  }

  /** The first not taken, by rank. */
  first(): PlanTask | undefined {
    while (this.lo < this.order.length && this.taken[this.order[this.lo]!] === 1) this.lo++
    const i = this.order[this.lo]
    return i === undefined ? undefined : this.tasks[i]
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
    this.classes = new Map()
    this.classHead.clear()
    this.classSpan.clear()
    this.liveOf.clear()
    this.dead = 0
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
    this.joins++
    // Taken ones outnumber the rest: read without them once.
    if (this.dead > this.order.length / 2) {
      this.order = this.merge(this.order, [])
      for (const [k, q] of this.kinds) this.kinds.set(k, this.merge(q, []))
      this.head.clear()
      for (const [c, q] of this.classes) {
        const left = this.merge(q, [])
        if (left.length > 0) this.classes.set(c, left)
        else this.classes.delete(c)
      }
      this.classHead.clear()
      this.dead = 0
      this.lo = 0
    }
    const len = this.order.length + batch.length
    this.lo = Math.min(this.lo, this.insert(this.order, batch))
    // A merge left the taken ones out.
    this.dead -= len - this.order.length
    const by = new Map<string, number[]>()
    for (const i of batch) {
      const k = this.kindAt(i)
      this.liveOf.set(k, (this.liveOf.get(k) ?? 0) + 1)
      const q = by.get(k)
      if (q === undefined) by.set(k, [i])
      else q.push(i)
    }
    const byClass = new Map<number, number[]>()
    for (const i of batch) {
      const t = this.tasks[i]!
      const c = classOf(t)
      const span = this.classSpan.get(c)
      if (span === undefined) this.classSpan.set(c, [t.cores, t.cores, t.memory])
      else {
        span[0] = Math.min(span[0], t.cores)
        span[1] = Math.max(span[1], t.cores)
        span[2] = Math.max(span[2], t.memory)
      }
      const q = byClass.get(c)
      if (q === undefined) byClass.set(c, [i])
      else q.push(i)
    }
    for (const [c, q] of byClass) {
      const had = this.classes.get(c)
      if (had === undefined) {
        this.classes.set(c, q)
        this.classHead.delete(c)
      } else {
        const first = this.insert(had, q)
        const h = this.classHead.get(c)
        if (h !== undefined && first < h) this.classHead.set(c, first)
      }
    }
    // Only the kinds it joins: each join read every kind and every ready
    // task, and a 6000-task tree spent 2 s of a 5 s plan on it (2026-11-05).
    for (const [k, q] of by) {
      const had = this.kinds.get(k)
      if (had === undefined) {
        this.kinds.set(k, q)
        this.head.delete(k)
      } else {
        const first = this.insert(had, q)
        const h = this.head.get(k)
        if (h !== undefined && first < h) this.head.set(k, first)
      }
    }
  }

  /**
   * `batch`, in rank order, into `into`, in rank order: merged when it is
   * as big, each put in its place when it is few. The first place it took.
   */
  private insert(into: number[], batch: readonly number[]): number {
    if (batch.length === 0) return into.length
    if (batch.length * 8 > into.length) {
      const merged = this.merge(into, batch)
      into.length = 0
      for (const i of merged) into.push(i)
      return 0
    }
    let first = into.length
    let lo = 0
    for (const b of batch) {
      let hi = into.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (this.before(into[mid]!, b)) lo = mid + 1
        else hi = mid
      }
      into.splice(lo, 0, b)
      first = Math.min(first, lo)
      lo++
    }
    return first
  }

  /** In order, past each kind in `spent` as `assign` reads it then. */
  *asks(
    spent: Set<string>,
    bounds?: Bounds,
    kinds?: number,
    // Read past, as `assign` would skip it (`Kept`).
    skip?: Proof,
  ): Generator<Ask> {
    // Measured needs are unrounded, so kinds can be as many as tasks: a
    // jump across every kind then cost more than a read of every task.
    if (this.kinds.size > MAX_JUMP_KINDS) {
      yield* this.byClass(spent, bounds, kinds, skip)
      return
    }
    // Arrays, not the maps: the scan below is most of a sim's time (2026-11-05).
    const ks: string[] = []
    const qs: (readonly number[])[] = []
    for (const [k, q] of this.kinds) {
      ks.push(k)
      qs.push(q)
    }
    const at = new Int32Array(ks.length).fill(-1)
    let cursor = -1
    for (;;) {
      let next = -1
      let nextAt = -1
      for (let x = 0; x < ks.length; x++) {
        const k = ks[x]!
        if (spent.has(k)) continue
        const q = qs[x]!
        let p = at[x]! === -1 ? this.headOf(k, q) : at[x]!
        if (p < q.length && cursor !== -1 && !this.before(cursor, q[p]!))
          p = this.after(q, p, cursor)
        while (p < q.length && this.taken[q[p]!] === 1) p++
        at[x] = p
        if (p === q.length) continue
        // A kind no bin fits or holds for is spent here, as `assign` would
        // spend it once read: yielded, each cost a sim of 300 tasks a
        // pass over the bins (2026-11-05). Bounds only shrink until a
        // bin is given, which clears `spent`.
        if (bounds !== undefined && dead(this.tasks[q[p]!]!, bounds)) {
          spent.add(k)
          continue
        }
        if (next === -1 || this.before(q[p]!, next)) {
          next = q[p]!
          nextAt = x
        }
      }
      if (next === -1) return
      at[nextAt]!++
      cursor = next
      if (skip?.one(next) === true) continue
      const t = this.tasks[next]!
      yield { id: t.id, need: t, kind: ks[nextAt]! }
    }
  }

  /**
   * As a read of every ready task in rank order, past each taken, spent
   * or `dead` one, but jumping across the cores' classes: a class whose
   * every task no bin fits, by the span its tasks asked, is passed whole. Read one by one, the ready
   * tasks of a 5000-task play were most of its time (2026-11-05). A task
   * found dead stays dead until a bin is given, and a give only shrinks
   * the bins' room, so the read goes past it for the rest of the pass.
   */
  private *byClass(
    spent: Set<string>,
    bounds?: Bounds,
    kinds?: number,
    skip?: Proof,
  ): Generator<Ask> {
    const cs: number[] = []
    const qs: (readonly number[])[] = []
    for (const [c, q] of this.classes) {
      cs.push(c)
      qs.push(q)
    }
    const at = new Int32Array(cs.length).fill(-1)
    // Each class's first not taken nor spent, as last read: `spent` only
    // grows until a give clears it, so the read goes on from there. Read
    // again from `at` each step, the spent ones were most of a plan of
    // varied needs (2026-11-11).
    const unspent = new Int32Array(cs.length)
    // Each class's next to yield this step, or -1.
    const cand = new Int32Array(cs.length)
    let spentSeen = spent.size
    let cursor = -1
    for (;;) {
      if (bounds?.done === true || (kinds !== undefined && spent.size >= kinds)) return
      if (spent.size < spentSeen) unspent.fill(0)
      spentSeen = spent.size
      let next = -1
      let nextAt = -1
      for (let x = 0; x < cs.length; x++) {
        cand[x] = -1
        const c = cs[x]!
        if (
          bounds !== undefined &&
          c !== ODD &&
          !bounds.open &&
          this.classSpan.get(c)![0] > bounds.free + 1e-9 &&
          this.classSpan.get(c)![1] < bounds.cores &&
          this.classSpan.get(c)![2] <= bounds.memory
        )
          continue
        const q = qs[x]!
        let p = at[x]! === -1 ? this.classHeadOf(c, q) : at[x]!
        if (p < q.length && cursor !== -1 && !this.before(cursor, q[p]!))
          p = this.after(q, p, cursor)
        for (; p < q.length; p++) {
          const i = q[p]!
          if (this.taken[i] === 1) continue
          const t = this.tasks[i]!
          if (bounds === undefined || !dead(t, bounds)) break
          spent.add(this.kindAt(i))
        }
        at[x] = p
        // A spent kind is passed here only: a give clears `spent`.
        let r = Math.max(p, unspent[x]!)
        while (r < q.length && (this.taken[q[r]!] === 1 || spent.has(this.kindAt(q[r]!)))) r++
        unspent[x] = r
        if (r < q.length) cand[x] = r
        if (r < q.length && (next === -1 || this.before(q[r]!, next))) {
          next = q[r]!
          nextAt = x
        }
      }
      if (next === -1) return
      cursor = next
      // Past each skipped one, only its class reads on: the others' next
      // stand while `spent` does. Read again across every class, a plan of
      // varied needs spent most of its time here (2026-11-11).
      let again = false
      while (skip?.one(next) === true) {
        // As a step reads its class: past the dead, then past the spent.
        const q = qs[nextAt]!
        let r = this.leap(q, cand[nextAt]! + 1, skip)
        for (; r < q.length; r++) {
          const i = q[r]!
          if (this.taken[i] === 1) continue
          if (bounds === undefined || !dead(this.tasks[i]!, bounds)) break
          spent.add(this.kindAt(i))
        }
        if (spent.size !== spentSeen) {
          again = true
          break
        }
        at[nextAt] = r
        while (r < q.length && (this.taken[q[r]!] === 1 || spent.has(this.kindAt(q[r]!)))) r++
        unspent[nextAt] = r
        cand[nextAt] = r < q.length ? r : -1
        next = -1
        for (let x = 0; x < cs.length; x++) {
          const y = cand[x]!
          if (y !== -1 && (next === -1 || this.before(qs[x]![y]!, next))) {
            next = qs[x]![y]!
            nextAt = x
          }
        }
        if (next === -1) return
        cursor = next
      }
      if (again) continue
      const t = this.tasks[next]!
      yield { id: t.id, need: t, kind: this.kindAt(next) }
    }
  }

  /**
   * Past each block of `q` from `r` that `proof` proves fails whole: one
   * by one, the ready tasks read past were most of a plan of varied needs
   * (2026-11-11). A dead one passed so stays unspent, and its kind's next
   * is dead alike, so spent then.
   */
  private leap(q: readonly number[], r: number, proof: Proof): number {
    if ((r & (BLOCK - 1)) !== 0) return r
    const spans = this.spansOf(q, proof)
    while (r < q.length && proof.all(spans[r >> BLOCK_BITS]!)) r += BLOCK
    return Math.min(r, q.length)
  }

  /** Each block's `Span` of `q`, made again once a join changed the queues. */
  private spansOf(q: readonly number[], proof: Proof): Span[] {
    const had = this.spans.get(q)
    if (had !== undefined && had.at === this.joins) return had.spans
    const spans: Span[] = []
    for (let b = 0; b < q.length; b += BLOCK) {
      const t0 = this.tasks[q[b]!]!
      const span: Span = {
        minCores: Infinity,
        maxCores: -Infinity,
        minMemory: Infinity,
        maxMemory: -Infinity,
        maxRank: -Infinity,
        minMs: Infinity,
        platform: t0.platform,
        mixed: false,
        special: false,
      }
      for (let p = b; p < Math.min(q.length, b + BLOCK); p++) {
        const t = this.tasks[q[p]!]!
        span.minCores = Math.min(span.minCores, t.cores)
        span.maxCores = Math.max(span.maxCores, t.cores)
        span.minMemory = Math.min(span.minMemory, t.memory)
        span.maxMemory = Math.max(span.maxMemory, t.memory)
        span.maxRank = Math.max(span.maxRank, proof.rank(q[p]!))
        span.minMs = Math.min(span.minMs, t.ms ?? UNKNOWN_MS)
        if (t.platform !== span.platform) span.mixed = true
        if (t.above !== undefined || (t.servers?.length ?? 0) > 0) span.special = true
      }
      spans.push(span)
    }
    this.spans.set(q, { at: this.joins, spans })
    return spans
  }

  private classHeadOf(c: number, q: readonly number[]): number {
    let h = this.classHead.get(c) ?? 0
    while (h < q.length && this.taken[q[h]!] === 1) h++
    this.classHead.set(c, h)
    return h
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

/** Workers of one shape. */
export interface Fleet {
  readonly count: number
  readonly cores: number
  readonly memory: number
  readonly platform?: string | undefined
  /** The declared size, when it is one. */
  readonly size?: string | undefined
}

/** Workers that end `tasks` soonest, and when. */
export interface Fleets {
  readonly fleet: readonly Fleet[]
  readonly endMs: number
}

/**
 * What would have run `tasks` best, played from an empty run (`advise`):
 * on the declared sizes, how many of each; past their `max`, how many it
 * would take; and of any cores, the shape that ends as soon for the
 * least core time.
 */
export interface Advice {
  readonly declared?: Fleets | undefined
  /** Only when more than the sizes' `max` end it past the margin sooner. */
  readonly more?: Fleets | undefined
  readonly any?: Fleets | undefined
}

/** The cores a shape of `Advice.any` may have. */
const SHAPES = [2, 4, 8, 16, 32, 64]
/** Memory a core of a shape has when nothing declares any: as GitHub's larger runners. */
const MEMORY_PER_CORE = 4 * 2 ** 30

/**
 * The run's workers, judged after it: `tasks` as each took, played from
 * nothing on the fewest of `sizes`, in the order the live plan starts
 * them (`candidates`), that end within its margin of all of them; again
 * with each size's `max` lifted; and on one shape a platform of any
 * cores. Each worker joins after its platform's `warm` warm-up.
 */
export function advise(
  ran: readonly PlanTask[],
  sizes: readonly Size[],
  warm: (platform: string | undefined) => number,
  how: Strategy = DEFAULT_STRATEGY,
): Advice {
  if (ran.length === 0) return {}
  // A task goes only where its peak memory fits: alone on an empty worker
  // any task fits, and a 25 GB one was advised a 16 GB worker (2026-11-11).
  const tasks = ran.map((t) =>
    t.above === undefined &&
    sizes.some(
      (s) => (t.platform === undefined || s.platform === t.platform) && s.memory < t.memory,
    )
      ? { ...t, above: { cores: Infinity, memory: t.memory - 1 } }
      : t,
  )
  // First a worker each of them fits, as the live plan starts one.
  const bigger = tasks.flatMap((t) =>
    t.above === undefined ? [] : [{ ...t.above, platform: t.platform }],
  )
  const perPlatform = new Map<string | undefined, number>()
  for (const t of tasks) perPlatform.set(t.platform, (perPlatform.get(t.platform) ?? 0) + 1)
  const wants = new Map(
    [...perPlatform].flatMap(([p, n]) => (p === undefined ? [] : [[p, n] as const])),
  )
  const atOf = (s: Size): number => warm(s.platform)
  const fleetOf = (kept: readonly PlanWorker[], of: readonly Size[]): Fleet[] => {
    const by = new Map<string, number>()
    for (const k of kept) if (k.size !== undefined) by.set(k.size, (by.get(k.size) ?? 0) + 1)
    return of.flatMap((s) => {
      const count = by.get(s.name) ?? 0
      return count === 0
        ? []
        : [{ count, cores: s.cpu, memory: s.memory, platform: s.platform, size: s.name }]
    })
  }
  const byName = (w: readonly Size[]) => (size: string | undefined) =>
    atOf(w.find((s) => s.name === size)!)
  // More workers than run at once end it no sooner: of `cores` on a
  // platform, at most twice its work over the longest chain, a task each
  // at most. Without the cap 1000 tasks played 1000 workers (70 s).
  const chain = longestMs(tasks)
  const work = new Map<string | undefined, number>()
  for (const t of tasks)
    work.set(t.platform, (work.get(t.platform) ?? 0) + t.cores * (t.ms ?? UNKNOWN_MS))
  const capOf = (cores: number, platform: string | undefined): number => {
    let w = 0
    let n = 0
    for (const [p, c] of perPlatform)
      if (platform === undefined || p === platform) {
        w += work.get(p) ?? 0
        n += c
      }
    return Math.min(n, 2 * Math.ceil(w / cores / Math.max(1, chain)) + 1)
  }
  /** The fewest of `of`, each up to its `max`, ending within the margin of all of them: halving. */
  const halved = (of: readonly Size[]): { fleets: Fleets; kept: PlanWorker[] } | undefined => {
    const at = byName(of)
    const all = candidates(of, new Map(), bigger, Infinity, wants).map((s, i) =>
      fresh({ ...s, size: s.name }, `\0advice${i}`, at(s.name)),
    )
    const best = simulate(tasks, all, how)
    if (!Number.isFinite(best)) return undefined
    const bound = best + Math.max(MARGIN_MS, best * MARGIN)
    let lo = 1
    let hi = all.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (simulate(tasks, all.slice(0, mid), how) <= bound) hi = mid
      else lo = mid + 1
    }
    // Then each the run ends as soon without, as the live plan trims.
    const { kept, before } = dropSpare(
      all.slice(0, lo),
      all.slice(0, lo),
      play(tasks, all.slice(0, lo), how),
      (ws) => play(tasks, ws, how),
    )
    return { fleets: { fleet: fleetOf(kept, of), endMs: before.end }, kept }
  }
  const declared = sizes.length === 0 ? undefined : halved(sizes)?.fleets
  const lifted = sizes.map((s) => ({ ...s, max: Math.max(s.max, capOf(s.cpu, s.platform)) }))
  const wider = lifted.some((s, i) => s.max > sizes[i]!.max) ? halved(lifted)?.fleets : undefined
  const more =
    wider !== undefined &&
    declared !== undefined &&
    wider.endMs + Math.max(MARGIN_MS, declared.endMs * MARGIN) < declared.endMs
      ? wider
      : undefined
  // Of any cores: each platform's memory a core as its sizes have most.
  const ratio = new Map<string | undefined, number>()
  for (const s of sizes)
    ratio.set(s.platform, Math.max(ratio.get(s.platform) ?? 0, s.memory / s.cpu))
  const most = new Map<string | undefined, number>()
  for (const t of tasks) most.set(t.platform, Math.max(most.get(t.platform) ?? 0, t.memory))
  const tried: { fleets: Fleets; coreMs: number; workers: number }[] = []
  for (const cores of SHAPES) {
    const shapes: Size[] = [...perPlatform.keys()].map((platform) => ({
      name: `${cores}#${platform ?? ''}`,
      max: capOf(cores, platform),
      cpu: cores,
      memory: Math.max(
        cores * (ratio.get(platform) ?? ratio.get(undefined) ?? MEMORY_PER_CORE),
        most.get(platform) ?? 0,
      ),
      platform,
    }))
    const got = halved(shapes)
    if (got === undefined) continue
    let coreMs = 0
    for (const k of got.kept) coreMs += k.cores * Math.max(0, got.fleets.endMs - k.at)
    tried.push({ fleets: got.fleets, coreMs, workers: got.kept.length })
  }
  let any: Fleets | undefined
  if (tried.length > 0) {
    const soonest = Math.min(...tried.map((t) => t.fleets.endMs))
    const bound = soonest + Math.max(MARGIN_MS, soonest * MARGIN)
    let cheapest: (typeof tried)[number] | undefined
    for (const t of tried)
      if (
        t.fleets.endMs <= bound &&
        (cheapest === undefined ||
          t.coreMs < cheapest.coreMs ||
          // As cheap, fewer machines.
          (t.coreMs === cheapest.coreMs && t.workers < cheapest.workers))
      )
        cheapest = t
    any = {
      fleet: cheapest!.fleets.fleet.map((f) => ({
        count: f.count,
        cores: f.cores,
        memory: f.memory,
        platform: f.platform,
      })),
      endMs: cheapest!.fleets.endMs,
    }
  }
  return { declared, more, any }
}

/** The longest chain of `tasks` by their `ms`, through the deps among them. */
function longestMs(tasks: readonly PlanTask[]): number {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const memo = new Map<string, number>()
  const of = (t: PlanTask): number => {
    const had = memo.get(t.id)
    if (had !== undefined) return had
    memo.set(t.id, 0)
    let up = 0
    for (const d of t.deps) {
      const u = byId.get(d)
      if (u !== undefined) up = Math.max(up, of(u))
    }
    const out = up + (t.ms ?? UNKNOWN_MS)
    memo.set(t.id, out)
    return out
  }
  let most = 0
  for (const t of tasks) most = Math.max(most, of(t))
  return most
}
