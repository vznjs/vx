// What a distributed run recorded, read back: the `workers` rows of the
// footer, the summary's machines, and the run's ideal, perfect and least
// ends with what kept it from them. The orchestrator (`orchestrator.ts`)
// places tasks and fills this record as they run.

import { ui, type MachineReport, type WorkerAdvice } from '@vzn/vx'
import {
  advise,
  type Fleets,
  type PlanTask,
  type Size,
  spreadMs,
  wholeCores,
} from './plan/index.js'
import { playAside } from './replays.js'
import type { Usage, UsageStats } from './usage.js'

/** What a worker was started as: its size's `cpu` and `memory` in bytes. */
export interface Declared {
  readonly size: string
  readonly cpu: number
  readonly memory: number
  /** Its size's platform: a worker reporting another is refused. None: planned as this machine's. */
  readonly platform?: string
  /** Where tasks match it when the run has several worker types: `<type>:<platform>`. */
  readonly place?: string
}

/** A worker as the record reads it. */
export interface RecordedWorker {
  /** What the run gives it: its machine, held to its declared size. */
  readonly cores: number
  readonly memory: number
  /** What its machine has, as it reported on joining. */
  readonly reported: { readonly cores: number; readonly memory: number }
  /** Its machine's platform, as it reported on joining. */
  readonly platform: string | undefined
  readonly label: string
  /** From its start to its join, when this run started it. */
  readonly warmUpMs: number | undefined
  /** When it joined. */
  readonly joinedAt: number
  /** The size it was started as, when this run started it. */
  readonly declared: Declared | undefined
  /** Their ids, for the summary of a worker that ran few: what held it. */
  readonly done: string[]
  readonly usage: Usage
  /** Of `busy`, the ones it began: each one sent, as a worker runs what it takes at once. */
  readonly started: Set<string>
  /** Cores its machine spends on no task of the run while it runs some, averaged over its frames (`heard`). */
  other?: number
  /** It failed a task it began: it gets no more. */
  faulty: boolean
}

/** A worker that ran this many tasks or fewer names them in the summary. */
const FEW = 2
/** The unmeasured tasks the summary names; the rest it counts. */
const NAMED = 40
/** How long the advice's replays may hold the run's end, ms. */
const ADVICE_MS = 2_000
/** The footer's label of each `WorkerAdvice`. */
const ADVICE: Record<WorkerAdvice['of'], readonly [label: string, note: string]> = {
  declared: ['best', 'the fewest of its sizes'],
  more: ['more', "past its sizes' max"],
  any: ['any', 'of any cores, the least core time'],
}
/** A platform as shown: a worker type's place (`ubuntu:linux-x64`) without its type, which its size names. */
const bare = (platform: string): string => platform.slice(platform.indexOf(':') + 1)
/** `3 × small (4c/16G linux)`. */
const fleetText = (w: WorkerAdvice['workers'][number]): string =>
  `${w.count} × ${w.size === undefined ? '' : `${w.size} `}(${w.cores}c/${compact(w.memoryBytes)}${w.platform === undefined ? '' : ` ${w.platform}`})`
/** Core-time of history the run's tasks finish before their use reshapes bookings: a few tasks' worth. */
export const LEARN_MS = 60_000

/** What kept a run from its perfect end, in ms along the chain that ended it (`driftOf`). */
interface Drift {
  /** Waiting for a worker to join, past the fastest warm-up. */
  readonly joining: number
  /** Waiting for room on a joined worker. */
  readonly room: number
  /** From its send to its worker beginning it: its inputs reaching it. */
  readonly sending: number
  /** From a dependency's end on its worker to the run handing over the task that waited on it: its files coming to this machine. */
  readonly home: number
  /** Waiting on an uncached dependency made again for it: its files lay on a worker that left or stayed full. */
  readonly again: number
  /** The run's time after its last task. */
  readonly after: number
}

/** The record a run fills as it places tasks, and the reports read from it. */
export class RunReport<W extends RecordedWorker> {
  protected readonly workers = new Map<string, W>()
  /** When each worker this run started was asked for, by `WorkerSpawn.index`. */
  protected readonly spawnedAt = new Map<string, { at: number; declared: Declared }>()
  protected ended = false
  protected endedAt = 0
  /** Workers that joined and left, for the footer. */
  protected readonly gone: W[] = []
  /** Of `gone`, those the run let go (`release`), not lost. */
  protected readonly retired = new Set<W>()
  /** Workers asked for that never joined, with why. */
  protected readonly unstarted = new Map<string, string>()
  /** A task waited here on a worker: one ended with none joined needed one. */
  protected waited = false
  /** Why each worker this run refused was refused, in order. */
  protected readonly refused: string[] = []
  /** Started, then not needed before they joined (`release`). */
  protected readonly cancelled = new Set<string>()
  /** When each cancelled one was: held from its ask until then (`heldMs`). */
  protected readonly cancelledAt = new Map<string, number>()
  protected readonly startedAt = performance.now()
  /** When core's cache probe answered, how many placed tasks it left to run, and how many it found in no cache. */
  protected probe?: { at: number; left: number; misses: number }
  /** Each task a worker ran: how long it held the worker, the cores it held (or used, if more) meanwhile, its memory, the platform. */
  protected readonly took = new Map<
    string,
    { ms: number; cores: number; memory: number; platform: string | undefined }
  >()
  /** Each uncached task made again for a dependant: from its ask to its end, each time. */
  protected readonly madeAgain = new Map<string, [number, number][]>()
  /** Each task a worker ran: when it joined the queue, was sent, began and ended, and when its worker joined. */
  protected readonly timeline = new Map<
    string,
    { queued: number; sent: number; began: number; end: number; joined: number }
  >()
  /** Each time the run asked for workers: when, how many, for which work, ending when. */
  protected readonly asks: {
    at: number
    workers: number
    tasks: number
    measured: number
    endsInMs: number
  }[] = []
  /**
   * The tasks the first ask had no measure of, each booking a guess:
   * named, so a run that packed badly says which (main 68b851d, 2026-10-23:
   * 41 of 119, small#7 holding 3.9 cores for a task using 0.3).
   */
  protected unmeasured: readonly string[] = []
  /**
   * Core-time measured tasks used here, and what their history said they
   * would: tasks booked at their history used 82% of it on every Linux
   * worker of cold run 3 (66% of the cores against the sim's 86%,
   * 2026-10-23). A measured task books its need times what they used.
   */
  protected usedMs = 0
  protected needMs = 0

  /**
   * The shortest time a worker this run asked for took to join, once one
   * has: what a worker asked for now takes, at the least.
   */
  warmUpMs(): number | undefined {
    let least: number | undefined
    for (const a of [...this.workers.values(), ...this.gone])
      if (a.warmUpMs !== undefined && !(least! <= a.warmUpMs)) least = a.warmUpMs
    return least
  }

  /** Each task a worker ran, how long it held the worker, by `forecast`'s ms (`slowdowns`). */
  finished(
    forecast: (id: string) => number | undefined,
  ): { took: number; forecast: number | undefined; platform: string | undefined }[] {
    return [...this.took].map(([id, t]) => ({
      took: t.ms,
      forecast: forecast(id),
      platform: t.platform,
    }))
  }

  /** `warmUpMs` of each size a worker this run started joined as. */
  warmUpsMs(): Map<string, number> {
    const out = new Map<string, number>()
    for (const a of [...this.workers.values(), ...this.gone]) {
      const size = a.declared?.size
      if (a.warmUpMs === undefined || size === undefined) continue
      if (!(out.get(size)! <= a.warmUpMs)) out.set(size, a.warmUpMs)
    }
    return out
  }

  /** Each size's workers' warm-ups, in the order they joined. */
  private warmUps(): Map<string, number[]> {
    const ups = new Map<string, number[]>()
    for (const a of [...this.workers.values(), ...this.gone]) {
      const size = a.declared?.size
      if (a.warmUpMs === undefined || size === undefined) continue
      const of = ups.get(size)
      if (of === undefined) ups.set(size, [a.warmUpMs])
      else of.push(a.warmUpMs)
    }
    return ups
  }

  /**
   * How much later each next worker of a size joined than the one before,
   * this run (`spreadMs`): each size two of which joined.
   */
  spreadsMs(): Map<string, number> {
    return new Map(
      [...this.warmUps()].flatMap(([size, ms]) => (ms.length < 2 ? [] : [[size, spreadMs(ms)]])),
    )
  }

  /** Each size's cores its machines spent besides the run's tasks, on average: what the plan leaves it. */
  othersOf(): Map<string, number> {
    const sum = new Map<string, [number, number]>()
    for (const a of [...this.workers.values(), ...this.gone]) {
      const size = a.declared?.size
      if (size === undefined || a.other === undefined || a.cores !== a.reported.cores) continue
      const [s, n] = sum.get(size) ?? [0, 0]
      sum.set(size, [s + a.other, n + 1])
    }
    return new Map([...sum].map(([size, [s, n]]) => [size, s / n]))
  }

  /**
   * `left` when the run let it go as not needed, `lost` when it crashed or
   * went silent, `stopped` when the run's end stopped it, else `online`.
   */
  private state(a: W, gone: ReadonlySet<W>): string {
    if (this.retired.has(a)) return 'left'
    if (gone.has(a)) return 'lost'
    return this.ended ? 'stopped' : 'online'
  }

  /**
   * The run's ideal end: the best it could do on the workers it may start
   * (2026-11-18: "we shoud have a ideal time with current configuration
   * not perfect. for perfect that should be othe rnumber"). Its perfect
   * end (`perfectMs`), or later where a platform's work, each task's cores
   * for as long as it held them, fills every core its sizes' `max` allows,
   * each worker from the first ask after its own real warm-up: the spread
   * of joins is a side effect no plan escapes (2026-11-18: "We should not
   * be penalized for that"), and when it asked is the plan's own. A slot
   * no worker joined counts from its platform's fastest warm-up. Still a
   * floor: no run with these sizes beats it. With no sizes it is the
   * perfect end.
   */
  idealMs(depsOf: (id: string) => readonly string[], sizes: readonly Size[]): number | undefined {
    const perfect = this.perfectMs(depsOf)
    const r = this.replay(depsOf)
    if (perfect === undefined || r === undefined) return perfect
    const work = new Map<string | undefined, number>()
    for (const t of r.tasks)
      work.set(t.platform, (work.get(t.platform) ?? 0) + t.cores * (t.ms ?? 0))
    const ups = this.warmUps()
    let end = perfect
    for (const [platform, w] of work) {
      // Each core slot's start, and its cores.
      const slots: [number, number][] = []
      for (const s of sizes) {
        if (platform !== undefined && s.platform !== undefined && s.platform !== platform) continue
        const own = [...(ups.get(s.name) ?? [])].sort((a, b) => a - b)
        for (let i = 0; i < s.max; i++) slots.push([own[i] ?? r.warm(platform), s.cpu])
      }
      if (slots.length === 0) continue
      slots.sort((a, b) => a[0] - b[0])
      // Water-filled: the end at which the slots online by then hold the work.
      let cores = 0
      let started = 0
      let at = Infinity
      for (let i = 0; i < slots.length; i++) {
        cores += slots[i]![1]
        started += slots[i]![0] * slots[i]![1]
        at = (w + started) / cores
        if (i + 1 === slots.length || at <= slots[i + 1]![0]) break
      }
      if (cores > 0) end = Math.max(end, r.from + at)
    }
    return end
  }

  /**
   * The run's perfect end, no worker cap: the end no run of these tasks
   * could beat on as many workers as it liked (2026-11-17: the footer's
   * ideal was a replay under our placing rule and the sizes' caps, and a
   * run ended before it): its longest chain, each task as long as it held
   * its worker, on workers never short of room, each there after its
   * platform's fastest real warm-up from when the run first knew its
   * work. A task waits on its deps through those no worker ran (groups,
   * hits). What the planner said before the run is its estimate (`asks`).
   */
  perfectMs(depsOf: (id: string) => readonly string[]): number | undefined {
    const r = this.replay(depsOf)
    if (r === undefined) return undefined
    const byId = new Map(r.tasks.map((t) => [t.id, t]))
    const ends = new Map<string, number>()
    let end = 0
    // On an explicit stack: a graph is as deep as its longest chain.
    for (const root of r.tasks) {
      const stack = [root]
      while (stack.length > 0) {
        const t = stack[stack.length - 1]!
        if (ends.has(t.id)) {
          stack.pop()
          continue
        }
        const waits = t.deps.flatMap((d) => (ends.has(d) ? [] : [byId.get(d)!]))
        if (waits.length > 0) {
          stack.push(...waits)
          continue
        }
        const at = Math.max(r.warm(t.platform), ...t.deps.map((d) => ends.get(d)!))
        ends.set(t.id, at + (t.ms ?? 0))
        end = Math.max(end, at + (t.ms ?? 0))
        stack.pop()
      }
    }
    return r.from + end
  }

  /**
   * The least CPU its ideal could hold (2026-11-11: "Allocated cpu but
   * not used counts as used"): on each platform, its tasks' cores for as
   * long as each held its worker, on workers of the size that holds the
   * least, each holding its cores less what its machine spends besides
   * the run's tasks (`othersOf`), as few as end that work by the ideal end
   * (`perfectMs`), each held through its warm-up. One warm-up for the run
   * was a floor no run reached: a run that ends at its chain starts as
   * many workers as its width needs, and each warms up (main 5c2463f:
   * 14.9 core-min where the least of 4 smalls and a Mac held 26,
   * 2026-11-12).
   */
  leastHeldMs(
    depsOf: (id: string) => readonly string[],
    sizes: readonly Size[],
    end = this.perfectMs(depsOf),
  ): number | undefined {
    const r = this.replay(depsOf)
    if (r === undefined) return undefined
    const work = new Map<string | undefined, number>()
    for (const t of r.tasks)
      work.set(t.platform, (work.get(t.platform) ?? 0) + t.cores * (t.ms ?? 0))
    const all = [...this.workers.values(), ...this.gone]
    const others = this.othersOf()
    const offered =
      sizes.length > 0
        ? sizes.filter((s) => s.max > 0)
        : all.map((a) => ({ name: '', cpu: a.cores, platform: a.platform }))
    const within = end === undefined ? Infinity : end - r.from
    let ms = 0
    for (const [platform, w] of work) {
      let least = Infinity
      for (const s of offered) {
        if (platform !== undefined && s.platform !== undefined && s.platform !== platform) continue
        const usable = Math.max(s.cpu / 2, s.cpu - wholeCores(others.get(s.name) ?? 0))
        const warm = r.warm(s.platform ?? platform)
        const each = usable * Math.max(0, within - warm)
        const n = each > 0 && Number.isFinite(each) ? Math.max(1, Math.ceil(w / each)) : 1
        least = Math.min(least, (w * s.cpu) / usable + n * s.cpu * warm)
      }
      ms += Number.isFinite(least) ? least : w
    }
    return ms
  }

  /**
   * The CPU the run's workers held: each its cores from when the run asked
   * for it (or it joined, one that joined on its own) until it left, was
   * cancelled or the run ended, idle or not.
   */
  heldMs(): number {
    const until = this.ended ? this.endedAt : performance.now()
    let ms = 0
    const joined = new Set<string>()
    for (const a of [...this.workers.values(), ...this.gone]) {
      joined.add(a.label)
      const from = this.spawnedAt.get(a.label)?.at ?? a.usage.from
      ms += a.cores * Math.max(0, (a.usage.to ?? until) - from)
    }
    for (const [id, { at, declared }] of this.spawnedAt)
      if (!joined.has(id) && !this.unstarted.has(id))
        ms += declared.cpu * Math.max(0, (this.cancelledAt.get(id) ?? until) - at)
    return ms
  }

  /**
   * What kept the run from its ideal (2026-11-11: "Could the summary tell
   * us what caused the drift from ideal"): along the chain that ended it,
   * from its last task back through the dependency each waited on last,
   * the time each waited past when its ideal could start it (as
   * `perfectMs`, its platform's fastest warm-up from when the run knew its
   * work) for its worker or another asked for its platform to join, then
   * for room with every one joined; the time its
   * inputs took to reach it once sent; the time from its dependency's end
   * to the run handing it over, that dependency's files coming to this
   * machine; and the run's time after its last task. `undefined` with no task run on a worker.
   */
  driftOf(depsOf: (id: string) => readonly string[]): Drift | undefined {
    const r = this.replay(depsOf)
    if (r === undefined) return undefined
    const deps = new Map(r.tasks.map((t) => [t.id, t.deps]))
    const platform = new Map(r.tasks.map((t) => [t.id, t.platform]))
    let id: string | undefined
    for (const [t, l] of this.timeline)
      if (id === undefined || l.end > this.timeline.get(id)!.end) id = t
    if (id === undefined) return undefined
    const until = this.ended ? this.endedAt : performance.now()
    const joinedAt = new Map(
      [...this.workers.values(), ...this.gone].map((a) => [a.label, a.joinedAt]),
    )
    const out = {
      joining: 0,
      room: 0,
      sending: 0,
      home: 0,
      again: 0,
      after: Math.max(0, until - this.timeline.get(id)!.end),
    }
    for (const seen = new Set<string>(); id !== undefined && !seen.has(id);) {
      seen.add(id)
      const l = this.timeline.get(id)!
      const earliest = Math.max(l.queued, this.startedAt + r.from + r.warm(platform.get(id)))
      const lost = Math.max(0, l.sent - earliest)
      // Its own worker joining, and any other asked for its platform: the
      // room it waited for was theirs to bring (main 7fc6691: six workers
      // queued 58-216 s at GitHub read as 231.6 s waiting for room).
      const late: [number, number][] = [[earliest, l.joined]]
      for (const [w, { at, declared }] of this.spawnedAt)
        if (declared.platform === undefined || declared.platform === platform.get(id))
          late.push([
            at + r.warm(platform.get(id)),
            // let go by the plan, no longer
            joinedAt.get(w) ?? this.cancelledAt.get(w) ?? until,
          ])
      const joining = covered(late, earliest, l.sent)
      const again = covered(
        (deps.get(id) ?? []).flatMap((d) => this.madeAgain.get(d) ?? []),
        earliest,
        l.sent,
      )
      out.joining += joining
      out.again += Math.min(again, lost - joining)
      out.room += Math.max(0, lost - joining - again)
      out.sending += l.began - l.sent
      let next: string | undefined
      for (const d of deps.get(id) ?? []) {
        const e = this.timeline.get(d)?.end
        if (e !== undefined && (next === undefined || e > this.timeline.get(next)!.end)) next = d
      }
      // The run hands a task over once its dependencies' files are on this
      // machine (main f04866b: 4.4 s of 6.0 s past the ideal, and no part
      // named it).
      if (next !== undefined) out.home += Math.max(0, l.queued - this.timeline.get(next)!.end)
      id = next
    }
    return out
  }

  /**
   * The workers that would have run this run best (`advise`), from the
   * same replay as `perfectMs`: on `sizes`, past their `max`, and of any
   * cores. With no sizes (workers that join on their own), the shapes
   * that joined stand for them, as many as joined.
   */
  advice(
    depsOf: (id: string) => readonly string[],
    sizes: readonly Size[],
    budgetMs = ADVICE_MS,
  ): WorkerAdvice[] {
    // The footer and the summary each ask once the run ended: played once.
    if (this.ended && this.advised !== undefined) return this.advised
    const out = this.advise(depsOf, sizes, budgetMs)
    if (this.ended) this.advised = out
    return out
  }

  private advised: WorkerAdvice[] | undefined
  /** The advice's replays ran past their budget: it was not worked out. */
  private adviceCut = false

  private advise(
    depsOf: (id: string) => readonly string[],
    sizes: readonly Size[],
    budgetMs: number,
  ): WorkerAdvice[] {
    const r = this.replay(depsOf)
    if (r === undefined) return []
    const shapes: Size[] =
      sizes.length > 0
        ? [...sizes]
        : [
            ...[...this.workers.values(), ...this.gone]
              .reduce((by, a) => {
                const name = `${a.cores}c/${a.platform ?? ''}`
                const had = by.get(name)
                by.set(name, {
                  name,
                  max: (had?.max ?? 0) + 1,
                  cpu: a.cores,
                  memory: a.memory,
                  platform: a.platform,
                })
                return by
              }, new Map<string, Size>())
              .values(),
          ]
    // Bounded: the replays grow faster than the run, and a 2,000-task run's
    // held its end for good. Past the budget, no line is given: a fleet
    // cut short reads as no better, so what finished is not exact either.
    const deadline = Date.now() + budgetMs
    const a = advise(r.tasks, shapes, r.warm, playAside(r.tasks, r.warm, deadline))
    this.adviceCut = Date.now() >= deadline
    if (this.adviceCut) return []
    const wire = (of: WorkerAdvice['of'], f: Fleets | undefined): WorkerAdvice[] =>
      f === undefined
        ? []
        : [
            {
              of,
              endMs: Math.round(r.from + f.endMs),
              workers: f.fleet.map((w) => ({
                count: w.count,
                cores: w.cores,
                memoryBytes: w.memory,
                ...(w.platform === undefined ? {} : { platform: bare(w.platform) }),
                ...(w.size === undefined || sizes.length === 0 ? {} : { size: w.size }),
              })),
            },
          ]
    return [...wire('declared', a.declared), ...wire('more', a.more), ...wire('any', a.any)]
  }

  /**
   * Each task a worker ran, as long as it held its worker and with the
   * cores it held there (or used, if more), waiting on its deps through those no worker
   * ran (groups, hits); each platform's fastest real warm-up; and when
   * the run first knew its work.
   */
  private replay(depsOf: (id: string) => readonly string[]):
    | {
        tasks: PlanTask[]
        warm: (platform: string | undefined) => number
        from: number
      }
    | undefined {
    if (this.took.size === 0) return undefined
    const all = [...this.workers.values(), ...this.gone]
    const warm = new Map<string | undefined, number>()
    for (const a of all)
      if (a.warmUpMs !== undefined && !(warm.get(a.platform)! <= a.warmUpMs))
        warm.set(a.platform, a.warmUpMs)
    const least = this.warmUpMs() ?? 0
    const seen = new Map<string, string[]>()
    const ran = (id: string): string[] => {
      const known = seen.get(id)
      if (known !== undefined) return known
      seen.set(id, [])
      // Each once, as `planTasks`: a diamond of groups held a task once per path.
      const out = [...new Set(depsOf(id).flatMap((d) => (this.took.has(d) ? [d] : ran(d))))]
      seen.set(id, out)
      return out
    }
    return {
      tasks: [...this.took].map(([id, t]) => ({ id, ...t, deps: ran(id) })),
      warm: (platform) => warm.get(platform) ?? least,
      from: this.probe?.at ?? this.asks[0]?.at ?? 0,
    }
  }

  /**
   * Each machine that joined, and this one when it ran tasks, with what it
   * did: the run summary's `machines`. Core asks once its tasks are over,
   * before its teardown ends this run: then is its end, so one still here
   * was online until now (small#2 read online 1ms, booked 433802 of 4:
   * main, 2026-10-23). Each is `ok`, or `failed` when lost or faulty.
   */
  machines(): MachineReport[] {
    const gone = new Set(this.gone)
    const until = this.ended ? this.endedAt : performance.now()
    const report = (
      name: string,
      status: string,
      u: Usage,
      cores: number,
      memoryBytes: number,
    ): MachineReport => {
      const st = u.stats(cores, until)
      return {
        name,
        status,
        cores,
        memoryBytes,
        done: u.done,
        failed: u.failed,
        ...(u.aborted > 0 ? { aborted: u.aborted } : {}),
        onlineMs: st.onlineMs,
        busyMs: st.busyMs,
        cpuPeak: st.cpuPeak,
        cpuAvg: st.cpuAvg,
        memoryPeakBytes: st.memoryPeak,
        memoryAvgBytes: st.memoryAvg,
        utilization: st.utilization,
        bookedAvg: st.bookedAvg,
      }
    }
    return [...this.workers.values(), ...this.gone].map((a) => ({
      // Whether it failed or ran its part, not why it left (2026-10-23).
      ...report(
        a.label,
        (gone.has(a) && !this.retired.has(a)) || a.faulty ? 'failed' : 'ok',
        a.usage,
        a.reported.cores,
        a.reported.memory,
      ),
      ...(a.warmUpMs === undefined ? {} : { warmUpMs: a.warmUpMs }),
      startMs: Math.max(0, a.usage.from - (a.warmUpMs ?? 0) - this.startedAt),
    }))
  }

  /**
   * The `workers` rows, live and at the end: one per worker by `size#index`
   * with its status, the tasks it has done and the ones it runs now, then
   * this machine's; once over, each joined worker's warm-up and, under
   * each, the cores and memory its size declares and its machine reports;
   * and `ideal`, the run's `idealMs`, and `perfect`, its `perfectMs`,
   * asked once it ended, with what kept the run from them (`drift`).
   */
  footer(
    ideal?: () => number | undefined,
    perfect?: () => number | undefined,
    advice?: () => readonly WorkerAdvice[],
    drift?: () => Drift | undefined,
    least?: () => number | undefined,
  ): [string, ui.Inline][] {
    // Over with none, it says so: core's own `N workers` (this machine's
    // pool) read as the run's when no task needed one (2026-10-25), and
    // says when one did and none joined (2026-11-06), and why any it
    // refused was (2026-11-07).
    if (this.spawnedAt.size === 0 && this.workers.size === 0 && this.gone.length === 0)
      return this.ended
        ? [
            [
              'workers',
              this.refused.length > 0
                ? ui.tone(
                    'warn',
                    `none joined: ${this.refused.length} refused (${this.refused[0]})`,
                  )
                : this.waited
                  ? ui.tone('warn', 'none joined: a task waited on one')
                  : ui.dim('none started: no task needed one'),
            ],
          ]
        : this.waited
          ? [['workers', ui.tone('info', '0 joined · waiting for a worker to join the relay')]]
          : []
    const gone = new Set(this.gone)
    const all = [...this.workers.values(), ...this.gone]
    const joined = new Set(all.map((a) => a.label))
    const count = (u: Usage, running: number): string =>
      [
        `${u.done} done`,
        ...(u.failed > 0 ? [`${u.failed} failed`] : []),
        ...(u.aborted > 0 ? [`${u.aborted} aborted`] : []),
        ...(running > 0 ? [`${running} running`] : []),
      ].join(' · ')
    // Once over, under its row: what its size declares and what its machine
    // reports, green when they agree, red when not.
    const res = new Map<string, ui.Inline>()
    const resources = (label: string, cores: number, memory: number, d?: Declared): void => {
      const actual = `${cores}c/${compact(memory)}`
      res.set(
        label,
        d === undefined
          ? ui.dim(`${indent}actual ${actual}`)
          : [
              ui.dim(`${indent}declared ${d.cpu}c/${compact(d.memory)} · actual `),
              ui.tone(matches(cores, memory, d) ? 'ok' : 'error', actual),
            ],
      )
    }
    // Live, those that left are one line: a run that replaced many pushed
    // the rows that run past the screen.
    const left = this.ended ? [] : all.filter((a) => this.retired.has(a))
    const lines: [string, string, string][] = all
      .filter((a) => !left.includes(a))
      .map((a) => [
        a.label,
        this.state(a, gone),
        count(a.usage, gone.has(a) ? 0 : a.started.size) +
          (this.ended && a.warmUpMs !== undefined ? ` · warm-up ${seconds(a.warmUpMs)}` : '') +
          (this.ended && a.done.length > 0 && a.done.length <= FEW
            ? ` · ${a.done.join(', ')}`
            : ''),
      ])
    for (const id of this.spawnedAt.keys())
      if (!joined.has(id) && !this.cancelled.has(id)) {
        const why = this.unstarted.get(id)
        // Over, the run waits on none: one still starting then never joined.
        lines.push(
          why !== undefined
            ? [id, 'failed', why]
            : this.ended
              ? [id, 'not joined', 'the run ended first']
              : [id, 'starting', ''],
        )
      }
    lines.sort((x, y) => x[0].localeCompare(y[0], 'en', { numeric: true }))
    const cancelled = [...this.cancelled].filter((id) => !joined.has(id)).length
    if (cancelled > 0)
      lines.push([`${cancelled} worker${cancelled === 1 ? '' : 's'}`, 'cancelled', 'not needed'])
    if (left.length > 0)
      lines.push([
        `${left.length} worker${left.length === 1 ? '' : 's'}`,
        'left',
        `${left.reduce((n, a) => n + a.usage.done, 0)} done`,
      ])
    const width = Math.max(...lines.map(([l]) => l.length))
    const indent = ' '.repeat(width + 2)
    const status = Math.max(...lines.map(([, st]) => st.length))
    // Once over, what each did, under its line.
    const usage = new Map<string, readonly string[]>()
    let cpuMs = 0
    let tasksMs = 0
    let workerMs: number | undefined
    let coreMs = 0
    if (this.ended)
      for (const a of all) {
        resources(a.label, a.reported.cores, a.reported.memory, a.declared)
        const st = a.usage.stats(a.cores, this.endedAt)
        cpuMs += st.workCoreMs
        tasksMs += st.tasksUtilization * a.cores * st.workMs
        if (st.workerUtilization !== undefined)
          workerMs = (workerMs ?? 0) + st.workerUtilization * a.cores * st.workMs
        coreMs += a.cores * st.workMs
        usage.set(a.label, describe(st, a.usage))
      }
    return [
      ...lines.flatMap(([l, st, t], i): [string, ui.Inline][] => [
        [
          i === 0 ? 'workers' : '',
          st === 'failed'
            ? [ui.place(l), `${' '.repeat(width - l.length)}  `, ui.tone('error', st), `  ${t}`]
            : t === ''
              ? [ui.place(l), `${' '.repeat(width - l.length)}  ${st}`]
              : [ui.place(l), `${' '.repeat(width - l.length)}  ${st.padEnd(status)}  ${t}`],
        ],
        ...(res.has(l) ? [['', res.get(l)!] as [string, ui.Inline]] : []),
        ...(usage.get(l) ?? []).map((d): [string, ui.Inline] => ['', ui.dim(`${indent}${d}`)]),
      ]),
      ...(this.ended && this.probe !== undefined
        ? [
            [
              '',
              ui.dim(
                `${'probe'.padEnd(width)}  at ${seconds(this.probe.at)}: ${plural(this.probe.left, 'task')} left to run, ${plural(this.probe.misses, 'known miss')}`,
              ),
            ] as [string, ui.Inline],
          ]
        : []),
      ...(this.ended && this.asks.length > 0
        ? [
            [
              '',
              ui.dim(
                `${'asked'.padEnd(width)}  ${this.asks
                  .map(
                    (x) =>
                      `${x.workers} at ${seconds(x.at)} for ${plural(x.tasks, 'task')} (${x.measured} measured), estimate ${seconds(x.endsInMs)}`,
                  )
                  .join(' · ')}`,
              ),
            ] as [string, ui.Inline],
            // Beside core's time row, how close the run came (2026-10-23),
            // to the best its sizes allow and to the best with no cap
            // (2026-11-18).
            ...((best, ms) =>
              ms === undefined
                ? []
                : [
                    ...(best === undefined
                      ? []
                      : [
                          [
                            '',
                            ui.dim(
                              `${'ideal'.padEnd(width)}  ${seconds(best)}: the best the workers it may start allow, its longest chain or each platform's work on all their cores`,
                            ),
                          ] as [string, ui.Inline],
                        ]),
                    [
                      '',
                      ui.dim(
                        `${'perfect'.padEnd(width)}  ${seconds(ms)}: its longest chain as long as it took, no task waiting for a worker${((h) => (h === undefined ? '' : `, holding ${coreTime(h)} at least`))(least?.())}`,
                      ),
                    ] as [string, ui.Inline],
                    ...driftRow(
                      this.endedAt - this.startedAt - (best ?? ms),
                      this.endedAt - this.startedAt - ms,
                      drift?.(),
                      width,
                    ),
                  ])(ideal?.(), perfect?.()),
            // What to declare next time (2026-11-05: "So I can add more
            // or change their specs").
            ...(advice?.() ?? []).map(
              (a) =>
                [
                  '',
                  ui.dim(
                    `${ADVICE[a.of][0].padEnd(width)}  ${a.workers.map(fleetText).join(' + ')}: ${seconds(a.endMs)}, ${ADVICE[a.of][1]}`,
                  ),
                ] as [string, ui.Inline],
            ),
            ...(advice !== undefined && this.adviceCut
              ? [
                  [
                    '',
                    ui.dim(
                      `${'best'.padEnd(width)}  not worked out: replaying the run on each fleet took past its ${ADVICE_MS / 1000}s`,
                    ),
                  ] as [string, ui.Inline],
                ]
              : []),
            ...(this.unmeasured.length === 0
              ? []
              : [
                  [
                    '',
                    ui.dim(
                      `${'unmeasured'.padEnd(width)}  ${this.unmeasured.slice(0, NAMED).join(', ')}${this.unmeasured.length > NAMED ? ` and ${this.unmeasured.length - NAMED} more` : ''}`,
                    ),
                  ] as [string, ui.Inline],
                ]),
          ]
        : []),
      ...(coreMs > 0
        ? [
            [
              '',
              `${'total'.padEnd(width)}  ${utilization(cpuMs / coreMs, tasksMs / coreMs, workerMs === undefined ? undefined : workerMs / coreMs)}${this.needMs < LEARN_MS ? '' : ` · tasks used ${percent(this.usedMs / this.needMs)} of their history`} · held ${coreTime(this.heldMs())}`,
            ] as [string, ui.Inline],
          ]
        : []),
    ]
  }
}

/** Core-time as read: `42.0 core-s`, `12.5 core-min`, `3.2 core-h`. */
function coreTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} core-s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} core-min`
  return `${(ms / 3_600_000).toFixed(1)} core-h`
}

/**
 * The footer's `drift` row: how far past its ideal and its perfect end the
 * run ended, and the parts of the latter `driftOf` names, each of a tenth
 * of a second or more.
 */
function driftRow(
  past: number,
  pastPerfect: number,
  d: Drift | undefined,
  width: number,
): [string, ui.Inline][] {
  if (d === undefined || pastPerfect < 100) return []
  const parts = (
    [
      ['workers joining', d.joining],
      ['waiting for room', d.room],
      ['sending inputs', d.sending],
      ['files coming home', d.home],
      ['a dependency made again', d.again],
      ['after the last task', d.after],
    ] as const
  )
    .filter(([, ms]) => ms >= 100)
    .map(([what, ms]) => `${what} ${seconds(ms)}`)
  return [
    [
      '',
      ui.dim(
        `${'drift'.padEnd(width)}  ${past > 0 ? `+${seconds(past)}` : `-${seconds(-past)}`} past ideal, +${seconds(pastPerfect)} past perfect${parts.length > 0 ? `: ${parts.join(' · ')}` : ''}`,
      ),
    ],
  ]
}

/** Core-time busy over core-time had, from first send to last end: its machine, its tasks, its worker. */
function utilization(machine: number, tasks: number, worker: number | undefined): string {
  return `cpu utilization machine ${percent(machine)} · tasks ${percent(tasks)}${worker === undefined ? '' : ` · worker ${percent(worker)}`}`
}

/** A worker's run, spelled out: time, CPU, memory and the relay. */
function describe(st: UsageStats, u: Usage): string[] {
  return [
    `online ${seconds(st.onlineMs)} · busy ${seconds(st.busyMs)} · idle ${seconds(Math.max(0, st.onlineMs - st.busyMs))}`,
    `cpu peak ${st.cpuPeak.toFixed(1)} · used avg ${st.cpuAvg.toFixed(1)} cores${st.machineAvg === undefined ? '' : ` · machine avg ${st.machineAvg.toFixed(1)}`} · booked avg ${st.bookedAvg.toFixed(1)}`,
    utilization(st.utilization, st.tasksUtilization, st.workerUtilization),
    // No task said what it held: `memory peak 0 B` would be a claim.
    ...(st.memoryPeak > 0
      ? [`memory peak ${bytes(st.memoryPeak)} · avg ${bytes(st.memoryAvg)}`]
      : []),
    `sent ${plural(u.messagesIn, 'message')} · ${bytes(u.bytesIn)}, received ${plural(u.messagesOut, 'message')} · ${bytes(u.bytesOut)}`,
  ]
}

const plural = (n: number, w: string): string =>
  `${n} ${w}${n === 1 ? '' : w.endsWith('s') ? 'es' : 's'}`
const percent = (n: number): string => `${Math.round(n * 100)}%`
const bytes = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : n >= 1e3
        ? `${Math.round(n / 1e3)} KB`
        : `${n} B`

/** A machine is what its size says: the same cores, memory within a tenth. */
const matches = (cores: number, memory: number, d: Declared): boolean =>
  cores === d.cpu && Math.abs(memory - d.memory) <= d.memory * 0.1

/** Bytes as whole gigabytes, one decimal under 10: `16G`, `0.5G`. */
const compact = (n: number): string => {
  const g = n / 1e9
  return `${g >= 10 ? Math.round(g) : Number(g.toFixed(1))}G`
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/** How much of `from`..`to` the spans cover, counted once where they overlap. */
function covered(spans: readonly [number, number][], from: number, to: number): number {
  let ms = 0
  let at = from
  for (const [a, b] of spans.toSorted((x, y) => x[0] - y[0])) {
    const start = Math.max(at, a)
    const end = Math.min(to, b)
    if (end > start) {
      ms += end - start
      at = end
    }
  }
  return ms
}
