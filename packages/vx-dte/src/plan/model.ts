import type { TaskNode } from '@vzn/vx'

/** A worker's warm-up before one has joined: CI's took 15 to 23 s. */
export const WARM_UP_MS = 20_000
/** How much later than the best a fleet may end and still be advised: a few seconds, or 5%. */
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

/** A task that ran: how long, on how many cores and how much memory, after which tasks. */
export interface PlanTask {
  readonly id: string
  readonly cores: number
  readonly memory: number
  readonly ms: number | undefined
  readonly deps: readonly string[]
  /** The platform it ran on: only a worker of it runs it. */
  readonly platform?: string | undefined
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

/** What a task asks of a worker: its history's cores and peak memory. */
export interface Need {
  readonly cores: number
  readonly memory: number
  /** It filled a machine this big last time: only a bigger one takes it, if any worker is. */
  readonly above?: { readonly cores: number; readonly memory: number } | undefined
  /** The platform it runs on (`ExecuteRequest.platform`): only a worker of it takes it. */
  readonly platform?: string | undefined
  /**
   * What it counts for when the run is sized, when that is not what it
   * books: an unmeasured task books next to nothing, so it goes to any
   * free core, but a run of only such tasks still asks enough workers.
   */
  readonly ask?: { readonly cores: number; readonly memory: number } | undefined
  /**
   * Its persistent dependencies' bases, cores (`server-fit.ts`): a worker
   * not running one yet books its base once beside the task, and keeps it
   * booked while it serves. `ms`: its start, which the task waits before
   * its command.
   */
  readonly servers?:
    | readonly { readonly id: string; readonly cores: number; readonly ms?: number }[]
    | undefined
}

/** The fewest cores a measured task books: averages hide its bursts (plugin.ts `needOf`). */
export const MIN_CORES = 1

/**
 * The cores a measured task books: its average to the nearest quarter, a
 * whole core at least. An average reads a tenth off run to run and a
 * worker fills in full only: a shard at 1.09 took a 2-core Mac alone for
 * 63 s while one at 1 waited 77 s for room, and the run ended 8 s late
 * (main d155ad8, 2026-11-13); one at 1.03 fit beside no three others on 4.
 */
export const bookedCores = (cores: number): number => Math.max(MIN_CORES, Math.round(cores * 4) / 4)

/**
 * What a machine spends besides the run's tasks, as the run books it: whole
 * cores only. A task books a whole core at least (`MIN_CORES`) and uses
 * less, which covers the rest: 0.93 core taken off a 4-core worker left
 * room for 3 shards, and main's ran at 2.6 of 4 cores while shards waited
 * 150-200 s for room (afb260a, 2026-11-12).
 */
export const wholeCores = (cores: number): number => Math.max(0, Math.floor(cores - 0.5 + 1e-9))

/**
 * `need` against its platform's `sizes`: when only some of them fit it,
 * `above` the ones that do not, so a worker too small never takes it.
 */
export function sized(
  need: Need,
  sizes: readonly Size[],
  platform: string | undefined = need.platform,
): Need {
  if (need.above !== undefined || need.ask !== undefined || !Number.isFinite(need.cores))
    return need
  const of = sizes.filter((s) => platform === undefined || s.platform === platform)
  const roomy = (s: Size): boolean => s.cpu >= need.cores - 1e-9 && s.memory >= need.memory
  const fit = of.filter(roomy).length
  if (fit === 0 || fit === of.length) return need
  const byCores = of.every((s) => s.cpu < need.cores - 1e-9 || s.memory >= need.memory)
  const byMemory = of.every((s) => s.memory < need.memory || s.cpu >= need.cores - 1e-9)
  return {
    ...need,
    above:
      byMemory && !byCores
        ? { cores: Infinity, memory: need.memory - 1 }
        : { cores: need.cores - 1e-6, memory: Infinity },
  }
}
