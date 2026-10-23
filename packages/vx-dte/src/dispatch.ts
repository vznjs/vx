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
  /** Its dependencies, all the way up: a worker holding them is preferred. */
  readonly up?: Iterable<string>
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
 * bigger one only, unless none is or `waits(above)` says one is coming.
 * The first that fits nowhere but an empty bin holds the one using least: no task after it goes there, or later tasks fill it again and
 * again (check.bun, the gate of 56 tasks, waited 50 s on main 871ffba).
 * Bins' `used` and `running` count what is given.
 */
export function assign<B extends Bin>(
  asks: readonly Ask[],
  bins: readonly B[],
  waits: (above: NonNullable<Need['above']>) => boolean = () => false,
  place: Strategy['place'] = 'best-fit',
): Map<string, B> {
  const out = new Map<string, B>()
  const held = new Set<B>()
  for (const ask of asks) {
    const { need } = ask
    const bigger = (b: B): boolean =>
      need.above === undefined || b.cores > need.above.cores || b.memory > need.above.memory
    const of = need.platform === undefined ? bins : bins.filter((b) => b.platform === need.platform)
    const anyBigger = of.some(bigger)
    if (!anyBigger && need.above !== undefined && waits(need.above)) continue
    const pool = anyBigger ? of.filter(bigger) : of
    const up = ask.up === undefined ? [] : [...ask.up]
    let best: B | undefined
    let bestScore: [number, number] = [0, 0]
    for (const b of pool) {
      if (held.has(b) || !fits(b, need)) continue
      let has = 0
      for (const id of up) if (b.has?.has(id) === true) has++
      const score: [number, number] = [has, fit(b, need, place, pool.indexOf(b))]
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
      if (soonest !== undefined) held.add(soonest)
      continue
    }
    out.set(ask.id, best)
    best.used.cores += Math.min(need.cores, best.cores)
    best.used.memory += Math.min(need.memory, best.memory)
    best.running++
  }
  return out
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
