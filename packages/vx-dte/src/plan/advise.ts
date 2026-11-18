import { MARGIN, MARGIN_MS, type PlanTask, type Size } from './model.js'
import { replay } from './replay.js'

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

const marginOf = (ms: number): number => Math.max(MARGIN_MS, ms * MARGIN)

/**
 * The run's workers, judged after it: `tasks` as each took, played by the
 * live engine from nothing with every time known (`replay`), on `sizes`;
 * again with each size's `max` lifted; and on one shape a platform of any
 * cores. Each worker joins after its platform's `warm` warm-up.
 */
export function advise(
  tasks: readonly PlanTask[],
  sizes: readonly Size[],
  warm: (platform: string | undefined) => number,
): Advice {
  if (tasks.length === 0) return {}
  const on = (of: readonly Size[]): { fleets: Fleets; heldMs: number; workers: number } | undefined => {
    const r = replay(tasks, of, warm)
    if (!Number.isFinite(r.endMs)) return undefined
    const fleet = of.flatMap((s, z) =>
      r.asked[z] === 0
        ? []
        : [{ count: r.asked[z]!, cores: s.cpu, memory: s.memory, platform: s.platform, size: s.name }],
    )
    return {
      fleets: { fleet, endMs: r.endMs },
      heldMs: r.heldMs,
      workers: r.asked.reduce((a, b) => a + b, 0),
    }
  }
  const declared = sizes.length === 0 ? undefined : on(sizes)?.fleets
  const wider = sizes.some((s) => s.max < Infinity)
    ? on(sizes.map((s) => ({ ...s, max: Infinity })))?.fleets
    : undefined
  const more =
    wider !== undefined &&
    declared !== undefined &&
    wider.endMs + marginOf(declared.endMs) < declared.endMs
      ? wider
      : undefined
  // Of any cores: each platform's memory a core as its sizes have most.
  const platforms = new Set(tasks.map((t) => t.platform))
  const ratio = new Map<string | undefined, number>()
  for (const s of sizes)
    ratio.set(s.platform, Math.max(ratio.get(s.platform) ?? 0, s.memory / s.cpu))
  const most = new Map<string | undefined, number>()
  for (const t of tasks) most.set(t.platform, Math.max(most.get(t.platform) ?? 0, t.memory))
  const tried: { fleets: Fleets; heldMs: number; workers: number }[] = []
  for (const cores of SHAPES) {
    const shapes: Size[] = [...platforms].map((platform) => ({
      name: `${cores}#${platform ?? ''}`,
      max: Infinity,
      cpu: cores,
      memory: Math.max(
        cores * (ratio.get(platform) ?? ratio.get(undefined) ?? MEMORY_PER_CORE),
        most.get(platform) ?? 0,
      ),
      platform,
    }))
    const got = on(shapes)
    if (got !== undefined) tried.push(got)
  }
  let any: Fleets | undefined
  if (tried.length > 0) {
    const soonest = Math.min(...tried.map((t) => t.fleets.endMs))
    const bound = soonest + marginOf(soonest)
    let cheapest: (typeof tried)[number] | undefined
    for (const t of tried)
      if (
        t.fleets.endMs <= bound &&
        (cheapest === undefined ||
          t.heldMs < cheapest.heldMs ||
          // As cheap, fewer machines.
          (t.heldMs === cheapest.heldMs && t.workers < cheapest.workers))
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
