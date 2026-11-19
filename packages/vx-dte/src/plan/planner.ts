// The engine (engine.ts) by task and worker name: what a live run and the
// sim both drive, event by event, so the two decide alike (one logic,
// 2026-11-05). The run's graph is its tasks that run a command; a task
// with none (a group) passes its dependencies on.

import type { TaskNode } from '@vzn/vx'
import { Engine, type Fits } from './engine.js'

/** A kind of worker the run may ask for. */
export interface PlannerSize {
  readonly name: string
  readonly cores: number
  readonly memory: number
  readonly max: number
  readonly platform: string
  /** Its warm-up as an earlier run knew it (ms). */
  readonly warmUpMs: number
  /** How much later each next worker of it joined than the one before, an earlier run (ms). */
  readonly spreadMs?: number
}

/** What history knew of a task: its time alone (ms) and the cores it kept busy. */
export interface Known {
  readonly ms: number | undefined
  readonly cores: number | undefined
}

export interface PlannerInput {
  readonly nodes: ReadonlyMap<string, TaskNode>
  /** Its platform: the worker platform it runs on. */
  readonly platform: (n: TaskNode) => string
  readonly sizes: readonly PlannerSize[]
  readonly known: (id: string) => Known | undefined
  /** The tasks the run expects to miss before any does; the rest count as hits until handed over. */
  readonly expected: ReadonlySet<string>
  /** What a task history never measured keeps busy (`dte({ unmeasured })`). */
  readonly unmeasuredCores?: number
}

export interface PlannerDecision {
  /** Tasks to start now, each on a joined worker. */
  readonly start: readonly (readonly [task: string, worker: string])[]
  /** Workers asked now, as `spawn` named them. */
  readonly ask: readonly string[]
  /** Idle workers no forecast task needs: let go. */
  readonly leave: readonly string[]
  /** When to decide again with nothing else happening (ms), or Infinity. */
  readonly due: number
  /** When its plan ends the run (ms). */
  readonly end: number
}

/** What may run where, by name (`Fits`). */
export interface PlannerFits {
  on?(task: string, worker: string, now: boolean): boolean
  size?(task: string, size: PlannerSize): boolean
  stay?(worker: string): boolean
  /** Cores the worker uses now, as measured. */
  load?(worker: string): number
  /** `task` starts on `worker` now, after those this decision started before it; false: it waits. */
  admit?(task: string, worker: string): boolean
}

/** The tasks that run a command, each with the ones it waits on, groups passed through. */
export function commands(nodes: ReadonlyMap<string, TaskNode>): Map<string, string[]> {
  const runs = (n: TaskNode): boolean => n.config.exec?.command !== undefined
  const through = new Map<string, string[]>()
  const upOf = (id: string): string[] => {
    const had = through.get(id)
    if (had !== undefined) return had
    const out = new Set<string>()
    through.set(id, [])
    for (const d of nodes.get(id)?.deps ?? []) {
      const n = nodes.get(d)
      if (n === undefined) continue
      if (runs(n)) out.add(d)
      else for (const x of upOf(d)) out.add(x)
    }
    const r = [...out]
    through.set(id, r)
    return r
  }
  const graph = new Map<string, string[]>()
  for (const [id, n] of nodes) {
    if (!runs(n)) continue
    const deps = new Set<string>()
    for (const d of n.deps) {
      const m = nodes.get(d)
      if (m === undefined) continue
      if (runs(m)) deps.add(d)
      else for (const x of upOf(d)) deps.add(x)
    }
    graph.set(id, [...deps])
  }
  return graph
}

export class Planner {
  readonly ids: readonly string[]
  private readonly ix = new Map<string, number>()
  private readonly engine: Engine
  private readonly workerIx = new Map<string, number>()
  private readonly workerId: string[] = []
  private readonly sizeIx: Map<string, number>
  /** Each platform's size for a worker the run did not start. */
  private readonly loose = new Map<string, number>()
  /** The sizes it may ask for, then each platform's for a worker of none (`max` 0). */
  readonly sizes: readonly PlannerSize[]

  constructor(private readonly input: PlannerInput) {
    const graph = commands(input.nodes)
    this.ids = [...graph.keys()]
    this.ids.forEach((id, i) => this.ix.set(id, i))
    this.sizeIx = new Map(input.sizes.map((s, z) => [s.name, z]))
    const platforms = this.ids.map((id) => input.platform(input.nodes.get(id)!))
    // A worker of no size (one joining on its own) counts as one of its platform's that is never asked for.
    const sizes = [...input.sizes]
    for (const p of new Set([...platforms, ...input.sizes.map((s) => s.platform)])) {
      this.loose.set(p, sizes.length)
      sizes.push({ name: '', cores: 1, memory: 0, max: 0, platform: p, warmUpMs: 0 })
    }
    this.sizes = sizes
    const { ms, cores } = this.history()
    this.engine = new Engine(
      {
        deps: this.ids.map((id) => graph.get(id)!.map((d) => this.ix.get(d)!)),
        platform: platforms,
        ms,
        sd: ms.map(() => null),
        cores,
      },
      sizes.map((s) => ({
        cores: s.cores,
        max: s.max,
        platform: s.platform,
        warmUpMs: s.warmUpMs,
        spreadMs: s.spreadMs ?? 0,
      })),
      {
        gated: true,
        ...(input.unmeasuredCores === undefined ? {} : { unmeasuredCores: input.unmeasuredCores }),
      },
    )
    this.ids.forEach((id, i) => {
      if (!input.expected.has(id)) this.engine.assume(i)
    })
  }

  private history(): { ms: (number | null)[]; cores: number[] } {
    const ms: (number | null)[] = []
    const cores: number[] = []
    for (const id of this.ids) {
      const k = this.input.known(id)
      ms.push(k?.ms ?? null)
      // a task keeps at least the one core it is given busy
      cores.push(Math.max(1, k?.cores ?? 1))
    }
    return { ms, cores }
  }

  /** History landed or changed: read it again. */
  learn(): void {
    const { ms, cores } = this.history()
    this.engine.learn(
      ms,
      ms.map(() => null),
      cores,
    )
  }

  /** The tasks history measured. */
  measured(): number {
    let n = 0
    for (const id of this.ids) if (this.input.known(id)?.ms !== undefined) n++
    return n
  }

  has(task: string): boolean {
    return this.ix.has(task)
  }

  /** Core handed `task` over: it may start. */
  ready(task: string): void {
    const i = this.ix.get(task)
    if (i !== undefined) this.engine.ready(i)
  }

  /** `task` may not start until `ready` again. */
  hold(task: string): void {
    const i = this.ix.get(task)
    if (i !== undefined) this.engine.hold(i)
  }

  /** `task` will not run here (a hit, or the run no longer needs it). */
  drop(task: string, t: number): void {
    const i = this.ix.get(task)
    if (i !== undefined) this.engine.drop(i, t)
  }

  /** `task`'s command ended at `t`, having taken `ms` alone; absent, as long as the engine believes. */
  finished(task: string, t: number, ms?: number): void {
    const i = this.ix.get(task)
    if (i !== undefined) this.engine.finished(i, t, ms)
  }

  /** `task` runs again: back from a worker that failed it, or made again for a dependant, on its `platform`. */
  again(task: string, platform?: string): void {
    const i = this.ix.get(task)
    if (i !== undefined) this.engine.again(i, platform)
  }

  /**
   * A worker started before the planner knew it, or joining on its own:
   * of `size`, else (no size, or one the planner does not ask for) counted
   * as its platform's, with `cores`.
   */
  adopt(
    worker: string,
    size: string | undefined,
    platform: string,
    cores: number,
    t: number,
  ): void {
    const w = this.workerIx.get(worker)
    if (w !== undefined && !this.engine.gone(w)) return
    const sized = size === undefined ? undefined : this.sizeIx.get(size)
    const z = sized ?? this.loose.get(platform)
    if (z === undefined) return
    this.name(this.engine.adopt(z, t, sized === undefined ? cores : this.sizes[z]!.cores), worker)
  }

  /** `worker`, asked, is past when it was due to join at `t` (its warm-up, behind the ones of its size before it). */
  overdue(worker: string, t: number): boolean {
    const w = this.workerIx.get(worker)
    return w !== undefined && this.engine.overdue(w, t)
  }

  knows(worker: string): boolean {
    const w = this.workerIx.get(worker)
    return w !== undefined && !this.engine.gone(w)
  }

  joined(worker: string, t: number): void {
    const w = this.workerIx.get(worker)
    if (w !== undefined) this.engine.joined(w, t)
  }

  /** `worker` is gone (left, lost, faulty, cancelled): what it held runs elsewhere. */
  lost(worker: string, t: number): void {
    const w = this.workerIx.get(worker)
    if (w !== undefined) this.engine.lost(w, t)
  }

  private name(w: number, id: string): void {
    this.workerIx.set(id, w)
    this.workerId[w] = id
  }

  /** What to do at `t`; `spawn` names each worker asked, of its size. */
  decide(t: number, spawn: (size: PlannerSize) => string, fits: PlannerFits = {}): PlannerDecision {
    const { ids, workerId } = this
    const f: Fits = {
      ...(fits.on === undefined
        ? {}
        : { on: (i: number, w: number, now: boolean) => fits.on!(ids[i]!, workerId[w]!, now) }),
      ...(fits.size === undefined
        ? {}
        : { size: (i: number, z: number) => fits.size!(ids[i]!, this.sizes[z]!) }),
      ...(fits.stay === undefined ? {} : { stay: (w: number) => fits.stay!(workerId[w]!) }),
      ...(fits.load === undefined ? {} : { load: (w: number) => fits.load!(workerId[w]!) }),
      ...(fits.admit === undefined
        ? {}
        : { admit: (i: number, w: number) => fits.admit!(ids[i]!, workerId[w]!) }),
    }
    const d = this.engine.decide(t, f)
    const ask = d.ask.map(([w, z]) => {
      const id = spawn(this.sizes[z]!)
      this.name(w, id)
      return id
    })
    return {
      start: d.start.map(([i, w]) => [ids[i]!, workerId[w]!] as const),
      ask,
      leave: d.leave.map((w) => workerId[w]!),
      due: d.due,
      end: d.end,
    }
  }
}
