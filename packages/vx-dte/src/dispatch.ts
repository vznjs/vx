// Which worker each waiting task goes to now: one rule for the live run
// (`Orchestrator.pump`) and for the plan's play-out (`planner.ts`), so the
// plan sizes the run the way the run packs it.

import type { Strategy } from './strategy.js'

/**
 * `ids` (waiting, in the order they got ready) in the order `how` takes
 * them. `tail`: each one's longest chain after it, its own ms included.
 */
export function ordered(
  ids: readonly string[],
  how: Strategy['order'],
  tail: (id: string) => number,
  need: (id: string) => Need,
  cores: number,
): string[] {
  if (how === 'fifo') return [...ids]
  // Each one's key read once: a comparator that read the tails read them
  // q log q times at each event, most of a 10 000-task sim (2026-11-05).
  const tails = ids.map(tail)
  if (how === 'critical-path') return byKey(ids, tails)
  // Troublesome: within a quarter of the longest chain, or half a worker wide.
  let longest = 0
  for (const t of tails) longest = Math.max(longest, t)
  // Hard ones first: a key above every tail.
  const keys = ids.map((id, i) =>
    tails[i]! >= 0.75 * longest || need(id).cores >= cores / 2
      ? tails[i]! + longest + 1
      : tails[i]!,
  )
  return byKey(ids, keys)
}

/**
 * `ids` by `keys`, highest first, ties in the order they came. The queue
 * comes back as it left plus what got ready since: the run of it already
 * in order is merged with the rest, sorted, and not sorted again.
 */
function byKey(ids: readonly string[], keys: readonly number[]): string[] {
  let run = 1
  while (run < ids.length && keys[run]! <= keys[run - 1]!) run++
  if (run >= ids.length) return [...ids]
  const rest: number[] = []
  for (let i = run; i < ids.length; i++) rest.push(i)
  rest.sort((x, y) => keys[y]! - keys[x]! || x - y)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < run && j < rest.length)
    out.push(keys[i]! >= keys[rest[j]!]! ? ids[i++]! : ids[rest[j++]!]!)
  while (i < run) out.push(ids[i++]!)
  while (j < rest.length) out.push(ids[rest[j++]!]!)
  return out
}

/** How `dispatch` sees the waiting tasks and the run. */
export interface Dispatching {
  readonly how: Strategy
  /** Each one's longest chain after it (`tailsMs`); none: they go in the order they came. */
  readonly tail?: ((id: string) => number) | undefined
  /** What it asks, as history said. */
  readonly need: (id: string) => Need
  /** What it books now (`Orchestrator.booking`); default `need`'s. */
  readonly book?: (need: Need) => Need
  /** Its direct dependencies (`Ask.up`). */
  readonly deps: (id: string) => readonly string[] | undefined
  /** Whether it may go now, and where (`Orchestrator.pin`): `'wait'` not yet, `'done'` it ended. */
  readonly gate?: (id: string) => 'wait' | 'done' | { only?: string; avoid?: string }
  /** A worker bigger than `above` of `platform` is coming (`assign`'s `waits`). */
  readonly waits?: (above: NonNullable<Need['above']>, platform: string | undefined) => boolean
  /** Its time, as history said: with `soon`, what a hold keeps it from (`Hold`). */
  readonly ms?: (id: string) => number | undefined
  /** Tasks about to be ready, highest rank first: room is kept for each (`holdFor`). */
  readonly soon?: readonly Soon[]
  /**
   * With `soon`: the tasks about to be ready once task `id` is given,
   * held for as it is, before the rest of the pass takes their room. Held
   * only from the next pass, a chain's next step found its worker filled
   * by fillers given beside its first (lab, 2026-11-11).
   */
  readonly next?: (id: string) => readonly Soon[]
  /**
   * The worker the last plan gave task `id` (`Plan.placed`): of those it
   * fits now, that one first. Placed by locality, a chain's next step took
   * the empty worker the plan kept for a 4-core task, which waited 3
   * minutes past its latest start (lab, 2026-11-11).
   */
  readonly want?: (id: string) => string | undefined
}

/**
 * Where the `waiting` tasks go now: ordered (`ordered`), gated, and placed
 * (`assign`). The one rule of the live run and of the sims, which keep
 * their waiting tasks in a `Queue` placing as this does: each kept its
 * own, and the sims passed while runs placed otherwise (2026-11-05).
 * `left`: the ones that stay waiting, in order.
 */
export function dispatch<B extends Bin>(
  waiting: readonly string[],
  bins: readonly B[],
  o: Dispatching,
): { to: Map<string, B>; left: string[] } {
  const queue =
    o.tail === undefined
      ? waiting
      : ordered(
          waiting,
          o.how.order,
          o.tail,
          o.need,
          bins.reduce((n, b) => Math.max(n, b.cores), 1),
        )
  // The least any ask needs: once no worker takes it, the pass ends. Each
  // pump read every queued task, 8000 of them a pump (2026-10-25).
  const floor = { cores: Infinity, memory: Infinity }
  const needs: Need[] = []
  for (const id of queue) {
    const need = o.book === undefined ? o.need(id) : o.book(o.need(id))
    needs.push(need)
    floor.cores = Math.min(floor.cores, need.cores)
    floor.memory = Math.min(floor.memory, need.memory)
  }
  // Asks are made as the pass reads them: it ends at the first no worker
  // takes, and making every queued one's at each event was most of a
  // 5000-task sim (2026-11-05).
  const read: string[] = []
  // The bins' bounds as assign keeps them: an ask no bin can take or hold
  // for is not made. Each such ask read every bin, and a full run's queue
  // of them at each event was most of a 10 000-task sim (2026-11-05).
  const bounds: Bounds = { done: false, open: true, free: 0, cores: 0, memory: 0 }
  let i = 0
  const kept = new Set<string>()
  function* asks(): Generator<Ask> {
    for (; i < queue.length; i++) {
      const id = queue[i]!
      if (bounds.done) return
      if (dead(needs[i]!, bounds)) {
        if (o.soon !== undefined)
          holdReady(bins, kept, id, needs[i]!, o.tail?.(id) ?? 0, o.ms?.(id))
        read.push(id)
        continue
      }
      const gate = o.gate?.(id) ?? {}
      if (gate === 'done') continue
      read.push(id)
      if (gate === 'wait') continue
      yield {
        id,
        need: needs[i]!,
        up: o.deps(id) ?? [],
        ...gate,
        ...(o.soon === undefined ? {} : { rank: o.tail?.(id) ?? 0, ms: o.ms?.(id) ?? Infinity }),
      }
    }
  }
  if (o.soon !== undefined) holdFor(bins, o.soon)
  const to = assign(asks(), bins, o.waits, o.how.place, {
    floor,
    kinds: Infinity,
    bounds,
    ...(o.soon === undefined || o.next === undefined ? {} : { next: o.next }),
    ...(o.want === undefined ? {} : { want: o.want }),
  })
  const left = read.filter((id) => !to.has(id))
  // The pass ended at the ask it read last, and took or left it.
  for (let j = i < queue.length && read.at(-1) === queue[i] ? i + 1 : i; j < queue.length; j++)
    left.push(queue[j]!)
  return { to, left }
}

/**
 * The most workers a task is scored on, of those it fits, as Kubernetes
 * scores a share of its nodes: scoring every one cost the orchestrator
 * 15% more CPU at 200 workers, and the sims ended within 0.4% sampling
 * even 2 (2026-11-05).
 */
const SAMPLE = 16

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

/** A worker as dispatch sees it: its size and what is in use on it now. */
export interface Bin {
  readonly id: string
  readonly cores: number
  readonly memory: number
  /** Cores and memory in use: booked, or more when its load says more. */
  readonly used: { cores: number; memory: number }
  /** Tasks on it holding cores. */
  running: number
  /** Tasks whose outputs it holds. */
  readonly has?: ReadonlySet<string>
  /** Its machine's platform (`linux-x64`), as it reported or its size declares. */
  readonly platform?: string | undefined
  /** The servers it runs, each base booked: a task needing one books no base here. */
  readonly serving?: Set<string>
  /** When each task on it ends, from now (ms), its cores and memory: where a hold finds room. */
  ends?: readonly (readonly [at: number, cores: number, memory: number])[] | undefined
  /** Room kept for tasks about to be ready (`holdFor`): one of lower rank goes here only beside it. */
  holds?: Hold[] | undefined
}

/**
 * Room a task about to be ready keeps on a bin: from `at` to `until` ms
 * from now, `cores` and `memory`, for a task of `rank` (its chain). A
 * task of lower rank that would still run at `at` goes there only if
 * both fit then: a worker started for a critical task joined early, was
 * filled by short ones, and the critical task waited a minute
 * (2026-11-10: "Critical path should never have to wait for availability").
 */
export interface Hold {
  readonly at: number
  readonly until: number
  readonly cores: number
  readonly memory: number
  readonly rank: number
  /** Kept for a ready task no worker fits now (`holdReady`). */
  readonly ready?: true
}

/** A task the run expects ready `at` ms from now, with its rank (its chain) and time. */
export interface Soon {
  readonly need: Need
  readonly at: number
  readonly rank: number
  readonly ms: number
}

/** What `b` holds at `at`: its tasks still running then, and holds over it (`Sweep`). */
function heldAt(b: Bin, at: number): { cores: number; memory: number } {
  const w = sweepOf(b)
  let lo = 0
  let hi = w.at.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (w.at[mid]! <= at) lo = mid + 1
    else hi = mid
  }
  return lo === 0
    ? w.base
    : { cores: Math.max(0, w.heldCores[lo - 1]!), memory: w.heldMemory[lo - 1]! }
}

/**
 * Keeps room for each of `soon` (highest rank first) on the bin where it
 * is first free from its `at`: tasks of lower rank then fit beside it
 * only. A bin of another platform, or too small, holds none.
 */
export function holdFor(bins: readonly Bin[], soon: readonly Soon[]): void {
  for (const b of bins) b.holds = undefined
  for (const s of soon) holdOne(bins, s)
}

/** Keeps room for `s` on the bin where it is first free from its `at`. */
function holdOne(bins: readonly Bin[], s: Soon, ready?: true): void {
  let best: Bin | undefined
  let bestAt = Infinity
  const above = s.need.above
  for (const b of bins) {
    if (s.need.platform !== undefined && b.platform !== s.need.platform) continue
    // Nor one it may not go to: held on a 2-core worker it fit only
    // empty, a 3-core task left the 8-core one to tasks of no rank and
    // waited past its latest start (lab, 2026-11-11).
    if (above !== undefined && b.cores <= above.cores && b.memory <= above.memory) continue
    // None frees it sooner than at once: most holds found one free at once.
    if (s.at >= bestAt) break
    const at = firstFree(b, s.need, s.at, bestAt)
    if (at < bestAt) {
      best = b
      bestAt = at
    }
  }
  if (best === undefined) return
  ;(best.holds ??= []).push({
    at: bestAt,
    until: bestAt + s.ms,
    cores: Math.min(s.need.cores, best.cores),
    memory: Math.min(s.need.memory, best.memory),
    rank: s.rank,
    ...(ready === undefined ? {} : { ready }),
  })
}

/**
 * What a bin holds through time: each change (an end, a hold's start or
 * end) in order, and what it holds after it. Kept while its ends and use
 * are the ones it read, a hold added in place: a read of the bin at each
 * end it might free, for each hold, was most of a plan of 3,800 tasks
 * (2026-11-11).
 */
interface Sweep {
  ends: Bin['ends']
  holds: Bin['holds']
  count: number
  cores: number
  memory: number
  /** Held before the first change. */
  base: { cores: number; memory: number }
  at: number[]
  deltaCores: number[]
  deltaMemory: number[]
  /** Held from it on. */
  heldCores: number[]
  heldMemory: number[]
}

const sweeps = new WeakMap<Bin, Sweep>()

/** Puts a change in time order, after those at its time, and what is held from there on. */
function change(w: Sweep, at: number, cores: number, memory: number): void {
  // Moved up one by one from the end, as it finds its place: five splices
  // and a second pass over the same changes were most of a sweep.
  const { at: ats, deltaCores: dc, deltaMemory: dm, heldCores: hc, heldMemory: hm } = w
  let i = ats.length
  for (; i > 0 && ats[i - 1]! > at; i--) {
    ats[i] = ats[i - 1]!
    dc[i] = dc[i - 1]!
    dm[i] = dm[i - 1]!
    hc[i] = hc[i - 1]! + cores
    hm[i] = hm[i - 1]! + memory
  }
  ats[i] = at
  dc[i] = cores
  dm[i] = memory
  hc[i] = (i === 0 ? w.base.cores : hc[i - 1]!) + cores
  hm[i] = (i === 0 ? w.base.memory : hm[i - 1]!) + memory
}

function sweepOf(b: Bin): Sweep {
  const holds = b.holds ?? []
  let w = sweeps.get(b)
  if (
    w === undefined ||
    w.ends !== b.ends ||
    w.holds !== b.holds ||
    w.count > holds.length ||
    w.cores !== b.used.cores ||
    w.memory !== b.used.memory
  ) {
    let ending = 0
    let endingMemory = 0
    for (const [, c, m] of b.ends ?? []) {
      ending += c
      endingMemory += m
    }
    w = {
      ends: b.ends,
      holds: b.holds,
      count: 0,
      cores: b.used.cores,
      memory: b.used.memory,
      // What no end is known for (a server's base) stays.
      base: {
        cores: Math.max(0, b.used.cores - ending) + ending,
        memory: b.ends === undefined ? b.used.memory : endingMemory,
      },
      at: [],
      deltaCores: [],
      deltaMemory: [],
      heldCores: [],
      heldMemory: [],
    }
    for (const [end, c, m] of b.ends ?? []) change(w, end, -c, -m)
    sweeps.set(b, w)
  }
  for (; w.count < holds.length; w.count++) {
    const h = holds[w.count]!
    change(w, h.at, h.cores, h.memory)
    change(w, h.until, -h.cores, -h.memory)
  }
  return w
}

/**
 * The first of `from`, an end or a hold's end after it, before `before`,
 * where `need` fits on `b` beside what it holds then (`heldAt`), or
 * where `b` is empty; else Infinity.
 */
function firstFree(b: Bin, need: Need, from: number, before: number): number {
  const w = sweepOf(b)
  const n = w.at.length
  const roomCores = b.cores + 1e-9 - need.cores
  const roomMemory = b.memory - need.memory
  // The first change after `from`.
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (w.at[mid]! <= from) lo = mid + 1
    else hi = mid
  }
  let cores = lo === 0 ? w.base.cores : w.heldCores[lo - 1]!
  let memory = lo === 0 ? w.base.memory : w.heldMemory[lo - 1]!
  if ((cores <= 1e-9 && memory <= 0) || (cores <= roomCores && memory <= roomMemory)) return from
  for (let i = lo; i < n;) {
    const at = w.at[i]!
    if (at >= before) return Infinity
    let frees = false
    for (; i < n && w.at[i] === at; i++)
      if (w.deltaCores[i]! < 0 || w.deltaMemory[i]! < 0) frees = true
    if (!frees) continue
    cores = Math.max(0, w.heldCores[i - 1]!)
    memory = w.heldMemory[i - 1]!
    if ((cores <= 1e-9 && memory <= 0) || (cores <= roomCores && memory <= roomMemory)) return at
  }
  return Infinity
}

/**
 * Keeps room for a ready task no worker fits now where it first frees, a
 * worker's count of them a pass: skipped unheld, smaller tasks of lower
 * rank took each core as it freed and the critical path waited 6 s (main
 * 2163fff, 2026-11-10).
 */
function holdReady(
  bins: readonly Bin[],
  kept: Set<string>,
  id: string,
  need: Need,
  rank: number,
  ms: number | undefined,
): void {
  if (ms === undefined || kept.has(id) || kept.size >= bins.length) return
  kept.add(id)
  holdOne(bins, { need, at: 0, rank, ms }, true)
}

/** Whether `ask` on `b` would take room a hold of higher rank keeps. */
function breaks(b: Bin, ask: Ask): boolean {
  if (b.holds === undefined || ask.rank === undefined) return false
  const until = ask.ms ?? Infinity
  for (const h of b.holds) {
    if (h.rank <= ask.rank || h.at >= until) continue
    // One of no history still goes: held back for a guessed-at chain, it
    // was the critical path more often than the task held for (lab, wide
    // graphs a third unmeasured: 9.9% late to 10.8%, 9.5% passing it).
    if (h.ready === true && until === Infinity) continue
    const u = heldAt(b, h.at)
    if (u.cores + ask.need.cores > b.cores + 1e-9 || u.memory + ask.need.memory > b.memory)
      return true
  }
  return false
}

/**
 * The longest `ask` (of finite time) may run on `b` before a hold of
 * higher rank it would break begins: `breaks` with its `ms` past it.
 */
function window(b: Bin, ask: Ask): number {
  let out = Infinity
  for (const h of b.holds ?? []) {
    if (h.rank <= ask.rank! || h.at >= out) continue
    const u = heldAt(b, h.at)
    if (u.cores + ask.need.cores > b.cores + 1e-9 || u.memory + ask.need.memory > b.memory)
      out = h.at
  }
  return out
}

/**
 * An ask that no bin took and that changed nothing (`assign`): its need,
 * rank, the longest that fits before the holds that kept it off, and the
 * room left where one it fits only empty is held. One needing as much or
 * more of the same platform, of no higher rank and longer, fails alike
 * until a bin is given: bins it fits are fewer, holds it breaks more.
 */
export interface Kept {
  readonly cores: number
  readonly memory: number
  readonly platform: string | undefined
  readonly rank: number
  readonly longest: number
  /** The fewest cores and least memory free of a bin in use: needing less, no bin is held for it. */
  readonly under: { readonly cores: number; readonly memory: number }
}

/** At most this many `Kept` a pass: the newest. */
const KEPT = 32

/** Whether one of `kept` proves `need`, of `rank` and `ms`, fails (`Kept`). */
export function failsAlike(
  kept: readonly Kept[],
  need: Need,
  rank: number | undefined,
  ms: number | undefined,
): boolean {
  if (kept.length === 0 || rank === undefined || ms === undefined) return false
  if (need.above !== undefined || (need.servers?.length ?? 0) > 0) return false
  for (const k of kept)
    if (
      need.platform === k.platform &&
      need.cores >= k.cores &&
      need.memory >= k.memory &&
      rank <= k.rank &&
      ms > k.longest &&
      need.cores < k.under.cores &&
      need.memory <= k.under.memory
    )
      return true
  return false
}

/**
 * What a run of ready tasks asks all told: the least and most of each
 * need, the longest chain (`rank`) and the shortest time, one platform
 * (`mixed` if not) and whether any has a bigger size to wait for or servers.
 */
export interface Span {
  minCores: number
  maxCores: number
  minMemory: number
  maxMemory: number
  maxRank: number
  minMs: number
  platform: string | undefined
  mixed: boolean
  special: boolean
}

/** Whether one of `kept` proves every task of `s` fails (`failsAlike` of each). */
export function allFailAlike(kept: readonly Kept[], s: Span): boolean {
  if (s.mixed || s.special) return false
  for (const k of kept)
    if (
      s.platform === k.platform &&
      s.minCores >= k.cores &&
      s.minMemory >= k.memory &&
      s.maxRank <= k.rank &&
      s.minMs > k.longest &&
      s.maxCores < k.under.cores &&
      s.maxMemory <= k.under.memory
    )
      return true
  return false
}

export interface Ask {
  readonly id: string
  readonly need: Need
  /**
   * Its direct dependencies: a worker holding most is preferred. One holds
   * what was sent with each, so the direct ones say enough: counting every
   * upstream for every worker read thousands an ask (2026-11-05).
   */
  readonly up?: readonly string[]
  /** Names its need: asks of one kind fit and fail alike (`kindOf`). */
  readonly kind?: string
  /** The one bin that may take it: it holds files no cache does. */
  readonly only?: string
  /** A bin that may not take it. */
  readonly avoid?: string
  /** Its rank (its chain) and time: a bin's holds of higher rank keep it off (`Hold`). */
  readonly rank?: number
  readonly ms?: number
}

/** What `Ask.kind` names: every field of a need `assign` reads. */
export function kindOf(need: Need): string {
  return `${need.cores}\0${need.memory}\0${need.above?.cores}\0${need.above?.memory}\0${need.platform}\0${need.servers?.map((s) => s.id).join('\0')}`
}

/** The cores `need` books on `bin`: its own, and the base of each server `bin` does not run yet. */
function coresOn(bin: Bin, need: Need): number {
  let cores = need.cores
  if (need.servers === undefined) return cores
  for (const s of need.servers) if (bin.serving?.has(s.id) !== true) cores += s.cores
  return cores
}

/**
 * Whether `need` fits on `bin` now: alone on an empty one, whatever it
 * asks; beside others only in full, cores and memory. Beside others on a
 * free core alone, main's workers booked 4.3 of 4 (2026-10-23).
 */
export function fits(bin: Bin, need: Need): boolean {
  if (need.platform !== undefined && bin.platform !== need.platform) return false
  if (bin.running === 0) return true
  const cores = coresOn(bin, need)
  return (
    cores < bin.cores &&
    bin.used.cores + cores <= bin.cores + 1e-9 &&
    bin.used.memory + need.memory <= bin.memory
  )
}

/**
 * Each of `asks`, in order, to the bin it fits now (`fits`): of those, the
 * one holding most of its dependencies' outputs, then the one with fewest
 * cores free, so workers fill before the next takes work and the rest
 * fall idle and leave. A task bigger than every bin's last size goes to a
 * bigger one only, unless none is or `waits(above, platform)` says one of its platform is coming.
 * The first that fits nowhere but an empty bin holds the one using least: no task after it goes there, or later tasks fill it again and
 * again (check.bun, the gate of 56 tasks, waited 50 s on main 871ffba).
 * Bins' `used` and `running` count what is given. `all`, what the asks
 * need all told (the least of each, and how many kinds), ends the pass
 * once no bin takes the least or every kind failed since the last given:
 * the rest change nothing.
 */
export function assign<B extends Bin>(
  asks: Iterable<Ask>,
  bins: readonly B[],
  waits: (above: NonNullable<Need['above']>, platform: string | undefined) => boolean = () => false,
  place: Strategy['place'] = 'best-fit',
  all?: {
    readonly floor: { readonly cores: number; readonly memory: number }
    readonly kinds: number
    /** Where it keeps the kinds spent, for the asks to skip them as it reads. */
    readonly spent?: Set<string>
    /** Where it keeps the `Kept`, for the asks to skip those they prove fail as they read. */
    readonly kept?: Kept[]
    /** Where it keeps the bins' bounds as it gives, for the asks to skip each `dead` one as it reads. */
    readonly bounds?: Bounds
    /** What to hold for once an ask is given (`Dispatching.next`). */
    readonly next?: (id: string) => readonly Soon[]
    /** The bin each ask goes to first, where it fits (`Dispatching.want`). */
    readonly want?: (id: string) => string | undefined
  },
): Map<string, B> {
  const out = new Map<string, B>()
  const held = new Set<B>()
  const bounds = all?.bounds
  const rebound = (): void => {
    if (bounds !== undefined) boundsOf(bins, held, bounds, all?.floor)
  }
  rebound()
  // Kinds that failed and held nothing since a bin was last given a task:
  // until one is, each ask of them fails alike.
  const spent = all?.spent ?? new Set<string>()
  spent.clear()
  // Ready asks given room ahead this pass.
  let waiting = 0
  // Asks no bin took that changed nothing (`Kept`): each read every bin,
  // a billion reads in a sim of 3,800 tasks, a plan of 15 s (2026-11-11).
  const kept = all?.kept ?? []
  kept.length = 0
  for (const ask of asks) {
    if (
      all !== undefined &&
      (spent.size >= all.kinds ||
        // Its bounds, kept as it gives, say it: a read of every bin an ask
        // was most of a plan's play (2026-11-05).
        (bounds !== undefined
          ? bounds.done
          : !bins.some((b) => !held.has(b) && fits(b, all.floor))))
    )
      break
    if (ask.kind !== undefined && spent.has(ask.kind)) continue
    if (
      ask.only === undefined &&
      ask.avoid === undefined &&
      failsAlike(kept, ask.need, ask.rank, ask.ms)
    )
      continue
    const { need } = ask
    const bigger = (b: B): boolean =>
      need.above === undefined || b.cores > need.above.cores || b.memory > need.above.memory
    const allowed =
      ask.only === undefined && ask.avoid === undefined
        ? bins
        : bins.filter((b) => (ask.only === undefined || b.id === ask.only) && b.id !== ask.avoid)
    const of =
      need.platform === undefined ? allowed : allowed.filter((b) => b.platform === need.platform)
    // With no size to beat, every bin is bigger: no copy of them an ask.
    const anyBigger = need.above === undefined ? of.length > 0 : of.some(bigger)
    if (!anyBigger && need.above !== undefined && waits(need.above, need.platform)) {
      if (ask.kind !== undefined) spent.add(ask.kind)
      continue
    }
    const pool = anyBigger && need.above !== undefined ? of.filter(bigger) : of
    let best: B | undefined
    let bestScore: [number, number, number] = [0, 0, 0]
    let seen = 0
    const want = all?.want?.(ask.id)
    // A hold kept it off a bin it fits: one of its kind may still fit.
    let blocked = false
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i]!
      if (held.has(b) || !fits(b, need)) continue
      if (breaks(b, ask)) {
        blocked = true
        continue
      }
      // Workers fill in order, so the first that fit hold the fullest.
      if (++seen > SAMPLE) break
      let has = 0
      for (const id of ask.up ?? []) if (b.has?.has(id) === true) has++
      // A task of no history books next to nothing but may use any share:
      // where most is free, it has room to be bigger than it booked. Best-fit
      // stacked them on one worker, which they overran: 4.47% late to 3.95%
      // on graphs a third unmeasured, 1% more worker time (lab, 2026-11-10).
      const score: [number, number, number] = [
        b.id === want ? 1 : 0,
        has,
        fit(b, need, need.ask === undefined ? place : 'worst-fit', i),
      ]
      if (
        best === undefined ||
        score[0] > bestScore[0] ||
        (score[0] === bestScore[0] &&
          (score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])))
      ) {
        best = b
        bestScore = score
      }
    }
    if (best === undefined) {
      // Ready and no room: room is kept where it first frees, so no task
      // of lower rank takes it meanwhile, a few a pass.
      const holds = ask.rank !== undefined && ask.ms !== undefined && waiting++ < pool.length
      if (holds) holdOne(pool, { need, at: 0, rank: ask.rank!, ms: ask.ms! })
      // One it fits only empty: the one using least is held for it.
      let soonest: B | undefined
      for (const b of pool) {
        if (held.has(b) || b.running === 0) continue
        if (need.cores < b.cores && need.memory <= b.memory - b.used.memory) continue
        if (soonest === undefined || b.used.cores < soonest.used.cores) soonest = b
      }
      if (soonest !== undefined) {
        held.add(soonest)
        rebound()
        continue
      }
      if (ask.kind !== undefined && !blocked) spent.add(ask.kind)
      if (
        !holds &&
        ask.only === undefined &&
        ask.avoid === undefined &&
        ask.rank !== undefined &&
        ask.ms !== undefined &&
        need.above === undefined &&
        (need.servers?.length ?? 0) === 0
      ) {
        let longest = -Infinity
        const under = { cores: Infinity, memory: Infinity }
        for (const b of pool) {
          if (held.has(b)) continue
          if (blocked && fits(b, need)) longest = Math.max(longest, window(b, ask))
          if (b.running > 0) {
            under.cores = Math.min(under.cores, b.cores)
            under.memory = Math.min(under.memory, b.memory - b.used.memory)
          }
        }
        if (kept.length === KEPT) kept.shift()
        kept.push({
          cores: need.cores,
          memory: need.memory,
          platform: need.platform,
          rank: ask.rank,
          longest,
          under,
        })
      }
      continue
    }
    spent.clear()
    kept.length = 0
    out.set(ask.id, best)
    best.used.cores += Math.min(coresOn(best, need), best.cores)
    for (const sv of need.servers ?? []) best.serving?.add(sv.id)
    best.used.memory += Math.min(need.memory, best.memory)
    best.running++
    if (best.holds !== undefined && best.ends !== undefined && ask.ms !== undefined)
      best.ends = [
        ...best.ends,
        [ask.ms, Math.min(coresOn(best, need), best.cores), Math.min(need.memory, best.memory)],
      ]
    for (const s of all?.next?.(ask.id) ?? []) holdOne(bins, s)
    rebound()
  }
  return out
}

/**
 * The bins not held, as an ask `dead` reads them: one asked of nowhere
 * fits it and holds nothing, so `assign` only spends its kind. With every
 * task its own kind, a pass read each ready one to learn that: 2.4 million
 * asks for a plan of 9000 (2026-10-25).
 */
export interface Bounds {
  /** None takes the least any ask needs: the pass is over. */
  done: boolean
  /** One is empty: every ask fits it. */
  open: boolean
  /** The most cores free on one. */
  free: number
  /** The fewest cores one has. */
  cores: number
  /** The least memory free on one. */
  memory: number
  /** The same of each platform's own: a task naming one fits only those. */
  of?: Map<string, Room>
}

/** What `Bounds` says of a set of bins. */
interface Room {
  open: boolean
  free: number
  cores: number
  memory: number
}

function boundsOf(
  bins: readonly Bin[],
  held: ReadonlySet<Bin>,
  out: Bounds,
  floor: Need | undefined,
): void {
  out.done = floor !== undefined
  out.open = false
  out.free = -Infinity
  out.cores = Infinity
  out.memory = Infinity
  out.of?.clear()
  for (const b of bins) {
    if (held.has(b)) continue
    if (floor !== undefined && fits(b, floor)) out.done = false
    room(out, b)
    if (b.platform === undefined) continue
    out.of ??= new Map()
    let p = out.of.get(b.platform)
    if (p === undefined)
      out.of.set(
        b.platform,
        (p = { open: false, free: -Infinity, cores: Infinity, memory: Infinity }),
      )
    room(p, b)
  }
}

function room(r: Room, b: Bin): void {
  if (b.running === 0) r.open = true
  r.free = Math.max(r.free, b.cores - b.used.cores)
  r.cores = Math.min(r.cores, b.cores)
  r.memory = Math.min(r.memory, b.memory - b.used.memory)
}

/**
 * True when `assign` would fit `need` on no bin and hold none for it, by
 * `fits` and its hold rule: no bin is empty, and on each it is less than
 * the bin, fits its memory, and wants more cores than are free.
 */
export function dead(need: Need, b: Bounds): boolean {
  if (need.above !== undefined) return false
  // Of its platform's bins: with none free of a hold, no ask of it does a thing.
  const r = need.platform === undefined ? b : b.of?.get(need.platform)
  if (r === undefined) return true
  return !r.open && need.cores > r.free + 1e-9 && need.cores < r.cores && need.memory <= r.memory
}

/** How well `need` suits `b` by `place`: the higher, the better. */
function fit(b: Bin, need: Need, place: Strategy['place'], index: number): number {
  switch (place) {
    case 'best-fit':
      return b.used.cores - b.cores
    case 'worst-fit':
      return b.cores - b.used.cores
    case 'first-fit':
      return -index
    case 'tetris': {
      // The dot product of the need and what is free, each as a share of
      // the worker: a task goes where its shape matches the hole.
      const cores = Math.min(need.cores, b.cores) / b.cores
      const memory = b.memory > 0 ? Math.min(need.memory, b.memory) / b.memory : 0
      const freeCores = (b.cores - b.used.cores) / b.cores
      const freeMemory = b.memory > 0 ? (b.memory - b.used.memory) / b.memory : 0
      return cores * freeCores + memory * freeMemory
    }
  }
}

/**
 * The live run's waiting tasks, kept across its passes in the order
 * `ordered` gives (`critical-path`, `fifo`) and grouped by platform and
 * cores' class: a pass places exactly as `dispatch` over the whole list,
 * but passes a group whole while no worker has room for any of it, where
 * each pass ordered and read every waiting task, a fifth of a 10 000-task
 * sim (2026-11-06). `graphene` ranks by the longest waiting tail, which
 * moves as tasks leave: it keeps the list and `dispatch`.
 */
export class Queue {
  private list: string[] | undefined
  private readonly groups = new Map<string, Group>()
  private readonly of = new Map<string, Entry>()
  private front = 0
  private back = 0

  constructor(
    private readonly how: Strategy,
    private readonly tail: ((id: string) => number) | undefined,
    private readonly need: (id: string) => Need,
  ) {
    if (how.order === 'graphene' && tail !== undefined) this.list = []
  }

  get size(): number {
    return this.list?.length ?? this.of.size
  }

  has(id: string): boolean {
    return this.list?.includes(id) ?? this.of.has(id)
  }

  /** In the order a pass reads them. */
  ids(): string[] {
    if (this.list !== undefined) return [...this.list]
    return [...this.of.values()].sort((a, b) => (before(a, b) ? -1 : 1)).map((e) => e.id)
  }

  /** `ids` join, in order, behind every one ranked as high, or `front` before all. */
  add(ids: readonly string[], front = false): void {
    if (this.list !== undefined) {
      if (front) this.list.unshift(...ids)
      else this.list.push(...ids)
      return
    }
    if (front) this.front -= ids.length
    let seq = front ? this.front : this.back
    for (const id of ids) {
      const need = this.need(id)
      const e: Entry = {
        id,
        rank: this.how.order === 'fifo' || this.tail === undefined ? 0 : -this.tail(id),
        seq: seq++,
        need,
        group: undefined!,
      }
      const odd = need.above !== undefined || need.ask !== undefined || need.cores === Infinity
      const key = `${need.platform}\0${odd ? 'odd' : Math.floor(Math.log2(Math.max(need.cores, 1e-6)) * CLASSES)}`
      let g = this.groups.get(key)
      if (g === undefined) this.groups.set(key, (g = new Group(odd, need.platform)))
      e.group = g
      g.add(e)
      this.of.set(id, e)
    }
    if (!front) this.back = seq
  }

  /**
   * History changed (`tail`, `need`): the waiting rank and group by it,
   * ties in the order they stood. A rank is read once, as a task joins:
   * on CI the roots join before the default branch's timings land, each
   * at an unknown task's 30 s, and every test shard ready later ranked
   * above them, so `test.wire` (73 s) waited 129 s for a worker (main
   * 1c91c9d, 2026-11-07). `graphene` reads ranks at each pass.
   */
  rerank(): void {
    if (this.list !== undefined) return
    const ids = this.ids()
    this.groups.clear()
    this.of.clear()
    this.front = 0
    this.back = 0
    this.add(ids)
  }

  delete(id: string): boolean {
    if (this.list !== undefined) {
      const at = this.list.indexOf(id)
      if (at >= 0) this.list.splice(at, 1)
      return at >= 0
    }
    const e = this.of.get(id)
    if (e === undefined) return false
    this.drop(e)
    return true
  }

  private drop(e: Entry): void {
    this.of.delete(e.id)
    e.gone = true
    if (e.group.drop() === 0)
      for (const [k, g] of this.groups) if (g === e.group) this.groups.delete(k)
  }

  /**
   * Where the waiting tasks go now, as `dispatch` places them; the ones
   * placed or found done leave. `book`, if given, must keep a need's
   * order by cores among needs alike but for cores.
   */
  pass<B extends Bin>(
    bins: readonly B[],
    o: Omit<Dispatching, 'how' | 'tail' | 'need'>,
  ): Map<string, B> {
    if (this.list !== undefined) {
      const { to, left } = dispatch(this.list, bins, {
        ...o,
        how: this.how,
        tail: this.tail,
        need: this.need,
      })
      this.list = left
      return to
    }
    return this.place(bins, o)
  }

  private place<B extends Bin>(
    bins: readonly B[],
    o: Omit<Dispatching, 'how' | 'tail' | 'need'>,
  ): Map<string, B> {
    const book = o.book ?? ((n: Need): Need => n)
    const gs = [...this.groups.values()]
    const floor = { cores: Infinity, memory: Infinity }
    for (const g of gs) {
      g.at = g.head()
      const low = g.low()
      if (low === undefined) continue
      // Booked as its least: what each of its tasks books is at least this.
      g.lo = g.odd ? Infinity : book(low).cores
      floor.cores = Math.min(floor.cores, g.odd ? g.oddFloor(book) : g.lo)
      floor.memory = Math.min(floor.memory, g.memory())
    }
    const bounds: Bounds = { done: false, open: true, free: 0, cores: 0, memory: 0 }
    const done: Entry[] = []
    let cursor: Entry | undefined
    const kept = new Set<string>()
    function* asks(): Generator<Ask> {
      for (;;) {
        if (bounds.done) return
        // The group whose next is first, past any no worker has room for now.
        let g: Group | undefined
        let second: Entry | undefined
        for (const x of gs) {
          if (x.at >= x.q.length) continue
          if (!x.odd && x.full(bounds)) {
            const e = o.soon === undefined ? undefined : x.q[x.skip(x.at)]
            if (e !== undefined) holdReady(bins, kept, e.id, book(e.need), -e.rank, o.ms?.(e.id))
            continue
          }
          if (cursor !== undefined && !before(cursor, x.q[x.at]!)) x.at = x.after(cursor)
          x.at = x.skip(x.at)
          const e = x.q[x.at]
          if (e === undefined) continue
          if (g === undefined || before(e, g.q[g.at]!)) {
            if (g !== undefined && (second === undefined || before(g.q[g.at]!, second)))
              second = g.q[g.at]!
            g = x
          } else if (second === undefined || before(e, second)) second = e
        }
        if (g === undefined) return
        // Its run up to the next group's first, read one by one as before.
        for (;;) {
          const e = g.q[g.at]
          if (e === undefined || (second !== undefined && !before(e, second))) break
          g.at = g.skip(g.at + 1)
          cursor = e
          if (bounds.done) return
          const need = book(e.need)
          if (dead(need, bounds)) {
            if (o.soon !== undefined) holdReady(bins, kept, e.id, need, -e.rank, o.ms?.(e.id))
            continue
          }
          const gate = o.gate?.(e.id) ?? {}
          if (gate === 'done') {
            done.push(e)
            continue
          }
          if (gate === 'wait') continue
          yield {
            id: e.id,
            need,
            up: o.deps(e.id) ?? [],
            ...gate,
            ...(o.soon === undefined ? {} : { rank: -e.rank, ms: o.ms?.(e.id) ?? Infinity }),
          }
          break
        }
      }
    }
    if (o.soon !== undefined) holdFor(bins, o.soon)
    const to = assign(asks(), bins, o.waits, this.how.place, {
      floor,
      kinds: Infinity,
      bounds,
      ...(o.soon === undefined || o.next === undefined ? {} : { next: o.next }),
      ...(o.want === undefined ? {} : { want: o.want }),
    })
    for (const e of done) if (!e.gone) this.drop(e)
    for (const id of to.keys()) this.drop(this.of.get(id)!)
    return to
  }
}

/** Classes a doubling of cores spans (`Queue`'s groups). */
const CLASSES = 4

interface Entry {
  readonly id: string
  /** The lower first, then the lower `seq`. */
  readonly rank: number
  readonly seq: number
  readonly need: Need
  group: Group
  gone?: boolean
}

function before(a: Entry, b: Entry): boolean {
  return a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq)
}

/** Waiting tasks of one platform and cores' class, in rank order; gone ones linger until half are. */
class Group {
  q: Entry[] = []
  private gone = 0
  /** Where a pass reads next. */
  at = 0
  /** The least any of it books, this pass. */
  lo = Infinity
  /** The most cores and memory one asked: kept as they joined until it is read again without the gone. */
  private hiCores = -Infinity
  private hiMemory = -Infinity
  /** Its least cores and memory, gone ones lazily left off the top. */
  private readonly byCores: Entry[] = []
  private readonly byMemory: Entry[] = []

  constructor(
    readonly odd: boolean,
    readonly platform: string | undefined,
  ) {}

  add(e: Entry): void {
    let lo = 0
    let hi = this.q.length
    // Most join last: a search from the end.
    if (hi === 0 || before(this.q[hi - 1]!, e)) lo = hi
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (before(this.q[mid]!, e)) lo = mid + 1
      else hi = mid
    }
    this.q.splice(lo, 0, e)
    this.hiCores = Math.max(this.hiCores, e.need.cores)
    this.hiMemory = Math.max(this.hiMemory, e.need.memory)
    push(this.byCores, e, (x) => x.need.cores)
    push(this.byMemory, e, (x) => x.need.memory)
  }

  /** One of it left: how many are left. */
  drop(): number {
    this.gone++
    const left = this.q.length - this.gone
    if (this.gone > left) {
      this.q = this.q.filter((e) => !e.gone)
      this.gone = 0
      this.hiCores = -Infinity
      this.hiMemory = -Infinity
      for (const e of this.q) {
        this.hiCores = Math.max(this.hiCores, e.need.cores)
        this.hiMemory = Math.max(this.hiMemory, e.need.memory)
      }
    }
    return left
  }

  head(): number {
    return this.skip(0)
  }

  skip(p: number): number {
    while (p < this.q.length && this.q[p]!.gone === true) p++
    return p
  }

  /** The first place ranked past `cursor`. */
  after(cursor: Entry): number {
    let p = this.at
    let hi = this.q.length
    while (p < hi) {
      const mid = (p + hi) >> 1
      if (!before(cursor, this.q[mid]!)) p = mid + 1
      else hi = mid
    }
    return p
  }

  low(): Need | undefined {
    return top(this.byCores, (x) => x.need.cores)?.need
  }

  memory(): number {
    return top(this.byMemory, (x) => x.need.memory)?.need.memory ?? Infinity
  }

  /** An odd group's least booked: read one by one, as books of each differ. */
  oddFloor(book: (n: Need) => Need): number {
    let least = Infinity
    for (let p = this.at; p < this.q.length; p++)
      if (this.q[p]!.gone !== true) least = Math.min(least, book(this.q[p]!.need).cores)
    return least
  }

  /** No worker of its platform has room for any of it now, as `dead` says of each. */
  full(b: Bounds): boolean {
    const r = this.platform === undefined ? b : b.of?.get(this.platform)
    if (r === undefined) return true
    return !r.open && this.lo > r.free + 1e-9 && this.hiCores < r.cores && this.hiMemory <= r.memory
  }
}

/** A binary min-heap of entries by `by`. */
function push(h: Entry[], e: Entry, by: (e: Entry) => number): void {
  h.push(e)
  let i = h.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (by(h[p]!) <= by(h[i]!)) break
    ;[h[p], h[i]] = [h[i]!, h[p]!]
    i = p
  }
}

/** The least of `h` not gone, the gone ones above it popped. */
function top(h: Entry[], by: (e: Entry) => number): Entry | undefined {
  while (h.length > 0 && h[0]!.gone === true) {
    const last = h.pop()!
    if (h.length === 0) break
    h[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < h.length && by(h[l]!) < by(h[m]!)) m = l
      if (r < h.length && by(h[r]!) < by(h[m]!)) m = r
      if (m === i) break
      ;[h[m], h[i]] = [h[i]!, h[m]!]
      i = m
    }
  }
  return h[0]
}
