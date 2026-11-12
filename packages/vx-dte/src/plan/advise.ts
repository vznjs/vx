import { DEFAULT_STRATEGY, type Strategy } from './strategy.js'
import {
  MARGIN,
  MARGIN_MS,
  type PlanTask,
  type PlanWorker,
  type Size,
  UNKNOWN_MS,
} from './model.js'
import { dropSpare, fresh, play, simulate, sized } from './play.js'
import { candidates } from './plan.js'

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
  const tasks = ran.map((t) => ({ ...t, ...sized(t, sizes) }))
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
  const halved = (
    of: readonly Size[],
  ): { fleets: Fleets; kept: PlanWorker[]; held: number } | undefined => {
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
    return { fleets: { fleet: fleetOf(kept, of), endMs: before.end }, kept, held: before.held() }
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
    // Each held from its ask to its last task's end, warm-up and idle
    // cores counted: charged to the run's end, one small task's worker
    // cost as much as the busiest (2026-11-11).
    tried.push({ fleets: got.fleets, coreMs: got.held, workers: got.kept.length })
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
