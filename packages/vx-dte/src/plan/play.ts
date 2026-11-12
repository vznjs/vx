// How many workers a run's rest needs, and which idle ones it can let go:
// its known work played out on the workers it has and on N more, as the
// orchestrator would place it. The best end is all N's; one of the N
// starts only when a task reaches its latest start for that end with no
// room elsewhere. The run plays again at each event: a miss
// found, a task done, a worker joined, history read.

import {
  assign,
  dead,
  allFailAlike,
  failsAlike,
  fits,
  kindOf,
  ordered,
  holdFor,
  type Ask,
  type Bin,
  type Bounds,
  type Kept,
  type Soon,
  type Span,
} from './dispatch.js'
import { DEFAULT_STRATEGY, type Strategy } from './strategy.js'
import {
  leftMs,
  MARGIN_MS,
  type Need,
  numberedOf,
  type PlanTask,
  type PlanWorker,
  type Size,
  UNKNOWN_MS,
} from './model.js'

/** A dormant worker a play started, and when the task it started for got ready. */
interface Wake {
  readonly id: string
  /** From when it had room: its first task's ready, no sooner than its warm-up. */
  readonly readyAt: number
}

/**
 * `t`'s time on `s`: on fewer cores than it asks, it shares them, as
 * on a worker. Counted whole, a plan let the last 4-core worker go and
 * ran 4-core tasks on 2 cores at half pace, 6% late.
 */
const msOn = (t: PlanTask, s: { readonly cores: number }): number =>
  (t.ms ?? UNKNOWN_MS) * (Number.isFinite(t.cores) ? Math.max(1, t.cores / s.cores) : 1)

/** How many times its guess a task of no history may run: its chain's start comes that much sooner. */
const RISK = 2

/**
 * How many times its chain a task's latest start leaves before the end:
 * history is a guess, and a task with slack that waits on it ran late
 * when tasks took up to 3 times theirs. Counted once, 0.5 to 3 times off
 * ended 2.2% late against 1.1% for starting at once; three times, 0.7%.
 */
const CHAIN_TIMES = 3
/** Lanes a core: what a play's claims count room in. */
const LANES = 4

interface Slot extends Bin {
  at: number
  /** Not started: `play` starts it when a task needs it, and it joins `warm` ms on. */
  dormant?: boolean
  readonly warm: number
  /** When each quarter-core is free, soonest first (`claim`): made as first read. */
  lanes?: number[]
  /** Its tasks' ends to come, cores and memory: when it has room again. */
  readonly endsAt: [at: number, cores: number, memory: number][]
  /** When it is first given a task. */
  first?: number
  /** When its last task ends. */
  free?: number
  /** When its last task given in the play ends. */
  last?: number
  /** The tasks given it in the play. */
  given?: string[]
  /** It takes no task from then (`PlanWorker.drainIn`). */
  drainAt?: number
  /** What it runs in the play: each task's start, end, cores and memory (`tailFrom`). */
  runs?: [at: number, end: number, cores: number, memory: number][]
}

/**
 * When `tasks` end on `workers`, each placed as soon as its dependencies
 * end, longest tail first, on the worker it fits with fewest cores free:
 * the orchestrator's own rule (`assign`). Infinity when one never fits.
 */
export function simulate(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  how: Strategy = DEFAULT_STRATEGY,
): number {
  return play(tasks, workers, how).end
}

/** What a worker runs in a play: each task's start, end, cores and memory; one running from -Infinity. */
type Ran = readonly (readonly [at: number, end: number, cores: number, memory: number])[]

/** `simulate`, with when each worker is first given a task. */
export function play(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  how: Strategy,
  // Played no further: past it the rest ends no sooner than its longest
  // chain from there.
  horizon = Infinity,
  // Given, a worker is started only when a ready task needs it: none
  // started or running has room for it before its latest start (this
  // less its chain), so a task with slack waits for room the run pays
  // for anyway, and the critical path never waits.
  deadline?: number,
  // Read for its wakes only: it ends once no dormant one is left to start.
  wakesOnly = false,
): {
  end: number
  /** It stopped at `horizon` with work left. */
  cut?: boolean
  first: Map<string, number>
  ends: Map<string | undefined, number>
  free: () => Map<string, number>
  given: () => Map<string, readonly string[]>
  /** The dormant workers it started (`deadline`), in order. */
  wakes: readonly Wake[]
  /** Core-ms its workers were held, each from its ask to its last task's end (`Ideal`). */
  held: () => number
  /** What each worker runs in it (`Ran`). */
  ran: () => Map<string, Ran>
} {
  // A dependency running now ends when it does; one ended or a hit, now.
  const runningIds = new Set<string>()
  for (const w of workers) for (const r of w.running) if (r.id !== undefined) runningIds.add(r.id)
  const { byId, after, afterAt, indexOf, waitedAt, tailOf, tailAt, riskAt, blindAt, kinds } =
    shapeOf(tasks, runningIds)
  // By place, not id: maps keyed by id were a 5000-task play's most time.
  const waits = waitedAt.slice()
  // Econ plays keep room for tasks about to be ready (`holdFor`): each
  // task's dependencies not started yet, and when the last started ends.
  const unstarted = deadline === undefined ? undefined : waitedAt.slice()
  const readyAt = deadline === undefined ? undefined : new Float64Array(tasks.length)
  const coming = new Set<number>()
  if (unstarted !== undefined)
    for (const w of workers)
      for (const r of w.running)
        for (const d of (r.id === undefined ? undefined : after.get(r.id)) ?? []) {
          readyAt![d] = Math.max(readyAt![d]!, leftMs(r.endsIn))
          if (--unstarted[d]! === 0) coming.add(d)
        }
  const slots: Slot[] = workers.map((w) => ({
    id: w.id,
    cores: w.cores,
    memory: w.memory,
    platform: w.platform,
    at: w.dormant === true ? Infinity : w.at,
    ...(w.dormant === true ? { dormant: true } : {}),
    ...(w.drainIn === undefined ? {} : { drainAt: w.drainIn }),
    warm: w.at,
    endsAt: [],
    used: { cores: [...(w.serving?.values() ?? [])].reduce((a, b) => a + b, 0), memory: 0 },
    running: 0,
    serving: new Set(w.serving?.keys()),
  }))
  // Ends to come: [at, slot, cores, memory, task or undefined].
  const ends = new Ends()
  workers.forEach((w, i) => {
    const s = slots[i]!
    for (const r of w.running) {
      s.used.cores += r.cores
      s.used.memory += r.memory
      s.running++
      ends.push(leftMs(r.endsIn), s, r.cores, r.memory, -1, r.id)
      s.endsAt.push([leftMs(r.endsIn), r.cores, r.memory])
      s.free = Math.max(s.free ?? 0, leftMs(r.endsIn))
      ;(s.runs ??= []).push([-Infinity, leftMs(r.endsIn), r.cores, r.memory])
    }
  })
  // Ready tasks, ordered again only once one joins (`graphene`: or
  // leaves): each step sorted every ready task, and a run of 9000 spent
  // its orchestrator planning.
  const ready = new Ready(tasks, kinds)
  let joining = tasks.filter((_, i) => waits[i] === 0)
  let readyCount = joining.length
  const spent = new Set<string>()
  const kept: Kept[] = []
  // Proved to fail, as `assign` would skip it: yielded to it, each ask was
  // most of a plan of 3,800 tasks.
  const proved: Proof = {
    one: (place) =>
      unstarted !== undefined &&
      failsAlike(kept, tasks[place]!, tailAt(place), tasks[place]!.ms ?? UNKNOWN_MS),
    all: (span) => unstarted !== undefined && allFailAlike(kept, span),
    rank: tailAt,
  }
  const bounds: Bounds = { done: false, open: true, free: 0, cores: 0, memory: 0 }
  // Ready tasks by what they need: no ready task needs less than the
  // least of these, and a pass ends once no slot takes that.
  const needs = new Map<string, { cores: number; memory: number; n: number }>()
  // Their least, read again only once a kind on it leaves: each step read
  // every kind, and 9000 kinds made it quadratic.
  let floor: { cores: number; memory: number } | undefined
  const count = (t: PlanTask, by: number): void => {
    const k = ready.kindOf(t.id)
    const e = needs.get(k)
    if (e === undefined) {
      needs.set(k, { cores: t.cores, memory: t.memory, n: by })
      if (floor !== undefined)
        floor = { cores: Math.min(floor.cores, t.cores), memory: Math.min(floor.memory, t.memory) }
    } else if ((e.n += by) === 0) {
      needs.delete(k)
      if (floor !== undefined && (e.cores <= floor.cores || e.memory <= floor.memory))
        floor = undefined
    }
  }
  for (const t of joining) count(t, 1)
  const widest = Math.max(1, ...workers.map((w) => w.cores))
  let left = tasks.length
  let now = 0
  let last = Math.max(0, ends.last())
  // Core-ms of the tasks not yet given.
  const workLeft = new Map<string | undefined, number>()
  const spend = (t: PlanTask, by: number): void => {
    const w = by * t.cores * (t.ms ?? UNKNOWN_MS)
    workLeft.set(undefined, (workLeft.get(undefined) ?? 0) + w)
    if (t.platform !== undefined) workLeft.set(t.platform, (workLeft.get(t.platform) ?? 0) + w)
  }
  if (horizon < Infinity) for (const t of tasks) spend(t, 1)
  // When each platform's last task ends.
  const byPlatform = (): Map<string | undefined, number> => {
    const out = new Map<string | undefined, number>()
    for (const s of slots)
      if (s.last !== undefined) out.set(s.platform, Math.max(out.get(s.platform) ?? 0, s.last))
    return out
  }
  // The joined slots, read again once the next one joins.
  let joined: Slot[] = []
  let nextJoin = -Infinity
  // A task that filled a size waits for a bigger one still to join.
  const later = (above: { cores: number; memory: number }, platform?: string): boolean =>
    slots.some(
      (s) =>
        s.at > now &&
        (platform === undefined || s.platform === platform) &&
        (s.cores > above.cores || s.memory > above.memory),
    )
  let dormant = slots.filter((s) => s.dormant === true)
  // Each ask's rank and time, for the holds: only in econ plays.
  function* ranked(asks: Iterable<Ask>): Generator<Ask> {
    if (unstarted === undefined) return yield* asks
    for (const a of asks) {
      const t = byId.get(a.id)!
      yield { ...a, rank: tailOf(a.id), ms: t.ms ?? UNKNOWN_MS }
    }
  }
  const wakes: Wake[] = []
  const held = (): number => {
    let ms = 0
    for (const x of slots)
      if (x.free !== undefined && x.at < Infinity)
        ms += x.cores * Math.max(0, x.free - Math.max(0, x.at - x.warm))
    return ms
  }
  const ran = (): Map<string, Ran> =>
    new Map(slots.flatMap((x) => (x.runs === undefined ? [] : [[x.id, x.runs] as const])))
  /** Ready places whose chain runs through a task of no history, in rank order. */
  let blindQ: number[] = []
  let blindHead = 0
  /** `t`'s quarter-cores on `s`, at least one, at most all. */
  const lanesFor = (s: Slot, t: PlanTask): number =>
    Math.min(s.lanes!.length, Math.max(1, Math.ceil(t.cores * LANES - 1e-9)))
  /** `k` of `s`'s soonest-free lanes, busy from `from` until `until`. */
  const occupy = (s: Slot, k: number, from: number, until: number): void => {
    const lanes = s.lanes!
    k = Math.min(lanes.length, Math.max(1, k))
    for (let i = 0; i < k; i++)
      lanes[i] = Math.max(until, lanes[i]! > from ? lanes[i]! + until - from : until)
    lanes.sort((a, b) => a - b)
  }
  /**
   * Whether `x` may take `t`, as `assign` places: its platform, and
   * bigger than a size `t` filled while any worker of the run is.
   */
  const suits = (x: Slot, t: PlanTask): boolean => {
    if (t.platform !== undefined && x.platform !== t.platform) return false
    const a = t.above
    if (a === undefined || x.cores > a.cores || x.memory > a.memory) return true
    return !slots.some(
      (y) =>
        (t.platform === undefined || y.platform === t.platform) &&
        (y.cores > a.cores || y.memory > a.memory),
    )
  }
  /**
   * The dormant ones it started, in order, after those still joining
   * with nothing given: a task late before any joined took a new one
   * over one already asked.
   */
  const woken: Slot[] =
    deadline === undefined
      ? []
      : slots.filter((s) => s.dormant !== true && s.at > now && s.running === 0)
  for (const s of woken)
    s.lanes = Array.from({ length: Math.max(1, Math.round(s.cores * LANES)) }, () => s.at)
  /**
   * `t` given `s` at `at`, maybe past: a worker started at a task's
   * latest start had room since that task got ready, so later tasks at
   * theirs fill it back to then, as if it had started for the first as
   * soon as it could. Its end counts no sooner than now.
   */
  const giveAt = (t: PlanTask, s: Slot, at: number): void => {
    const place = indexOf.get(t.id)!
    const ms = msOn(t, s)
    const end = Math.max(now, at + ms)
    const cores = Math.min(t.cores, s.cores)
    const memory = Math.min(t.memory, s.memory)
    ready.take(t.id)
    readyCount--
    count(t, -1)
    s.first = Math.min(s.first ?? Infinity, at)
    ;(s.given ??= []).push(t.id)
    s.free = Math.max(s.free ?? 0, end)
    // Its whole need, not what this worker holds of it: a smaller one must have room for all.
    ;(s.runs ??= []).push([at, end, t.cores, t.memory])
    s.last = Math.max(s.last ?? 0, end)
    last = Math.max(last, end)
    s.used.cores += cores
    s.used.memory += memory
    s.running++
    s.endsAt.push([end, cores, memory])
    ends.push(end, s, cores, memory, place, undefined)
    occupy(s, lanesFor(s, t), at, at + ms)
    if (horizon < Infinity) spend(t, -1)
    for (const d of afterAt(place)) {
      readyAt![d] = Math.max(readyAt![d]!, end)
      if (--unstarted![d]! === 0) coming.add(d)
    }
  }
  /**
   * `t`, at its latest start: into the room of a worker the play
   * started, back to when that one's first task got ready; else a
   * dormant one starts for it. Whether it gave or started one.
   */
  const late = (t: PlanTask, latest: number, start = true): boolean => {
    const r = readyAt![indexOf.get(t.id)!]!
    let into: Slot | undefined
    let intoAt = Infinity
    for (const x of woken) {
      if (!suits(x, t)) continue
      const at = Math.max(r, x.lanes![lanesFor(x, t) - 1]!)
      if (at < intoAt) {
        into = x
        intoAt = at
      }
    }
    // Room now, or as the worker it would take joins: no new one.
    if (!start)
      return (
        into !== undefined &&
        intoAt <= Math.max(now, into.at) + 1e-6 &&
        (giveAt(t, into, intoAt), true)
      )
    // A new one only when it gives sooner than the room the play already
    // pays for: past its latest start, a task of no history woke one
    // each, at 7.6 times the least worker time.
    const s = dormant.find((x) => suits(x, t))
    const fresh = s === undefined ? Infinity : Math.max(s.warm, r)
    if (into === undefined || intoAt > Math.max(latest, now) + 1e-6) {
      // None to start: assign gives it room as it frees, not a lane of
      // the future.
      if (s === undefined) return false
      if (into !== undefined && intoAt <= fresh) return (giveAt(t, into, intoAt), true)
      s.dormant = false
      s.at = Math.max(now, s.warm)
      dormant = dormant.filter((x) => x !== s)
      s.lanes = Array.from({ length: Math.max(1, Math.round(s.cores * LANES)) }, () => fresh)
      woken.push(s)
      wakes.push({ id: s.id, readyAt: fresh })
      into = s
      intoAt = fresh
    }
    giveAt(t, into, intoAt)
    return true
  }
  /**
   * Each ready task at its latest start (`deadline` less its chain):
   * into the room of a worker the play started, back to when that one's
   * first task got ready; else a dormant one starts for it. Ranked by
   * chain, the waiting at their latest start come first, so a step reads
   * only those: each waiting one checked against each worker at each
   * step planned 9000 in a minute. Whether it gave or
   * started one now.
   */
  const wake = (by: number): boolean => {
    let changed = false
    // Chains through a task of no history, each as it gets ready; one
    // finding no worker leaves the rest, in rank order, for later.
    for (; blindHead < blindQ.length; blindHead++) {
      const t = tasks[blindQ[blindHead]!]!
      if (!ready.live(t.id)) continue
      if (!late(t, now, false)) break
      changed = true
    }
    // With no worker left to start, a task takes only room that frees by
    // its latest start, never past `by`: with none such, none is read.
    const room = dormant.length > 0 || woken.some((x) => x.lanes![0]! <= Math.max(by, now) + 1e-6)
    // Unset, not Infinity: a whole worker is asked as Infinity cores.
    let failed: number | undefined
    for (const t of room ? ready.from() : []) {
      if (by - tailOf(t.id) * CHAIN_TIMES > now + 1e-6) break
      const latest = by - riskAt(indexOf.get(t.id)!) * CHAIN_TIMES
      if (latest > now + 1e-6) continue
      // Each read here asks for room by now: one of any platform, ready by
      // now, that found none in so many lanes and no worker to start leaves
      // none for as many.
      const k = Math.max(1, Math.ceil(t.cores * LANES - 1e-9))
      const plain = t.platform === undefined && t.above === undefined
      if (plain && failed !== undefined && k >= failed) continue
      if (late(t, latest)) changed = true
      else if (plain && readyAt![indexOf.get(t.id)!]! <= now + 1e-6) {
        failed = k
        if (k === 1) break
      }
    }
    nextJoin = -Infinity
    return changed
  }
  for (;;) {
    if (joining.length > 0 || ready.stale) {
      // By the longest chain, those still ready keep their order and the
      // joining are merged in: sorted again with each join, a 9000-task
      // tree sorted 17 million a plan.
      const merge = how.order === 'critical-path' && !ready.stale
      const order = ordered(
        (merge ? joining : [...ready.live(), ...joining]).map((t) => t.id),
        how.order,
        tailOf,
        (id) => byId.get(id)!,
        widest,
      )
      if (merge) ready.add(order, tailOf)
      else ready.reset(order)
      if (deadline !== undefined) {
        for (const id of order) {
          const i = indexOf.get(id)!
          if (blindAt(i)) blindQ.push(i)
        }
        if (!merge) {
          blindQ = [...new Set(blindQ.slice(blindHead))]
          blindHead = 0
        }
      }
      joining = []
    }
    if (now >= nextJoin) {
      joined = slots.filter((s) => s.at <= now && !((s.drainAt ?? Infinity) <= now))
      nextJoin = Infinity
      for (const s of slots) {
        if (s.at > now) nextJoin = Math.min(nextJoin, s.at)
        if (s.drainAt !== undefined && s.drainAt > now) nextJoin = Math.min(nextJoin, s.drainAt)
      }
    }
    // With none ready nothing is given: a third of a sim's steps.
    // Nor with no worker room for the least ready: holds keep room only
    // from the asks, which `assign` then reads none of. Each step held for
    // a worker's count of tasks on full workers.
    if (
      unstarted !== undefined &&
      readyCount > 0 &&
      joined.some((s) => fits(s, (floor ??= floorOf(needs.values()))))
    ) {
      const soon: Soon[] = []
      for (const d of coming) {
        if (waits[d] === 0) {
          coming.delete(d)
          continue
        }
        const t = tasks[d]!
        soon.push({ need: t, at: readyAt![d]! - now, rank: tailAt(d), ms: t.ms ?? UNKNOWN_MS })
      }
      soon.sort((a, b) => b.rank - a.rank)
      for (const s of joined)
        s.ends = s.endsAt.filter((e) => e[0] > now).map(([at, c, m]) => [at - now, c, m] as const)
      // A play read only for its wakes holds for the first few: for four
      // a worker, the plan of 3,800 tasks spent 1.4 s of its 1.5 there.
      // With eight, 0.4 s, the same workers woken on the lab's graphs,
      // its run 2% sooner. None woke a worker for each
      // task a filler blocked: 15 asked where 3 do.
      holdFor(joined, soon.slice(0, wakesOnly ? 8 : 4 * joined.length + 8))
    }
    const to =
      readyCount === 0
        ? NONE
        : assign(ranked(ready.asks(spent, bounds, needs.size, proved)), joined, later, how.place, {
            floor: (floor ??= floorOf(needs.values())),
            kinds: needs.size,
            spent,
            kept,
            bounds,
          })
    // `graphene` ranks against the longest chain still ready.
    if (to.size > 0 && how.order === 'graphene') ready.stale = true
    for (const [id, best] of to) {
      const t = byId.get(id)!
      ready.take(id)
      readyCount--
      count(t, -1)
      best.first ??= now
      ;(best.given ??= []).push(id)
      best.free = Math.max(best.free ?? 0, now + msOn(t, best))
      if (best.lanes !== undefined) occupy(best, lanesFor(best, t), now, now + msOn(t, best))
      if (unstarted !== undefined)
        for (const d of afterAt(indexOf.get(id)!)) {
          readyAt![d] = Math.max(readyAt![d]!, now + msOn(t, best))
          if (--unstarted[d]! === 0) coming.add(d)
        }
      if (deadline !== undefined)
        best.endsAt.push([
          now + msOn(t, best),
          Math.min(t.cores, best.cores),
          Math.min(t.memory, best.memory),
        ])
      const end = now + msOn(t, best)
      ends.push(
        end,
        best,
        Math.min(t.cores, best.cores),
        Math.min(t.memory, best.memory),
        indexOf.get(id)!,
        undefined,
      )
      last = Math.max(last, end)
      ;(best.runs ??= []).push([now, end, t.cores, t.memory])
      best.last = Math.max(best.last ?? 0, end)
      if (horizon < Infinity) spend(t, -1)
    }
    const first = (): Map<string, number> =>
      new Map(slots.flatMap((s) => (s.first === undefined ? [] : [[s.id, s.first] as const])))
    const free = (): Map<string, number> =>
      new Map(slots.flatMap((s) => (s.free === undefined ? [] : [[s.id, s.free] as const])))
    const given = (): Map<string, readonly string[]> =>
      new Map(slots.flatMap((s) => (s.given === undefined ? [] : [[s.id, s.given] as const])))
    if (deadline !== undefined && readyCount > 0 && wake(deadline)) {
      nextJoin = -Infinity
      continue
    }
    if (wakesOnly && dormant.length === 0)
      return {
        end: Infinity,
        cut: true,
        first: first(),
        ends: byPlatform(),
        free,
        given,
        wakes,
        held,
        ran,
      }
    if (left === 0 && readyCount === 0)
      return { end: last, first: first(), ends: byPlatform(), free, given, wakes, held, ran }
    // The next moment anything changes: a task ends or a worker joins.
    let next = ends.next()
    for (const s of slots) {
      if (s.at > now) next = Math.min(next, s.at)
      if (s.drainAt !== undefined && s.drainAt > now) next = Math.min(next, s.drainAt)
    }
    // The first waiting task's latest start: a worker may start for it then.
    if (deadline !== undefined && dormant.length > 0 && readyCount > 0) {
      const h = ready.first()
      // Read from its chain first, as `wake` reads it: past that, by its
      // risk alone, a guessed chain whose risk was past and chain was not
      // started no worker, and the play never ended.
      if (h !== undefined) {
        const chain = deadline - tailOf(h.id) * CHAIN_TIMES
        const latest = deadline - riskAt(indexOf.get(h.id)!) * CHAIN_TIMES
        if (chain > now + 1e-6) next = Math.min(next, chain)
        else if (latest > now + 1e-6) next = Math.min(next, latest)
      }
    }
    if (next >= horizon && next < Infinity) {
      // No sooner than its longest chain, nor than its work spread on
      // every core it has: the workers it asks later are the next plan's.
      // Of each platform on its own workers, and all of it on all.
      const work = new Map(workLeft)
      const cores = new Map<string | undefined, number>()
      for (const s of slots) {
        cores.set(undefined, (cores.get(undefined) ?? 0) + s.cores)
        if (s.platform !== undefined) cores.set(s.platform, (cores.get(s.platform) ?? 0) + s.cores)
      }
      // A running task's rest on its own platform too: counted on all
      // alone, a Mac fewer read the Linux end later.
      for (const e of ends.all()) {
        const w = e.cores * (e.at - now)
        work.set(undefined, (work.get(undefined) ?? 0) + w)
        const p = e.s.platform
        if (p !== undefined) work.set(p, (work.get(p) ?? 0) + w)
      }
      let end = last
      for (const [p, w] of work) end = Math.max(end, now + w / Math.max(cores.get(p) ?? 0, 1e-9))
      // A ready task had no room this step: none before the next change.
      // Counted from now, a 4-core one behind a 2-core task to 122 s read
      // as ending in time, and no worker was asked for it.
      for (const t of ready.live()) end = Math.max(end, next + tailOf(t.id))
      for (const e of ends.all())
        for (const d of (e.place >= 0 ? afterAt(e.place) : after.get(e.id!)) ?? [])
          end = Math.max(end, e.at + tailAt(d))
      return { end, cut: true, first: first(), ends: byPlatform(), free, given, wakes, held, ran }
    }
    if (next === Infinity)
      return {
        end: left === 0 ? last : Infinity,
        first: first(),
        ends: byPlatform(),
        free,
        given,
        wakes,
        held,
        ran,
      }
    now = next
    while (ends.next() <= now) {
      const { s, cores, memory, place, id } = ends.pop()
      s.used.cores -= cores
      s.used.memory -= memory
      s.running--
      if (place >= 0) left--
      else if (id === undefined) continue
      for (const d of (place >= 0 ? afterAt(place) : after.get(id!)) ?? []) {
        if (--waits[d]! === 0) {
          joining.push(tasks[d]!)
          readyCount++
          count(tasks[d]!, 1)
        }
      }
    }
  }
}

const NONE: ReadonlyMap<string, Slot> = new Map()

interface End {
  at: number
  seq: number
  s: Slot
  cores: number
  memory: number
  /** The task's place in the play, or -1 for one running when it began (`id`). */
  place: number
  id: string | undefined
}

/**
 * A play's ends to come, soonest first, ties in the order given: a scan
 * of every running task at each step was most of a 20 000-task play.
 */
class Ends {
  private readonly heap: End[] = []
  private seq = 0
  private readonly before = (a: End, b: End): boolean =>
    a.at < b.at || (a.at === b.at && a.seq < b.seq)
  push(
    at: number,
    s: Slot,
    cores: number,
    memory: number,
    place: number,
    id: string | undefined,
  ): void {
    const h = this.heap
    const e: End = { at, seq: this.seq++, s, cores, memory, place, id }
    let i = h.length
    h.push(e)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.before(e, h[p]!)) break
      h[i] = h[p]!
      i = p
    }
    h[i] = e
  }
  next(): number {
    return this.heap[0]?.at ?? Infinity
  }
  all(): readonly End[] {
    return this.heap
  }
  last(): number {
    let most = 0
    for (const e of this.heap) most = Math.max(most, e.at)
    return most
  }
  pop(): End {
    const h = this.heap
    const top = h[0]!
    const e = h.pop()!
    if (h.length > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= h.length) break
        const c = l + 1 < h.length && this.before(h[l + 1]!, h[l]!) ? l + 1 : l
        if (!this.before(h[c]!, e)) break
        h[i] = h[c]!
        i = c
      }
      h[i] = e
    }
    return top
  }
}

/** What `play` reads of `tasks` alone, for each play of one plan. */
interface Shape {
  readonly byId: { get(id: string): PlanTask | undefined }
  /** Each running task's dependants, by their place in the tasks. */
  readonly after: ReadonlyMap<string, readonly number[]>
  /** Each task's dependants by its place, and its place by id: a lookup by id at each end was most of a play. */
  readonly afterAt: (place: number) => Int32Array
  readonly indexOf: { get(id: string): number | undefined }
  /** How many dependencies each task, by its place, waits on before the play begins. */
  readonly waitedAt: Int32Array
  readonly tailOf: (id: string) => number
  readonly tailAt: (place: number) => number
  /** `tailAt`, each task of no history counted `RISK` times its guess: how soon its chain must start. */
  readonly riskAt: (place: number) => number
  /** Whether its chain runs through a task of no history: no slack it can prove. */
  readonly blindAt: (place: number) => boolean
  readonly kinds: Kinds
}

/**
 * `tasks`' shape, made once while what runs stays the same: a plan plays
 * them 20 to 40 times, and each play made it again, its tails and kinds
 * too.
 */
function shapeOf(tasks: readonly PlanTask[], running: ReadonlySet<string>): Shape {
  const runs = [...running].sort().join('\0')
  const had = shapes.get(tasks)
  if (had !== undefined && had.runs === runs) return had.shape
  // Of a running task only, by id: one in the work is by its place.
  const after = new Map<string, number[]>()
  const waitedAt = new Int32Array(tasks.length)
  const first = tasks[0]?.depsN
  const num =
    first !== undefined && tasks.every((t) => t.depsN !== undefined)
      ? numberedOf.get(first)
      : undefined
  let edges = 0
  for (let i = 0; i < tasks.length; i++) edges += tasks[i]!.deps.length
  // Each dependency's place in the work, -1 when not in it.
  const depAt = new Int32Array(edges)
  let indexOf: { get(id: string): number | undefined }
  if (num !== undefined) {
    // By the run's numbers, not ids: a map of a million ids, made and
    // read at each plan, was most of its time.
    const place = new Int32Array(num.ids.length).fill(-1)
    for (let i = 0; i < tasks.length; i++) place[tasks[i]!.n!] = i
    // Indexed: iterators over a million tasks' deps were a third of the shape.
    for (let e = 0, i = 0; i < tasks.length; i++) {
      const ds = tasks[i]!.depsN!
      for (let k = 0; k < ds.length; k++) depAt[e++] = place[ds[k]!]!
    }
    indexOf = {
      get: (id) => {
        const n = num.of.get(id)?.n
        const j = n === undefined ? -1 : place[n]!
        return j < 0 ? undefined : j
      },
    }
  } else {
    // One map by id, the rest by place: a map of each by id made a
    // 10 000-task plan's shape a third of its time.
    const of = new Map<string, number>()
    for (let i = 0; i < tasks.length; i++) of.set(tasks[i]!.id, i)
    let e = 0
    for (const t of tasks) for (const d of t.deps) depAt[e++] = of.get(d) ?? -1
    indexOf = of
  }
  // Each task's dependants in one array, by place: an array each, pushed
  // to, was most of a million-task shape.
  const start = new Int32Array(tasks.length + 1)
  for (let e = 0, i = 0; i < tasks.length; i++) {
    const deps = tasks[i]!.deps
    let n = 0
    for (let k = 0; k < deps.length; k++, e++) {
      const j = depAt[e]!
      if (j >= 0) {
        start[j + 1]!++
        n++
      } else if (running.has(deps[k]!)) {
        n++
        const at = after.get(deps[k]!)
        if (at === undefined) after.set(deps[k]!, [i])
        else at.push(i)
      }
    }
    waitedAt[i] = n
  }
  for (let i = 0; i < tasks.length; i++) start[i + 1]! += start[i]!
  const list = new Int32Array(start[tasks.length]!)
  const fill = start.slice(0, tasks.length)
  for (let e = 0, i = 0; i < tasks.length; i++)
    for (let k = tasks[i]!.deps.length; k > 0; k--, e++) {
      const j = depAt[e]!
      if (j >= 0) list[fill[j]!++] = i
    }
  const afterAt = (i: number): Int32Array => list.subarray(start[i]!, start[i + 1]!)
  const tail = new Float64Array(tasks.length).fill(-1)
  const tailAt = (i: number): number => {
    if (tail[i]! >= 0) return tail[i]!
    let most = 0
    for (let k = start[i]!; k < start[i + 1]!; k++) most = Math.max(most, tailAt(list[k]!))
    return (tail[i] = most + (tasks[i]!.ms ?? UNKNOWN_MS))
  }
  const tailOf = (id: string): number => tailAt(indexOf.get(id)!)
  // The same with each task history has no time for counted RISK times its guess.
  const risk = new Float64Array(tasks.length).fill(-1)
  const riskAt = (i: number): number => {
    if (risk[i]! >= 0) return risk[i]!
    let most = 0
    for (let k = start[i]!; k < start[i + 1]!; k++) most = Math.max(most, riskAt(list[k]!))
    return (risk[i] = most + (tasks[i]!.ms ?? UNKNOWN_MS * RISK))
  }
  const blind = new Int8Array(tasks.length).fill(-1)
  const blindAt = (i: number): boolean => {
    if (blind[i]! >= 0) return blind[i] === 1
    let any = tasks[i]!.ms === undefined
    for (let k = start[i]!; !any && k < start[i + 1]!; k++) any = blindAt(list[k]!)
    blind[i] = any ? 1 : 0
    return any
  }
  const byId = { get: (id: string) => tasks[indexOf.get(id)!] }
  const shape = {
    byId,
    after,
    afterAt,
    indexOf,
    waitedAt,
    tailOf,
    tailAt,
    riskAt,
    blindAt,
    kinds: { at: indexOf, kindAt: lazyKinds(tasks) },
  }
  shapes.set(tasks, { runs, shape })
  return shape
}
const shapes = new WeakMap<readonly PlanTask[], { runs: string; shape: Shape }>()

/** Each task's place in `tasks` and its kind (`kindOf`). */
interface Kinds {
  readonly at: { get(id: string): number | undefined }
  readonly kindAt: (place: number) => string
}

/**
 * Each task's kind, made as a play first reads it: made for every task,
 * a million float-to-string keys were a fifth of a plan, and a play
 * windowed to two warm-ups reads few of them.
 */
function lazyKinds(tasks: readonly PlanTask[]): (place: number) => string {
  // Packed: an array of holes filled by place read as a dictionary, most
  // of a 3,800-task plan of varied needs. No kind is empty.
  const kinds = Array.from<string>({ length: tasks.length }).fill('')
  return (i) => kinds[i] || (kinds[i] = kindOf(tasks[i]!))
}

function kindsOf(tasks: readonly PlanTask[]): Kinds {
  return { at: new Map(tasks.map((t, i) => [t.id, i])), kindAt: lazyKinds(tasks) }
}

/**
 * No play of `tasks` ends sooner: each chain of them in a row, from when
 * the running tasks it waits on end, and each running task's end.
 */
export function chainMs(tasks: readonly PlanTask[], workers: readonly PlanWorker[]): number {
  const runningIds = new Set<string>()
  const endsAt = new Map<string, number>()
  for (const w of workers)
    for (const r of w.running)
      if (r.id !== undefined) {
        runningIds.add(r.id)
        endsAt.set(r.id, Math.max(endsAt.get(r.id) ?? 0, leftMs(r.endsIn)))
      }
  const { tailAt, after } = shapeOf(tasks, runningIds)
  let most = 0
  for (const w of workers) for (const r of w.running) most = Math.max(most, leftMs(r.endsIn))
  // From the running tasks' dependants: each task's deps read by id was
  // most of a million-task plan's bound.
  const from = new Float64Array(tasks.length)
  for (const [id, ds] of after)
    for (const i of ds) from[i] = Math.max(from[i]!, endsAt.get(id) ?? 0)
  for (let i = 0; i < tasks.length; i++) most = Math.max(most, from[i]! + tailAt(i))
  return most
}

/** Two workers a play cannot tell apart, but by their place. */
const twins = (a: PlanWorker, b: PlanWorker): boolean =>
  a.cores === b.cores && a.memory === b.memory && a.platform === b.platform && a.at === b.at

type Played = ReturnType<typeof play>

/**
 * `kept` less each of `added` (its last ones, in the order the run would
 * start them) the run ends as soon without, tried last first. Sizes come in
 * turns, so a prefix holds ones it ends as soon without: a second Mac the
 * plan needed came after a second Linux worker it did not, and the run
 * cancelled that one unjoined. Dropped when the end moves no
 * later and its platform's moves no further than the margin, or still ends
 * two warm-ups before the run: room for runners the CI queues. To the run's
 * end alone, a 110 s guess of an unmeasured chain cut every other platform
 * to it; to its platform's alone, 4 Macs started for work 2 ended 40 s
 * before the Linux work. The live plan and the footer's advice both trim by it.
 */
export function dropSpare(
  added: readonly PlanWorker[],
  kept: readonly PlanWorker[],
  before: Played,
  run: (ws: readonly PlanWorker[]) => Played,
): { kept: PlanWorker[]; before: Played } {
  let out = [...kept]
  for (let i = added.length - 1, dropped = false; i >= 0; i--) {
    const w = added[i]!
    // Its twin after it stayed, and nothing moved since: without this
    // one the play is that one's again, so it stays too. Each was a
    // play of the whole run.
    if (i < added.length - 1 && !dropped && twins(w, added[i + 1]!)) continue
    const without = out.filter((k) => k !== w)
    // Given no task in a whole play, the play without it is the same.
    if (!before.first.has(w.id) && before.cut !== true) {
      out = without
      dropped = true
      continue
    }
    const after = run(without)
    const ends = after.ends.get(w.platform) ?? 0
    dropped =
      after.end <= before.end &&
      (ends <= (before.ends.get(w.platform) ?? 0) + MARGIN_MS ||
        ends <= before.end - Math.max(MARGIN_MS, 2 * w.at))
    if (dropped) {
      out = without
      before = after
    }
  }
  return { kept: out, before }
}

/** A worker of `s` that joins `at`. */
export function fresh(
  s: { cpu: number; memory: number; platform?: string | undefined; size?: string | undefined },
  id: string,
  at: number,
): PlanWorker {
  return {
    id,
    cores: s.cpu,
    memory: s.memory,
    platform: s.platform,
    ...(s.size === undefined ? {} : { size: s.size }),
    at,
    running: [],
    idle: false,
  }
}

/**
 * `need`, kept to the sizes with room for all of it when some sizes have
 * none: alone on an empty worker any task fits, so a 4-core task ran on
 * 2 cores at half speed while 8-core sizes went unasked, 59% late on
 * graphs of 2- to 16-core sizes, and a 25 GB one was
 * advised a 16 GB worker. Bigger is more cores when every size with
 * the cores has the memory, else more memory. Only `platform`'s sizes
 * count: against all, a 3.6-core lint on 4-core Linux sizes asked for a
 * bigger one, as a 4-core ARM size fit it, and was packed onto no new
 * worker.
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

/**
 * When `small`, joining `small.at` after its ask, would take the rest of
 * what a worker of `cores` runs (`runs`) for least CPU held, its warm-up
 * counted: from a start on, the tasks
 * starting then or later fit on `small` side by side, and the big one
 * leaves once those started before end. Undefined when none holds less.
 */
export function tailFrom(runs: Ran, cores: number, small: PlanWorker): number | undefined {
  const byStart = [...runs].sort((x, y) => y[0] - x[0])
  const end = byStart.reduce((most, r) => Math.max(most, r[1]), 0)
  const kept = end * cores
  let best: number | undefined
  let least = kept
  for (let i = 0; i < byStart.length; i++) {
    const from = byStart[i]![0]
    if (i + 1 < byStart.length && byStart[i + 1]![0] === from) continue
    if (from < small.at) break
    const events = byStart
      .slice(0, i + 1)
      .flatMap(([at, until, c, m]) => [[at, c, m] as const, [until, -c, -m] as const])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    let used = 0
    let memory = 0
    let fits = true
    for (const [, c, m] of events) {
      used += c
      memory += m
      if (used > small.cores + 1e-9 || memory > small.memory) fits = false
    }
    // More tasks only need more room.
    if (!fits) break
    const leaves = byStart.slice(i + 1).reduce((most, r) => Math.max(most, r[1]), 0)
    // The small one is held from its ask, a warm-up before it joins: a
    // warm-up is CPU paid for as much as a task's.
    const held = cores * Math.max(leaves, from) + small.cores * (end - from + small.at)
    if (held < least) {
      least = held
      best = from
    }
  }
  return best
}

/**
 * When each of `asleep` starts: the `wakes` within a warm-up of the first
 * of them, of one platform, as fewer, bigger workers with all their cores
 * and no less than the biggest of them, each from the first's time, when
 * that takes fewer; the rest as they woke.
 */
export function together(
  wakes: readonly Wake[],
  asleep: readonly PlanWorker[],
): Map<string, number> {
  const byId = new Map(asleep.map((a) => [a.id, a]))
  const sorted = [...wakes].sort((x, y) => x.readyAt - y.readyAt)
  const unwoken = new Set(asleep.map((a) => a.id))
  for (const w of sorted) unwoken.delete(w.id)
  const out = new Map<string, number>()
  for (let i = 0; i < sorted.length;) {
    const from = sorted[i]!.readyAt
    const until = from + byId.get(sorted[i]!.id)!.at
    const group = new Map<string | undefined, PlanWorker[]>()
    const woke = new Map<string, number>()
    for (; i < sorted.length && sorted[i]!.readyAt <= until + 1e-6; i++) {
      const a = byId.get(sorted[i]!.id)!
      woke.set(a.id, sorted[i]!.readyAt)
      group.set(a.platform, [...(group.get(a.platform) ?? []), a])
    }
    for (const [platform, of] of group) {
      let cores = 0
      let most = 0
      let memory = 0
      for (const a of of) {
        cores += a.cores
        most = Math.max(most, a.cores)
        memory = Math.max(memory, a.memory)
      }
      const pool = [
        ...of,
        ...[...unwoken].map((id) => byId.get(id)!).filter((a) => a.platform === platform),
      ].sort((x, y) => x.cores - y.cores || x.memory - y.memory)
      const taken = new Set<PlanWorker>()
      while (cores > 1e-9) {
        const left = pool.filter((x) => !taken.has(x))
        const pick =
          left.find((x) => x.cores >= Math.max(cores, most) - 1e-9 && x.memory >= memory) ??
          left[left.length - 1]
        if (pick === undefined) break
        taken.add(pick)
        cores -= pick.cores
      }
      // No fewer: each as it woke, none sooner than its task needs it.
      if (taken.size >= of.length) {
        for (const a of of) out.set(a.id, woke.get(a.id)!)
        continue
      }
      for (const a of taken) {
        out.set(a.id, from)
        unwoken.delete(a.id)
      }
      for (const a of of) if (!taken.has(a)) unwoken.add(a.id)
    }
  }
  return out
}

/** The most kinds `Ready.asks` jumps across; past it, it jumps across the cores' classes. */
const MAX_JUMP_KINDS = 32
/** Classes a doubling of cores spans (`classOf`). */
const CLASSES = 4
/** The class of a task that names a platform or a size to beat: never passed whole. */
const ODD = -Infinity
/** A task's cores' class: about 2^(c / CLASSES) to 2^((c + 1) / CLASSES), its span kept as joined. */
const classOf = (t: PlanTask): number =>
  t.platform !== undefined || t.above !== undefined
    ? ODD
    : Math.floor(Math.log2(Math.max(t.cores, 1e-6)) * CLASSES)

/** Ready tasks `assign` would skip (`Kept`): one, or a `Span` of them all. */
interface Proof {
  one(place: number): boolean
  all(span: Span): boolean
  rank(place: number): number
}

/** Ready tasks a `Span` sums (`Ready.leap`). */
const BLOCK_BITS = 4
const BLOCK = 1 << BLOCK_BITS

/**
 * Ready tasks in the order `ordered` gave, by kind (`kindOf`): `assign`
 * reads them in that order, a kind it found spent skipped in one jump,
 * where it read every ready task each step. A task is its
 * place in the play's tasks, and its rank (`before`) is fixed once it
 * joins: rebuilt with each join, a 9000-task tree hashed every ready
 * task 17 million times a plan.
 */
class Ready {
  private readonly at: Kinds['at']
  private readonly kindAt: (place: number) => string
  private readonly taken: Uint8Array
  /** The rank: the lower `primary` first, then the lower `seq`. */
  private readonly primary: Float64Array
  private readonly seq: Float64Array
  private next = 0
  /** In rank order; taken ones linger until the next join. */
  private order: number[] = []
  private kinds = new Map<string, number[]>()
  /**
   * Ready tasks by their cores' class (`classOf`), in rank order, each
   * class's first not taken and the most memory one asked: what `asks`
   * jumps across when kinds are too many.
   */
  private classes = new Map<number, number[]>()
  private readonly classHead = new Map<number, number>()
  /** The fewest and most cores and the most memory a task of each class asked. */
  private readonly classSpan = new Map<number, [number, number, number]>()
  /** Each kind's first task not taken. */
  private readonly head = new Map<string, number>()
  /** No task before this place in `order` is left: a pass began at 0 and read 9000 taken ones. */
  private lo = 0
  /** Order it again before the next step. */
  stale = false
  /** Joins so far: a queue's `spans` hold until the next. */
  private joins = 0
  private readonly spans = new WeakMap<readonly number[], { at: number; spans: Span[] }>()
  /** Taken ones still in `order`: past its live ones, it is read again without them. */
  private dead = 0
  /** Each kind's tasks not taken: a kind with none leaves `kinds`. */
  private readonly liveOf = new Map<string, number>()

  constructor(
    private readonly tasks: readonly PlanTask[],
    kinds: Kinds = kindsOf(tasks),
  ) {
    this.at = kinds.at
    this.kindAt = kinds.kindAt
    this.taken = new Uint8Array(tasks.length)
    this.primary = new Float64Array(tasks.length)
    this.seq = new Float64Array(tasks.length)
  }

  kindOf(id: string): string {
    return this.kindAt(this.at.get(id)!)
  }

  take(id: string): void {
    const i = this.at.get(id)!
    this.taken[i] = 1
    this.dead++
    const k = this.kindAt(i)
    const n = this.liveOf.get(k)! - 1
    if (n > 0) this.liveOf.set(k, n)
    else {
      this.liveOf.delete(k)
      this.kinds.delete(k)
      this.head.delete(k)
    }
  }

  /** Whether `id` was added and not taken. */
  live(id: string): boolean
  live(): PlanTask[]
  live(id?: string): PlanTask[] | boolean {
    if (id !== undefined) return this.taken[this.at.get(id)!] !== 1
    return this.order.flatMap((i) => (this.taken[i] === 1 ? [] : [this.tasks[i]!]))
  }

  /** Those not taken, by rank. */
  *from(): Generator<PlanTask> {
    for (let i = this.lo; i < this.order.length; i++)
      if (this.taken[this.order[i]!] !== 1) yield this.tasks[this.order[i]!]!
  }

  /** The first not taken, by rank. */
  first(): PlanTask | undefined {
    while (this.lo < this.order.length && this.taken[this.order[this.lo]!] === 1) this.lo++
    const i = this.order[this.lo]
    return i === undefined ? undefined : this.tasks[i]
  }

  /** Joins `ids`, longest tail first, behind every ready task of a tail as long. */
  add(ids: readonly string[], tail: (id: string) => number): void {
    const batch = ids.map((id) => {
      const i = this.at.get(id)!
      this.primary[i] = -tail(id)
      this.seq[i] = this.next++
      return i
    })
    this.join(batch)
  }

  /** Ready tasks are `ids` alone, in that order. */
  reset(ids: readonly string[]): void {
    this.order = []
    this.kinds = new Map()
    this.head.clear()
    this.classes = new Map()
    this.classHead.clear()
    this.classSpan.clear()
    this.liveOf.clear()
    this.dead = 0
    this.stale = false
    const batch = ids.map((id) => {
      const i = this.at.get(id)!
      this.primary[i] = 0
      this.seq[i] = this.next++
      return i
    })
    this.join(batch)
  }

  private before(a: number, b: number): boolean {
    const pa = this.primary[a]!
    const pb = this.primary[b]!
    return pa < pb || (pa === pb && this.seq[a]! < this.seq[b]!)
  }

  /** `a` without its taken ones, and `b`, in rank order. */
  private merge(a: readonly number[], b: readonly number[]): number[] {
    const out: number[] = []
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && this.taken[a[i]!] === 1) i++
      else if (j === b.length || (i < a.length && this.before(a[i]!, b[j]!))) out.push(a[i++]!)
      else out.push(b[j++]!)
    }
    return out
  }

  private join(batch: readonly number[]): void {
    this.joins++
    // Taken ones outnumber the rest: read without them once.
    if (this.dead > this.order.length / 2) {
      this.order = this.merge(this.order, [])
      for (const [k, q] of this.kinds) this.kinds.set(k, this.merge(q, []))
      this.head.clear()
      for (const [c, q] of this.classes) {
        const left = this.merge(q, [])
        if (left.length > 0) this.classes.set(c, left)
        else this.classes.delete(c)
      }
      this.classHead.clear()
      this.dead = 0
      this.lo = 0
    }
    const len = this.order.length + batch.length
    this.lo = Math.min(this.lo, this.insert(this.order, batch))
    // A merge left the taken ones out.
    this.dead -= len - this.order.length
    const by = new Map<string, number[]>()
    for (const i of batch) {
      const k = this.kindAt(i)
      this.liveOf.set(k, (this.liveOf.get(k) ?? 0) + 1)
      const q = by.get(k)
      if (q === undefined) by.set(k, [i])
      else q.push(i)
    }
    const byClass = new Map<number, number[]>()
    for (const i of batch) {
      const t = this.tasks[i]!
      const c = classOf(t)
      const span = this.classSpan.get(c)
      if (span === undefined) this.classSpan.set(c, [t.cores, t.cores, t.memory])
      else {
        span[0] = Math.min(span[0], t.cores)
        span[1] = Math.max(span[1], t.cores)
        span[2] = Math.max(span[2], t.memory)
      }
      const q = byClass.get(c)
      if (q === undefined) byClass.set(c, [i])
      else q.push(i)
    }
    for (const [c, q] of byClass) {
      const had = this.classes.get(c)
      if (had === undefined) {
        this.classes.set(c, q)
        this.classHead.delete(c)
      } else {
        const first = this.insert(had, q)
        const h = this.classHead.get(c)
        if (h !== undefined && first < h) this.classHead.set(c, first)
      }
    }
    // Only the kinds it joins: each join read every kind and every ready
    // task, and a 6000-task tree spent 2 s of a 5 s plan on it.
    for (const [k, q] of by) {
      const had = this.kinds.get(k)
      if (had === undefined) {
        this.kinds.set(k, q)
        this.head.delete(k)
      } else {
        const first = this.insert(had, q)
        const h = this.head.get(k)
        if (h !== undefined && first < h) this.head.set(k, first)
      }
    }
  }

  /**
   * `batch`, in rank order, into `into`, in rank order: merged when it is
   * as big, each put in its place when it is few. The first place it took.
   */
  private insert(into: number[], batch: readonly number[]): number {
    if (batch.length === 0) return into.length
    if (batch.length * 8 > into.length) {
      const merged = this.merge(into, batch)
      into.length = 0
      for (const i of merged) into.push(i)
      return 0
    }
    let first = into.length
    let lo = 0
    for (const b of batch) {
      let hi = into.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (this.before(into[mid]!, b)) lo = mid + 1
        else hi = mid
      }
      into.splice(lo, 0, b)
      first = Math.min(first, lo)
      lo++
    }
    return first
  }

  /** In order, past each kind in `spent` as `assign` reads it then. */
  *asks(
    spent: Set<string>,
    bounds?: Bounds,
    kinds?: number,
    // Read past, as `assign` would skip it (`Kept`).
    skip?: Proof,
  ): Generator<Ask> {
    // Measured needs are unrounded, so kinds can be as many as tasks: a
    // jump across every kind then cost more than a read of every task.
    if (this.kinds.size > MAX_JUMP_KINDS) {
      yield* this.byClass(spent, bounds, kinds, skip)
      return
    }
    // Arrays, not the maps: the scan below is most of a sim's time.
    const ks: string[] = []
    const qs: (readonly number[])[] = []
    for (const [k, q] of this.kinds) {
      ks.push(k)
      qs.push(q)
    }
    const at = new Int32Array(ks.length).fill(-1)
    let cursor = -1
    for (;;) {
      let next = -1
      let nextAt = -1
      for (let x = 0; x < ks.length; x++) {
        const k = ks[x]!
        if (spent.has(k)) continue
        const q = qs[x]!
        let p = at[x]! === -1 ? this.headOf(k, q) : at[x]!
        if (p < q.length && cursor !== -1 && !this.before(cursor, q[p]!))
          p = this.after(q, p, cursor)
        while (p < q.length && this.taken[q[p]!] === 1) p++
        at[x] = p
        if (p === q.length) continue
        // A kind no bin fits or holds for is spent here, as `assign` would
        // spend it once read: yielded, each cost a sim of 300 tasks a
        // pass over the bins. Bounds only shrink until a
        // bin is given, which clears `spent`.
        if (bounds !== undefined && dead(this.tasks[q[p]!]!, bounds)) {
          spent.add(k)
          continue
        }
        if (next === -1 || this.before(q[p]!, next)) {
          next = q[p]!
          nextAt = x
        }
      }
      if (next === -1) return
      at[nextAt]!++
      cursor = next
      if (skip?.one(next) === true) continue
      const t = this.tasks[next]!
      yield { id: t.id, need: t, kind: ks[nextAt]! }
    }
  }

  /**
   * As a read of every ready task in rank order, past each taken, spent
   * or `dead` one, but jumping across the cores' classes: a class whose
   * every task no bin fits, by the span its tasks asked, is passed whole. Read one by one, the ready
   * tasks of a 5000-task play were most of its time. A task
   * found dead stays dead until a bin is given, and a give only shrinks
   * the bins' room, so the read goes past it for the rest of the pass.
   */
  private *byClass(
    spent: Set<string>,
    bounds?: Bounds,
    kinds?: number,
    skip?: Proof,
  ): Generator<Ask> {
    const cs: number[] = []
    const qs: (readonly number[])[] = []
    for (const [c, q] of this.classes) {
      cs.push(c)
      qs.push(q)
    }
    const at = new Int32Array(cs.length).fill(-1)
    // Each class's first not taken nor spent, as last read: `spent` only
    // grows until a give clears it, so the read goes on from there. Read
    // again from `at` each step, the spent ones were most of a plan of
    // varied needs.
    const unspent = new Int32Array(cs.length)
    // Each class's next to yield this step, or -1.
    const cand = new Int32Array(cs.length)
    let spentSeen = spent.size
    let cursor = -1
    for (;;) {
      if (bounds?.done === true || (kinds !== undefined && spent.size >= kinds)) return
      if (spent.size < spentSeen) unspent.fill(0)
      spentSeen = spent.size
      let next = -1
      let nextAt = -1
      for (let x = 0; x < cs.length; x++) {
        cand[x] = -1
        const c = cs[x]!
        if (
          bounds !== undefined &&
          c !== ODD &&
          !bounds.open &&
          this.classSpan.get(c)![0] > bounds.free + 1e-9 &&
          this.classSpan.get(c)![1] < bounds.cores &&
          this.classSpan.get(c)![2] <= bounds.memory
        )
          continue
        const q = qs[x]!
        let p = at[x]! === -1 ? this.classHeadOf(c, q) : at[x]!
        if (p < q.length && cursor !== -1 && !this.before(cursor, q[p]!))
          p = this.after(q, p, cursor)
        for (; p < q.length; p++) {
          const i = q[p]!
          if (this.taken[i] === 1) continue
          const t = this.tasks[i]!
          if (bounds === undefined || !dead(t, bounds)) break
          spent.add(this.kindAt(i))
        }
        at[x] = p
        // A spent kind is passed here only: a give clears `spent`.
        let r = Math.max(p, unspent[x]!)
        while (r < q.length && (this.taken[q[r]!] === 1 || spent.has(this.kindAt(q[r]!)))) r++
        unspent[x] = r
        if (r < q.length) cand[x] = r
        if (r < q.length && (next === -1 || this.before(q[r]!, next))) {
          next = q[r]!
          nextAt = x
        }
      }
      if (next === -1) return
      cursor = next
      // Past each skipped one, only its class reads on: the others' next
      // stand while `spent` does. Read again across every class, a plan of
      // varied needs spent most of its time here.
      let again = false
      while (skip?.one(next) === true) {
        // As a step reads its class: past the dead, then past the spent.
        const q = qs[nextAt]!
        let r = this.leap(q, cand[nextAt]! + 1, skip)
        for (; r < q.length; r++) {
          const i = q[r]!
          if (this.taken[i] === 1) continue
          if (bounds === undefined || !dead(this.tasks[i]!, bounds)) break
          spent.add(this.kindAt(i))
        }
        if (spent.size !== spentSeen) {
          again = true
          break
        }
        at[nextAt] = r
        while (r < q.length && (this.taken[q[r]!] === 1 || spent.has(this.kindAt(q[r]!)))) r++
        unspent[nextAt] = r
        cand[nextAt] = r < q.length ? r : -1
        next = -1
        for (let x = 0; x < cs.length; x++) {
          const y = cand[x]!
          if (y !== -1 && (next === -1 || this.before(qs[x]![y]!, next))) {
            next = qs[x]![y]!
            nextAt = x
          }
        }
        if (next === -1) return
        cursor = next
      }
      if (again) continue
      const t = this.tasks[next]!
      yield { id: t.id, need: t, kind: this.kindAt(next) }
    }
  }

  /**
   * Past each block of `q` from `r` that `proof` proves fails whole: one
   * by one, the ready tasks read past were most of a plan of varied needs
   *. A dead one passed so stays unspent, and its kind's next
   * is dead alike, so spent then.
   */
  private leap(q: readonly number[], r: number, proof: Proof): number {
    if ((r & (BLOCK - 1)) !== 0) return r
    const spans = this.spansOf(q, proof)
    while (r < q.length && proof.all(spans[r >> BLOCK_BITS]!)) r += BLOCK
    return Math.min(r, q.length)
  }

  /** Each block's `Span` of `q`, made again once a join changed the queues. */
  private spansOf(q: readonly number[], proof: Proof): Span[] {
    const had = this.spans.get(q)
    if (had !== undefined && had.at === this.joins) return had.spans
    const spans: Span[] = []
    for (let b = 0; b < q.length; b += BLOCK) {
      const t0 = this.tasks[q[b]!]!
      const span: Span = {
        minCores: Infinity,
        maxCores: -Infinity,
        minMemory: Infinity,
        maxMemory: -Infinity,
        maxRank: -Infinity,
        minMs: Infinity,
        platform: t0.platform,
        mixed: false,
        special: false,
      }
      for (let p = b; p < Math.min(q.length, b + BLOCK); p++) {
        const t = this.tasks[q[p]!]!
        span.minCores = Math.min(span.minCores, t.cores)
        span.maxCores = Math.max(span.maxCores, t.cores)
        span.minMemory = Math.min(span.minMemory, t.memory)
        span.maxMemory = Math.max(span.maxMemory, t.memory)
        span.maxRank = Math.max(span.maxRank, proof.rank(q[p]!))
        span.minMs = Math.min(span.minMs, t.ms ?? UNKNOWN_MS)
        if (t.platform !== span.platform) span.mixed = true
        if (t.above !== undefined || (t.servers?.length ?? 0) > 0) span.special = true
      }
      spans.push(span)
    }
    this.spans.set(q, { at: this.joins, spans })
    return spans
  }

  private classHeadOf(c: number, q: readonly number[]): number {
    let h = this.classHead.get(c) ?? 0
    while (h < q.length && this.taken[q[h]!] === 1) h++
    this.classHead.set(c, h)
    return h
  }

  private headOf(k: string, q: readonly number[]): number {
    let h = this.head.get(k) ?? 0
    while (h < q.length && this.taken[q[h]!] === 1) h++
    this.head.set(k, h)
    return h
  }

  /** The first place from `p` in `q` ranked past `cursor`. */
  private after(q: readonly number[], p: number, cursor: number): number {
    let hi = q.length
    while (p < hi) {
      const mid = (p + hi) >> 1
      if (!this.before(cursor, q[mid]!)) p = mid + 1
      else hi = mid
    }
    return p
  }
}

function floorOf(needs: Iterable<{ cores: number; memory: number }>): {
  cores: number
  memory: number
} {
  let cores = Infinity
  let memory = Infinity
  for (const n of needs) {
    cores = Math.min(cores, n.cores)
    memory = Math.min(memory, n.memory)
  }
  return { cores, memory }
}
