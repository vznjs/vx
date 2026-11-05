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
  const byTail = (x: string, y: string): number => tail(y) - tail(x)
  if (how === 'critical-path') return [...ids].sort(byTail)
  // Troublesome: within a quarter of the longest chain, or half a worker wide.
  let longest = 0
  for (const id of ids) longest = Math.max(longest, tail(id))
  const hard = (id: string): boolean => tail(id) >= 0.75 * longest || need(id).cores >= cores / 2
  return [...ids].sort((x, y) => Number(hard(y)) - Number(hard(x)) || byTail(x, y))
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
}

/**
 * Where the `waiting` tasks go now: ordered (`ordered`), gated, and placed
 * (`assign`). The one rule of the live run (`Orchestrator.pump`, at each
 * message) and of the sims (`tests/sim.ts`, at each event): each kept its
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
  const left: string[] = []
  const asks: Ask[] = []
  // The least any ask needs: once no worker takes it, the pass ends. Each
  // pump read every queued task, 8000 of them a pump (2026-10-25).
  const floor = { cores: Infinity, memory: Infinity }
  for (const id of queue) {
    const gate = o.gate?.(id) ?? {}
    if (gate === 'done') continue
    if (gate === 'wait') {
      left.push(id)
      continue
    }
    const need = o.book === undefined ? o.need(id) : o.book(o.need(id))
    floor.cores = Math.min(floor.cores, need.cores)
    floor.memory = Math.min(floor.memory, need.memory)
    asks.push({ id, need, up: o.deps(id) ?? [], ...gate })
  }
  const to = assign(asks, bins, o.waits, o.how.place, { floor, kinds: Infinity })
  for (const ask of asks) if (!to.has(ask.id)) left.push(ask.id)
  return { to, left }
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
}

/** What `Ask.kind` names: every field of a need `assign` reads. */
export function kindOf(need: Need): string {
  return `${need.cores}\0${need.memory}\0${need.above?.cores}\0${need.above?.memory}\0${need.platform}`
}

/**
 * Whether `need` fits on `bin` now: alone on an empty one, whatever it
 * asks; beside others only in full, cores and memory. Beside others on a
 * free core alone, main's workers booked 4.3 of 4 (2026-10-23).
 */
export function fits(bin: Bin, need: Need): boolean {
  if (need.platform !== undefined && bin.platform !== need.platform) return false
  if (bin.running === 0) return true
  return (
    need.cores < bin.cores &&
    bin.used.cores + need.cores <= bin.cores + 1e-9 &&
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
    /** Where it keeps the bins' bounds as it gives, for the asks to skip each `dead` one as it reads. */
    readonly bounds?: Bounds
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
  for (const ask of asks) {
    if (
      all !== undefined &&
      (spent.size >= all.kinds || !bins.some((b) => !held.has(b) && fits(b, all.floor)))
    )
      break
    if (ask.kind !== undefined && spent.has(ask.kind)) continue
    const { need } = ask
    const bigger = (b: B): boolean =>
      need.above === undefined || b.cores > need.above.cores || b.memory > need.above.memory
    const allowed =
      ask.only === undefined && ask.avoid === undefined
        ? bins
        : bins.filter((b) => (ask.only === undefined || b.id === ask.only) && b.id !== ask.avoid)
    const of =
      need.platform === undefined ? allowed : allowed.filter((b) => b.platform === need.platform)
    const anyBigger = of.some(bigger)
    if (!anyBigger && need.above !== undefined && waits(need.above, need.platform)) {
      if (ask.kind !== undefined) spent.add(ask.kind)
      continue
    }
    const pool = anyBigger ? of.filter(bigger) : of
    let best: B | undefined
    let bestScore: [number, number] = [0, 0]
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i]!
      if (held.has(b) || !fits(b, need)) continue
      let has = 0
      for (const id of ask.up ?? []) if (b.has?.has(id) === true) has++
      const score: [number, number] = [has, fit(b, need, place, i)]
      if (
        best === undefined ||
        score[0] > bestScore[0] ||
        (score[0] === bestScore[0] && score[1] > bestScore[1])
      ) {
        best = b
        bestScore = score
      }
    }
    if (best === undefined) {
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
      } else if (ask.kind !== undefined) spent.add(ask.kind)
      continue
    }
    spent.clear()
    out.set(ask.id, best)
    best.used.cores += Math.min(need.cores, best.cores)
    best.used.memory += Math.min(need.memory, best.memory)
    best.running++
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
  for (const b of bins) {
    if (held.has(b)) continue
    if (floor !== undefined && fits(b, floor)) out.done = false
    if (b.running === 0) out.open = true
    out.free = Math.max(out.free, b.cores - b.used.cores)
    out.cores = Math.min(out.cores, b.cores)
    out.memory = Math.min(out.memory, b.memory - b.used.memory)
  }
}

/**
 * True when `assign` would fit `need` on no bin and hold none for it, by
 * `fits` and its hold rule: no bin is empty, and on each it is less than
 * the bin, fits its memory, and wants more cores than are free.
 */
export function dead(need: Need, b: Bounds): boolean {
  return (
    need.platform === undefined &&
    need.above === undefined &&
    !b.open &&
    need.cores > b.free + 1e-9 &&
    need.cores < b.cores &&
    need.memory <= b.memory
  )
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
