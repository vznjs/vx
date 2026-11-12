// What a run learns of its workers and servers, kept as tasks are: each size
// and server is a measure core keeps in history and a history plugin shares,
// read back next run by its definition. A size changed (cores, memory,
// platform, runner) starts over.

import { taskDefinitions, type Measure, type TaskNode } from '@vzn/vx'

/** The plugin's name: core keeps a plugin's measures under it. */
const PLUGIN = '@vzn/vx-dte'

/** A worker size as its measures are defined by: its name and what it is. */
export interface MeasuredSize {
  readonly name: string
  readonly platform: string
  readonly cpu: number
  readonly memory: number
  readonly runsOn: string | undefined
}

/** A size's worker as a task: its warm-up (ms), and the cores its machine spends besides the run's tasks. */
export const workerId = (size: string): string => `${PLUGIN}#worker:${size}`
/** How much later each next worker of a size joins than the one before (ms). */
export const spreadId = (size: string): string => `${PLUGIN}#join-spread:${size}`
/** A server's base: the cores it uses with no dependant's work (`server-fit.ts`). */
export const baseId = (server: string): string => `${PLUGIN}#server-base:${server}`

const hash = (s: string): string => Bun.hash.xxHash3(s).toString(16).padStart(16, '0')

/** Each measure of `sizes` and of the graph's servers, id → definition hash. */
export function measureDefs(
  sizes: readonly MeasuredSize[],
  nodes: ReadonlyMap<string, TaskNode>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of sizes) {
    const def = JSON.stringify([s.platform, s.cpu, s.memory, s.runsOn ?? null])
    for (const id of [workerId(s.name), spreadId(s.name)]) out.set(id, hash(`${id}\0${def}`))
  }
  const servers = [...nodes.values()].filter((n) => n.config.exec?.persistent !== undefined)
  for (const [server, def] of taskDefinitions(servers)) {
    const id = baseId(server)
    out.set(id, hash(`${id}\0${def}`))
  }
  return out
}

/** What a run learned, as the plan reads it. */
export interface Learned {
  /** Each size's warm-up (ms). */
  readonly warmUps: Map<string, number>
  /** Each size's cores its machines spend besides the run's tasks. */
  readonly others: Map<string, number>
  /** Each size's join spread (ms). */
  readonly spreads: Map<string, number>
  /** Each server's base (cores). */
  readonly bases: Map<string, number>
}

/** The measures history forecast (`measuresFor`), by what each is of. */
export function learnedOf(
  got: ReadonlyMap<string, { durationMs: number; cores?: number }>,
): Learned {
  const out: Learned = {
    warmUps: new Map(),
    others: new Map(),
    spreads: new Map(),
    bases: new Map(),
  }
  for (const [id, m] of got) {
    const name = id.slice(id.indexOf(':') + 1)
    if (id.startsWith(`${PLUGIN}#worker:`)) {
      out.warmUps.set(name, m.durationMs)
      if (m.cores !== undefined) out.others.set(name, m.cores)
    } else if (id.startsWith(`${PLUGIN}#join-spread:`)) out.spreads.set(name, m.durationMs)
    else if (id.startsWith(`${PLUGIN}#server-base:`) && m.cores !== undefined)
      out.bases.set(name, m.cores)
  }
  return out
}

/**
 * This run's measures: each size a worker of joined (its least warm-up,
 * its machines' other cores), each size two joined (its spread), each
 * server base this run fitted. Only those `defs` defines.
 */
export function runMeasures(
  defs: ReadonlyMap<string, string>,
  run: {
    warmUps: ReadonlyMap<string, number>
    others: ReadonlyMap<string, number>
    spreads: ReadonlyMap<string, number>
    bases: ReadonlyMap<string, number>
  },
): Measure[] {
  const out: Measure[] = []
  const add = (id: string, durationMs: number, cores?: number): void => {
    const def = defs.get(id)
    if (def === undefined) return
    out.push(cores === undefined ? { id, def, durationMs } : { id, def, durationMs, cores })
  }
  for (const [size, ms] of run.warmUps) add(workerId(size), ms, run.others.get(size))
  for (const [size, ms] of run.spreads) add(spreadId(size), ms)
  for (const [server, cores] of run.bases) add(baseId(server), 0, cores)
  return out
}
