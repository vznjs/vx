import type { TaskNode } from '@vzn/vx'

/** Where a task naming no platform runs, or (several worker types) where each task runs. */
export type Home = string | ((node: TaskNode) => string | undefined)

/**
 * A task's duration when history has none: a test suite's, so a run with
 * no history starts workers for its work rather than one for all of it.
 */
export const UNKNOWN_MS = 30_000
/** A worker's warm-up before one has joined: CI's took 15 to 23 s. */
export const WARM_UP_MS = 20_000
/** How much later than the best a plan may end: a few seconds, or 5%. */
export const MARGIN_MS = 5_000
export const MARGIN = 0.05

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
  /**
   * Its upstreams whose files only the worker that ran them holds
   * (`leaves`): on another worker each runs again first.
   */
  readonly reads?: readonly string[]
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
  reads?: string[]
}

/**
 * An uncached task that may leave files its dependants read: no cache
 * carries them. A sandboxed one writes only where its grants say; with
 * none (a gate like a lint or a version check) it leaves nothing, and
 * pinning every dependant to its worker held a run's shards on one.
 */
export function leaves(node: TaskNode): boolean {
  if (node.config.cache === true) return false
  const sandbox = node.config.exec?.sandbox
  return sandbox === undefined || (sandbox.allow?.write?.length ?? 0) > 0
}

/** The numbering each `depsN` is of. */
export const numberedOf = new WeakMap<Int32Array, Numbered>()

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
  /** From then on, ms from now, it takes no task: it leaves once what runs there ends (`Plan.drain`). */
  readonly drainIn?: number
  /** Tasks that ran here whose files no cache holds (`leaves`), each with its ms: their dependants read them here, or make them again. */
  readonly holds?: ReadonlyMap<string, number>
}

/** A worker's warm-up, one for all, or by its size (`Size.name`; none for one that joined on its own). */
export type WarmUp = number | ((size: string | undefined) => number)

export const warmOf = (w: WarmUp): ((size: string | undefined) => number) =>
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
  /**
   * Workers that take no task from `inMs` on, from now: the work after
   * goes to a smaller one started to join then, holding less CPU, the run
   * ending no later. Each leaves once what runs there ends.
   */
  readonly drain: readonly { readonly id: string; readonly inMs: number }[]
  /**
   * The worker it gave each task, of those running now: the run places
   * by it where it can (`Dispatching.want`). Undefined: the last one's
   * stands; empty while a task has no history.
   */
  readonly placed?: ReadonlyMap<string, string>
  /**
   * When the plan starts each task, from now: none is given before, so
   * it runs where the plan has room for it then. Ready sooner than played
   * (its upstream a hit), one took the room planned for a shard and the
   * run ended 7 s late (tests/sim.test.ts). Undefined: the
   * last one's stands.
   */
  readonly after?: ReadonlyMap<string, number>
  /**
   * Of `after`, those the plan starts as they get ready: one ready sooner
   * goes to its worker at once, if that joined. Held to its planned start,
   * a chain's next step waited 11 s past an upstream of no history that
   * ended sooner than guessed.
   */
  readonly asap?: ReadonlySet<string>
  /** The workers `placed` names that the run starts, of each size, in the order they join. */
  readonly fresh?: readonly { readonly id: string; readonly size: string }[]
  /**
   * Each task goes only to the worker `placed` names, from `after` on:
   * the plan reserved its room there, and kept no other.
   */
  readonly exact?: boolean
  /** Why the work was played, not packed: for the run's profile. */
  readonly unpacked?: string
}

/**
 * What a plan foresees past its decisions, so the run follows it without
 * playing it again: when each worker's last task in it ends (one idle
 * before that is between tasks), when each start it wants later is due,
 * and when each started now ends its work.
 */
export interface Ahead {
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

/**
 * How much later each next worker of a size joins than the one before,
 * from the warm-ups those of it took: the spread of the slowest from the
 * fastest, over the joins between. None until two joined.
 */
export function spreadMs(warmUps: readonly number[]): number {
  if (warmUps.length < 2) return 0
  let least = Infinity
  let most = 0
  for (const w of warmUps) {
    least = Math.min(least, w)
    most = Math.max(most, w)
  }
  return (most - least) / (warmUps.length - 1)
}

/** History the run's finished tasks must have had before `slowdown` says anything. */
const SLOWDOWN_MS = 20_000

/**
 * How much longer than history the run's finished tasks took (`took` ms,
 * `forecast` ms), at least 1, once they had 20 s of history: the plan
 * stretches what is left by it. A task past its forecast was planned to
 * end now, so a run whose tasks took twice theirs planned 27 s left for
 * 100 s, asked a worker, cancelled it as not needed, and asked again.
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
  // walked once a run, not at each plan, and read by one lookup.
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
    // one task's 570; the first plan never returned.
    const out = new Set<string>()
    for (const d of e.node.deps) {
      const x = of.get(d)
      if (x === undefined) continue
      if (x.runs) out.add(d)
      else for (const dd of depsOf(x)) out.add(dd)
    }
    return (e.deps = [...out])
  }
  // Every upstream that runs and leaves files, through groups and tasks:
  // the orchestrator pins a task to all of them (`Orchestrator.pin`).
  const readsOf = (e: Node): string[] => {
    if (e.reads !== undefined) return e.reads
    e.reads = []
    const out = new Set<string>()
    for (const d of e.node.deps) {
      const x = of.get(d)
      if (x === undefined) continue
      if (x.runs && x.node.config.exec?.persistent === undefined && leaves(x.node)) out.add(d)
      for (const r of readsOf(x)) out.add(r)
    }
    return (e.reads = [...out])
  }
  const out: PlanTask[] = []
  for (const id of ids) {
    const e = of.get(id)
    if (e === undefined || !e.runs) continue
    const reads = readsOf(e)
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
      ...(reads.length === 0 ? {} : { reads }),
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
 * a first plan missed check.build-cold behind its install and
 * asked one Mac for a 37 s lane that ran to 120 s.
 * Groups and hits are no work: counted, 85 hits of 109 tasks asked 6
 * workers where 2 did.
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
 * came back as a miss, and the run waited out its timeout.
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
 * kept in the forecast its dependants counted as work: a run asked
 * workers for 121 tasks, and 16 ran.
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

/** What a task asks of a worker: its history's cores and peak memory. */
export interface Need {
  readonly cores: number
  readonly memory: number
  /** It filled a machine this big last time: only a bigger one takes it, if any worker is. */
  readonly above?: { readonly cores: number; readonly memory: number } | undefined
  /** The platform it runs on (`ExecuteRequest.platform`): only a worker of it takes it. */
  readonly platform?: string | undefined
  /**
   * What it counts for when the plan sizes the run, when that is not what
   * it books: an unmeasured task books next to nothing, so it goes to any
   * free core, but a run of only such tasks still asks enough workers.
   */
  readonly ask?: { readonly cores: number; readonly memory: number } | undefined
  /**
   * Its persistent dependencies' bases, cores (`server-fit.ts`): a worker
   * not running one yet books its base once beside the task, and keeps it
   * booked while it serves.
   */
  readonly servers?: readonly { readonly id: string; readonly cores: number }[] | undefined
}

/**
 * What a running task has left: past its time, as long again as it is
 * over, not none. Counted as ending now, a filler running three times its
 * history kept the room a critical task was held, the plan started no
 * worker for it, and it waited 100 s.
 */
export const leftMs = (endsIn: number): number => (endsIn >= 0 ? endsIn : -endsIn)
