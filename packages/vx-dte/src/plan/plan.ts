import { pack, type PackOptions, type Packing } from './pack.js'
import { DEFAULT_STRATEGY, type Strategy } from './strategy.js'
import type { TaskNode } from '@vzn/vx'
import {
  type Ahead,
  type Home,
  MARGIN,
  MARGIN_MS,
  missedWork,
  type Need,
  type Plan,
  type PlanTask,
  type PlanWorker,
  type Size,
  UNKNOWN_MS,
  warmOf,
  type WarmUp,
} from './model.js'
import { chainMs, fresh, play, simulate, tailFrom, together } from './play.js'

/** Packings tried again in other orders, at most; fewer as tasks pass `RESTART_TASKS / RESTARTS`. */
const RESTARTS = 64
const RESTART_TASKS = 6_400

/**
 * The workers to start and to let go. Of the new ones (`candidates`, in
 * the order the run would start them, each joining after its size's
 * `warmUpMs`), those a task needs to end by the best (all of them
 * started); of those, the ones it gives
 * work within their warm-up start now, the rest when that nears
 * (`againInMs`): a graph that widens later starts its workers later
 * (2026-10-23). An idle worker goes when the plan still ends in that margin
 * with one started in its place a warm-up later, joining after its own:
 * needed again sooner, it stays, so none is let go and started again.
 */
export function plan(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  candidates: readonly Size[],
  warmUpMs: WarmUp,
  // Whether the run can start one in a let-go one's place: not with
  // workers that join on their own.
  replaceable = true,
  // The latest an earlier plan of the same work allowed, from now.
  limitMs = Infinity,
  how: Strategy = DEFAULT_STRATEGY,
  // How much later each next worker of a size asked at once joins (`decide`'s `spreadMs`).
  spreadMs: (size: string) => number = () => 0,
): Plan & Ahead {
  const warm = warmOf(warmUpMs)
  // Each next one of a size joins a spread later, as packed: joining at
  // once, a play of six new workers ended 13 s before any packing could,
  // and the run asked six for one 4 s lint each (main bf52a3e, 2026-11-12).
  const nth = new Map<string, number>()
  for (const w of workers)
    if (w.starting === true && w.size !== undefined) nth.set(w.size, (nth.get(w.size) ?? 0) + 1)
  const added = candidates.map((s, i) => {
    const k = nth.get(s.name) ?? 0
    nth.set(s.name, k + 1)
    return fresh({ ...s, size: s.name }, `\0new${i}`, warm(s.name) + k * spreadMs(s.name))
  })
  // Two warm-ups ahead: a worker asked now joins after one, and the next
  // plan, a warm-up on, sees the one after.
  const horizon =
    2 *
      Math.max(
        warm(undefined),
        ...candidates.map((c) => warm(c.name)),
        ...workers.map((w) => w.at),
      ) +
    MARGIN_MS +
    // And a task given at its end runs through: work counted as cores
    // spread over the rest asked too few workers for a few long tasks.
    tasks.reduce((most, t) => Math.max(most, t.ms ?? UNKNOWN_MS), 0)
  // Each set of workers played once a plan: the releases and the final
  // play each played the same set again.
  const plays = new Map<string, ReturnType<typeof play>>()
  const memo = (
    ws: readonly PlanWorker[],
    deadline?: number,
    until = horizon,
    wakesOnly = false,
  ): ReturnType<typeof play> => {
    const key = `${deadline}\0${until}\0${wakesOnly}\n${ws.map((w) => `${w.id}\0${w.at}\0${w.dormant === true}`).join('\n')}`
    let p = plays.get(key)
    if (p === undefined) plays.set(key, (p = play(tasks, ws, how, until, deadline, wakesOnly)))
    return p
  }
  // Given no task in the play, and none past its window.
  const unused = (p: ReturnType<typeof play>, id: string): boolean =>
    !p.first.has(id) && p.cut !== true
  const floor = chainMs(tasks, workers)
  const none = memo(workers).end
  // The best end: every new one started now, each joining after its warm-up.
  const best = none <= floor ? none : Math.min(none, memo([...workers, ...added]).end)
  // Margin spent at each decision adds up: releases 4 s apart each lost
  // 4 s of 5 (tests/sim.test.ts, a growing graph). Spent once, unless the
  // rest can no longer end by then.
  const bound =
    best === Infinity
      ? Infinity
      : Math.max(best, Math.min(best + Math.max(MARGIN_MS, best * MARGIN), limitMs))
  // The new ones, started by the play only when a task needs one to end
  // by the best: fewest workers, and the critical path never waits. The
  // fewest within a margin of the best ended runs up to 2% late at 1.4 to
  // 2.8 times the least worker time, against 1.2 to 2 for this, on
  // random, layered, wide and chain graphs (2026-11-10).
  const sleeping =
    none <= best || best === Infinity ? [] : added.map((a) => ({ ...a, dormant: true }))
  const smallest = [...sleeping].sort((x, y) => x.cores - y.cores || x.memory - y.memory)
  // Played twice: once to learn which it starts, at their tasks' latest
  // start; again with each joining as soon as its task is ready, no
  // sooner than its warm-up, as the run starts it: one a task needs
  // anyway starts as soon as it can, and the rest of its room goes to
  // tasks with slack (2026-11-10: "Otherwise we spawn as soon as
  // possible"). One check a step of the first waiting task: a check of
  // each waiting one against each worker planned 9000 in a minute.
  const run = (ws: readonly PlanWorker[]): ReturnType<typeof play> => {
    // One a drain asked already (`drain`) is not asked again.
    const asked = new Set(ws.map((w) => w.id))
    const asleep = sleeping.filter((a) => !asked.has(a.id))
    const smallFirst = smallest.filter((a) => !asked.has(a.id))
    if (asleep.length === 0) return memo(ws)
    // Played through: a task with slack past the window still starts its
    // worker as it gets ready, not a window before its latest start.
    // Read for its wakes: played on past the last, each plan of 3,800
    // tasks played the rest of the run (2026-11-11).
    // Learned smallest first, then those within a warm-up of each other
    // asked as fewer, bigger ones: on graphs of 2- to 16-core sizes, 1.6%
    // late to 1.2% and 3% less CPU held (lab, 2026-11-11: "scale the
    // workers to as big as possible at the same time to save on startup
    // times").
    const lazy = memo([...ws, ...smallFirst], best, Infinity, true)
    const at = together(lazy.wakes, asleep)
    const early = memo(
      [
        ...ws,
        ...asleep.map((a) => {
          const r = at.get(a.id)
          return r === undefined ? a : { ...a, dormant: false, at: Math.max(a.at, r) }
        }),
      ],
      best,
    )
    // Started for a task only at its latest start, a worker can come
    // too late for the work behind it: then its own end is the plan's.
    // Every new one at once instead started five a moment into a run of
    // no history and cancelled them all before they joined (main 2163fff).
    const own = memo(ws)
    return own.end <= early.end ? own : early
  }
  let kept: PlanWorker[] = [...workers]
  const release: string[] = []
  // Played with the rest: left out, the next idle one and the plan's end
  // counted on a worker the run lets go.
  const standIns: PlanWorker[] = []
  if (best < Infinity) {
    // One starting that the play gives no task is cancelled before it
    // joins, last to join first. Within a margin, the next plan's
    // estimates moved a second later and cancelled 7 asked one at a time
    // (PR #4214).
    const starting = workers.filter((w) => w.starting === true).sort((a, b) => b.at - a.at)
    for (const w of starting)
      if (unused(run(kept), w.id)) {
        kept = kept.filter((k) => k !== w)
        release.push(w.id)
      }
    // Biggest first: a big idle one costs the most to keep. Joined, its
    // warm-up is spent: it goes when the plan gives it no task, not when
    // the run ends within the margin without it (main e05bd71 let a mac go
    // that way and asked another 4 s later).
    const idle = workers.filter((w) => w.idle).sort((a, b) => b.cores - a.cores)
    // A stand-in is one of the run's next starts of its size, not kept for
    // other work. With none (its size's `max` spent: one let go still
    // counts), the arm worker of a max-1 size went idle between two arm
    // tasks, was let go, and the second found no worker (fuzz, 2026-10-25).
    const spare = new Map<string, number>()
    const woken = run(kept).first
    candidates.forEach((s, i) => {
      if (!woken.has(added[i]!.id)) spare.set(s.name, (spare.get(s.name) ?? 0) + 1)
    })
    for (const w of idle) {
      const without = kept.filter((k) => k !== w)
      const played = run([...kept, ...standIns])
      // Given nothing in a window with work past it: needed past it, maybe.
      const next = played.first.get(w.id) ?? (played.cut === true ? horizon : undefined)
      if (next === undefined) {
        kept = without
        release.push(w.id)
        continue
      }
      // Needed again, it goes only when its next task is two warm-ups
      // away: a stand-in then starts a warm-up after it left. Sooner, the
      // next plan starts one at once: let go as 10 joined at 20 s, one was
      // started again at 20.06 (tests/sim.test.ts, a09b987 forecast).
      if (!replaceable) continue
      if (next < 2 * warm(w.size) + MARGIN_MS) continue
      const left = w.size === undefined ? 0 : (spare.get(w.size) ?? 0)
      if (left === 0) continue
      const instead = fresh(
        { cpu: w.cores, memory: w.memory, platform: w.platform, size: w.size },
        w.id,
        next,
      )
      // No later than with it: a run already past its bound (a task of no
      // history ran long) kept 30 idle workers to its end (2026-11-10).
      if (run([...without, ...standIns, instead]).end <= Math.max(bound, played.end)) {
        kept = without
        release.push(w.id)
        standIns.push(instead)
        spare.set(w.size!, left - 1)
      }
    }
  }
  // The big ones that would run on mostly free: the work past their big
  // work goes to the smallest new one it fits, asked to join as that
  // starts, when that holds less CPU and the run ends no later
  // (2026-11-11: "never let that happen. You should just cut it whenever
  // the big job ... stop being used").
  let ws = [...kept, ...standIns]
  let played = run(ws)
  const drain: { id: string; inMs: number }[] = []
  const work = (platform: string | undefined): number =>
    tasks.reduce(
      (sum, t) =>
        sum +
        (t.platform === undefined || t.platform === platform ? t.cores * (t.ms ?? UNKNOWN_MS) : 0),
      0,
    )
  // With a task of no history left, only for the run's last work: one
  // of the trap graphs ran 30% late on the small one it guessed would do
  // mid-run (lab, 2026-11-11), but a last task alone on a 48-core worker
  // gets a worker of the cores it is guessed to need (2026-11-11: "You
  // assume that it will take ... 1-2 cores ... and you spawn another
  // worker just for that").
  const blind = tasks.some((t) => t.ms === undefined)
  if (replaceable)
    for (const w of kept) {
      if (w.starting === true || w.drainIn !== undefined || w.at > 0) continue
      const runs = played.ran().get(w.id)
      if (runs === undefined) continue
      for (const z of added
        .filter(
          (a) =>
            !played.first.has(a.id) &&
            !ws.some((x) => x.id === a.id) &&
            a.platform === w.platform &&
            a.cores < w.cores,
        )
        .sort((x, y) => x.cores - y.cores || x.memory - y.memory)) {
        const from = tailFrom(runs, w.cores, z)
        if (from === undefined) continue
        const trial = [
          ...ws.map((x) => (x === w ? { ...x, drainIn: from } : x)),
          { ...z, at: from },
        ]
        // Every task left still has a worker with room for all of it: past
        // the window, a 4-core one ran on the 2 left at half its pace.
        const roomy = (t: PlanTask): boolean =>
          trial.some(
            (x) =>
              x.drainIn === undefined &&
              (t.platform === undefined || x.platform === t.platform) &&
              x.cores >= t.cores - 1e-9 &&
              x.memory >= t.memory,
          )
        if (!tasks.every((t) => t.platform !== w.platform || roomy(t))) break
        // Only once the rest is narrow: its work spread over its chain fits
        // the workers left. With big work still to come, the big one stays
        // (2026-11-11: "don't shrink just to shrink").
        let cores = 0
        for (const x of trial)
          if (x.drainIn === undefined && x.platform === w.platform) cores += x.cores
        if (work(w.platform) > cores * Math.max(floor, 1)) break
        const p = run(trial)
        const last = (): boolean => {
          for (const [id, runs] of p.ran())
            if (id !== z.id && runs.some((r) => r[0] >= from)) return false
          return true
        }
        // The new one has room for all it runs: a guessed time hides a 4-core
        // task at half pace on a 2-core one (lab, 2026-11-11).
        const fits = (p.ran().get(z.id) ?? []).every(
          (r) => r[2] <= z.cores + 1e-9 && r[3] <= z.memory,
        )
        if (fits && p.end <= played.end + 1e-6 && p.held() < played.held() && (!blind || last())) {
          ws = trial
          played = p
          drain.push({ id: w.id, inMs: from })
        }
        break
      }
    }
  // Packed by latest start, the work ends at the same deadline on less
  // worker time: started as soon as there was room, tasks with slack
  // spread over workers the run then kept, 21% more than the least that
  // ends at the critical path (lab, 2026-11-11). Known work only: a
  // guessed time packs nothing.
  let unpacked = blind
    ? 'a task has no history'
    : !replaceable
      ? 'no adapter'
      : bound === Infinity
        ? 'no end'
        : undefined
  if (unpacked === undefined) {
    // One past its warm-up may join any time: packed as if asked now. Packed
    // on joining at once, workers the CI started 2.5 s apart took work
    // planned on the fleet and the run ended 19 s late, where a play
    // started two more (tests/sim.test.ts, 2026-11-11).
    // Each worker read once: a pack reads its running tasks twice.
    const packedWorkers = workers.map((w) =>
      w.starting === true && w.at <= 0 ? { ...w, at: warm(w.size) } : { ...w },
    )
    const packs = (deadline: number, strict: boolean, more: PackOptions = {}) =>
      pack(
        tasks,
        packedWorkers,
        candidates,
        (size, nth) => warm(size) + nth * spreadMs(size),
        deadline,
        { ...more, strict },
      )
    // Packed to the chain first, then past it by a warm-up, then by the
    // play's end: packed to the play's end only, a run a moment off its plan
    // packed to that later end, and ended there (tests/sim-theory.test.ts,
    // 2026-11-11).
    const warmest = candidates.reduce((most, c) => Math.max(most, warm(c.name)), 0)
    let packed: Packing =
      (floor < best ? packs(floor, true) : undefined) ??
      (floor + warmest < best ? packs(floor + warmest, true) : undefined) ??
      packs(best, false)!
    // Then packed again in other orders, each task's new worker a random
    // way into its slack, keeping the least held by the same end: on 50
    // small graphs solved exactly, 64 more brought 3-10% over the least
    // CPU to under 3% (lab, 2026-11-11). As many as a plan's time allows.
    const tries = Math.min(RESTARTS, Math.floor(RESTART_TASKS / Math.max(1, tasks.length)))
    if (tries > 0 && packed.placed.size === tasks.length) {
      const mean = tasks.reduce((sum, t) => sum + (t.ms ?? 0), 0) / tasks.length
      const end = packed.end
      let seed = 1
      const rnd = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647
      for (let k = 0; k < tries; k++) {
        const scale = mean * [0.1, 0.3, 0.8][k % 3]!
        // By the first packing's end, never later: slack it left is margin.
        const other = packs(end, true, {
          noise: tasks.map(() => (rnd() * 2 - 1) * scale),
          late: tasks.map(() => rnd()),
        })
        if (other !== undefined && other.placed.size === tasks.length && other.held < packed.held)
          packed = other
      }
    }
    // A play cut at its window holds less than its run: not compared. One
    // that left out a task no worker fits (its history over a worker's
    // cores) held nothing, and the run waited on it forever (2026-11-11).
    unpacked =
      packed.placed.size < tasks.length
        ? `left out ${tasks.find((t) => !packed.placed.has(t.id))!.id}`
        : packed.end > best + 1e-6
          ? `ends ${Math.round(packed.end)} ms, the play ${Math.round(best)}`
          : played.cut !== true && packed.held >= played.held()
            ? `holds ${Math.round(packed.held)}, the play ${Math.round(played.held())}`
            : undefined
    if (unpacked === undefined) {
      const start: Size[] = []
      const started: Ahead['started'][number][] = []
      const later: Ahead['later'][number][] = []
      for (const s of packed.starts) {
        const given = packed.given.get(s.id) ?? []
        const freeInMs = packed.free.get(s.id)!
        const joinInMs = warm(s.size.name)
        // Asked a margin early, as the play's are.
        if (s.at < MARGIN_MS + 1) {
          start.push(s.size)
          started.push({ freeInMs, joinInMs, given })
        } else later.push({ size: s.size, inMs: s.at - MARGIN_MS, freeInMs, joinInMs, given })
      }
      later.sort((a, b) => a.inMs - b.inMs)
      const fresh = [...packed.starts]
        .sort((a, b) => a.at + warm(a.size.name) - b.at - warm(b.size.name))
        .map((s) => ({ id: s.id, size: s.size.name }))
      const ids = new Set(workers.map((w) => w.id))
      const after = new Map<string, number>()
      const placed = new Map<string, string>()
      const asap = new Set<string>()
      for (const [id, p] of packed.placed) {
        placed.set(id, p.worker)
        if (p.at > 1) after.set(id, p.at)
        if (p.at <= p.ready + 1) asap.add(id)
      }
      return {
        start,
        release: workers
          .filter((w) => (w.idle || w.starting === true) && !packed.given.has(w.id))
          .map((w) => w.id),
        endsInMs: packed.end,
        boundMs: Math.max(bound, packed.end),
        againInMs: later[0]?.inMs,
        untilInMs: undefined,
        freeInMs: new Map([...packed.free].filter(([id]) => ids.has(id))),
        given: new Map([...packed.given].filter(([id]) => ids.has(id))),
        later,
        started,
        drain: [],
        placed,
        after,
        asap,
        fresh,
        exact: true,
      }
    }
  }
  const { end, first, free, cut, given } = played
  const start: Size[] = []
  const frees = free()
  const gave = given()
  const started: Ahead['started'][number][] = []
  const later: Ahead['later'][number][] = []
  let againInMs: number | undefined
  for (let i = 0; i < added.length; i++) {
    const id = added[i]!.id
    const at = first.get(id)
    if (at === undefined) continue
    // Given work within its warm-up and a margin: it starts now.
    const warmUp = added[i]!.at
    // Within a millisecond counts: `againInMs` of 1e-10 replanned the
    // same plan 100,000 times at one instant (tests/sim.test.ts).
    if (at < warmUp + MARGIN_MS + 1) {
      start.push(candidates[i]!)
      started.push({ freeInMs: frees.get(id)!, joinInMs: warmUp, given: gave.get(id)! })
    } else {
      const inMs = at - warmUp - MARGIN_MS
      againInMs = Math.min(againInMs ?? Infinity, inMs)
      later.push({
        size: candidates[i]!,
        inMs,
        freeInMs: frees.get(id)!,
        joinInMs: warmUp,
        given: gave.get(id)!,
      })
    }
  }
  // A stand-in is asked as its work nears like any later one: asked by no
  // plan, a let-go worker's work waited 92 s past its latest start for
  // the next look (lab, 2026-11-11).
  for (const w of standIns) {
    const at = first.get(w.id)
    const size = candidates.find((c) => c.name === w.size)
    if (at === undefined || size === undefined) continue
    const warmUp = warm(w.size)
    if (at < warmUp + MARGIN_MS + 1) {
      start.push(size)
      started.push({ freeInMs: frees.get(w.id)!, joinInMs: warmUp, given: gave.get(w.id)! })
      continue
    }
    const inMs = at - warmUp - MARGIN_MS
    againInMs = Math.min(againInMs ?? Infinity, inMs)
    later.push({ size, inMs, freeInMs: frees.get(w.id)!, joinInMs: warmUp, given: gave.get(w.id)! })
  }
  later.sort((a, b) => a.inMs - b.inMs)
  // Work past the window: plan again a warm-up on, the window moved.
  const untilInMs = cut === true ? (horizon - MARGIN_MS) / 2 : undefined
  return {
    ...(unpacked === undefined ? {} : { unpacked }),
    start,
    release,
    endsInMs: end,
    boundMs: Math.max(bound, end),
    againInMs: untilInMs === undefined ? againInMs : Math.min(againInMs ?? Infinity, untilInMs),
    untilInMs,
    freeInMs: frees,
    given: gave,
    later,
    started,
    drain,
    // None while a task of no history is left: placed on guesses, graphs
    // a third unmeasured ended 2% late to 3.5% (lab, 2026-11-11).
    after: new Map(),
    fresh: [],
    placed: new Map(
      blind
        ? []
        : [...gave].flatMap(([w, ids]) =>
            w.startsWith('\0') ? [] : ids.map((id) => [id, w] as const),
          ),
    ),
  }
}

/**
 * The sizes the run would start next, in order: for each task that
 * filled its worker last time (`above`), one of the smallest size of its platform bigger
 * than it while the run has none of that size; for each platform tasks
 * run on, its sizes in declared order, up to one per task of it; then
 * sizes biggest first, each up to its max and `limit`.
 */
export function candidates(
  sizes: readonly Size[],
  started: ReadonlyMap<string, number>,
  above: Iterable<{ cores: number; memory: number; platform?: string | undefined }>,
  limit: number,
  platforms: ReadonlyMap<string, number> = new Map(),
): Size[] {
  const count = new Map(started)
  const out: Size[] = []
  const add = (s: Size): void => {
    count.set(s.name, (count.get(s.name) ?? 0) + 1)
    out.push(s)
  }
  const up = [...sizes].sort((x, y) => x.cpu - y.cpu || x.memory - y.memory)
  for (const a of above) {
    const z = up.find(
      (s) =>
        (a.platform === undefined || s.platform === a.platform) &&
        (s.cpu > a.cores || s.memory > a.memory),
    )
    if (z !== undefined && (count.get(z.name) ?? 0) === 0 && z.max > 0) add(z)
  }
  // A platform the declared order reaches late gets its workers too, one
  // a round each: listed after all of another's, a plan took twelve Linux
  // workers to reach the Mac one (main c27c238 asked 13, cancelled 7).
  const wants = new Map(platforms)
  for (let added = true; added;) {
    added = false
    for (const [platform, tasks] of wants) {
      if (tasks === 0) continue
      const s = sizes.find((x) => x.platform === platform && (count.get(x.name) ?? 0) < x.max)
      if (s === undefined) continue
      add(s)
      wants.set(platform, tasks - 1)
      added = true
    }
  }
  // The biggest first, `limit` of each: declared smallest first, a plan
  // of 2- to 16-core sizes took 2-core ones only, 59% late; `limit` in all,
  // the biggest only, and a short burst held a 16-core worker for the
  // chain after it, 10% more CPU held than with each size (lab, 2026-11-11:
  // "scale the workers to as big as possible at the same time to save on
  // startup times").
  for (const s of [...sizes].sort((x, y) => y.cpu - x.cpu || y.memory - x.memory))
    for (let n = 0; n < limit && (count.get(s.name) ?? 0) < s.max; n++) add(s)
  return out
}

/**
 * What the run does now, from all it knows: its known work (`missedWork`)
 * less what runs already, played on its workers and on the candidates it
 * may start (`plan`). The live run (`plugin.ts`) and the simulation that
 * holds it to its invariants (tests/sim.ts) both decide here.
 */
export function decide(input: {
  readonly remaining: Iterable<string>
  readonly nodes: ReadonlyMap<string, TaskNode>
  readonly executed: ReadonlySet<string>
  readonly need: (id: string) => Need
  readonly durationMs: (id: string) => number | undefined
  readonly workers: readonly PlanWorker[]
  readonly running: ReadonlySet<string>
  readonly sizes: readonly Size[]
  readonly started: ReadonlyMap<string, number>
  /** No worker may be started: a planned run's last, or one without an adapter. */
  readonly final: boolean
  readonly warmUpMs: WarmUp
  readonly replaceable: boolean
  /** The last plan's `boundMs`, less the time since: kept while `known` holds all its work. */
  readonly limitMs?: number | undefined
  /** The work earlier plans knew. */
  readonly known?: ReadonlySet<string>
  /** How it orders, places and scales (`need` books already). */
  readonly how?: Strategy
  /** The platform a task naming none runs on (`homeOf`), or where each task runs (several worker types). */
  readonly home?: Home | undefined
  /**
   * Sizes with a worker asked and not joined past its warm-up: the CI
   * queued it, and one asked now queues behind it. None of them starts.
   */
  readonly queued?: ReadonlySet<string>
  /**
   * The run's last plan, kept here: while what it saw holds, the next is
   * that plan again, not played anew, and hands back no `tasks` when it
   * read none. With `now`, the run's clock.
   */
  readonly last?: { forecast?: Forecast }
  readonly now?: number
  /**
   * How much later each next worker of a size asked at once joins: CI
   * runners asked together joined 2.5 s apart, and a packing that counted
   * on all joining as the first ended a run 18 s late (tests/sim.test.ts,
   * 2026-11-11).
   */
  readonly spreadMs?: ((size: string) => number) | undefined
}): Plan & {
  readonly tasks: readonly PlanTask[]
  /** What `plan()` was given besides the tasks and workers: a profile marks it to play back. */
  readonly played?: { readonly sizes: readonly Size[]; readonly limitMs: number | undefined }
} {
  const how = input.how ?? DEFAULT_STRATEGY
  const now = input.now ?? 0
  const had = input.last?.forecast
  // Following a plan reads only what events move: the workers, their
  // joins, each task as it starts and ends. Every task read at each of a
  // 5000-task run's events made it quadratic (2026-11-05: "Why do we
  // recheck every task against plan? There is no point").
  if (how.scale !== 'backlog' && had !== undefined) {
    const step = follow(had, undefined, input, undefined, now)
    // No work read, none to hand back: each step handed back the plan's
    // whole work, and the run read it all at each event.
    // A start or a release hands back the work it plans for, as the run reports it.
    if (step !== undefined && step !== 'full')
      return shown(
        input.last!,
        had,
        step,
        now,
        step.start.length > 0 || step.release.length > 0 ? had.work : [],
      )
  }
  const tasks = missedWork(
    input.remaining,
    input.nodes,
    input.executed,
    input.need,
    input.durationMs,
    input.home,
  ).filter((t) => !input.running.has(t.id))
  const platforms = new Map<string, number>()
  for (const t of tasks)
    if (t.platform !== undefined) platforms.set(t.platform, (platforms.get(t.platform) ?? 0) + 1)
  const sizes = input.final
    ? []
    : candidates(
        input.queued === undefined
          ? input.sizes
          : input.sizes.filter((s) => !input.queued!.has(s.name)),
        input.started,
        tasks.flatMap((t) => (t.above === undefined ? [] : [{ ...t.above, platform: t.platform }])),
        tasks.length,
        platforms,
      )
  if (how.scale === 'backlog')
    return { ...backlog(tasks, input.workers, sizes, input.warmUpMs, how), tasks }
  const step = had === undefined ? undefined : follow(had, tasks, input, sizes, now)
  if (step !== undefined && step !== 'full') return shown(input.last!, had!, step, now, tasks)
  // New work moves the deadline; work done or known already does not.
  const limitMs = tasks.every((t) => input.known?.has(t.id) === true) ? input.limitMs : undefined
  const { freeInMs, given, later, started, untilInMs, ...p } = plan(
    tasks,
    input.workers,
    sizes,
    input.warmUpMs,
    input.replaceable,
    limitMs,
    how,
    input.spreadMs,
  )
  if (input.last !== undefined)
    input.last.forecast = forecastOf(
      p,
      { freeInMs, given, later, started, untilInMs },
      tasks,
      input,
      now,
    )
  // Given whether it packed or played: the run's first plan packed, and
  // its profile had nothing to play back (main 98088da, 2026-11-12).
  return { ...p, tasks, played: { sizes, limitMs } }
}

/**
 * What a plan saw, to tell whether the next would differ: its work and
 * each task's time, its workers as starting, idle or busy, the tasks
 * already past their time, the sizes queued, when it wanted to look again.
 */
export interface Forecast {
  readonly at: number
  readonly plan: Plan
  /** The work it played. */
  readonly work: readonly PlanTask[]
  /** Each waiting task's time, and each waiting or running task's cores and memory. */
  readonly ms: ReadonlyMap<string, number | undefined>
  readonly need: ReadonlyMap<string, readonly [cores: number, memory: number]>
  /** The workers it saw, and those it started as they show. */
  readonly workers: ReadonlySet<string>
  /** How many workers the run has as planned. */
  readonly count: number
  /** When each worker's last planned task ends, on the run's clock. */
  readonly free: ReadonlyMap<string, number>
  /** The tasks planned on each worker. */
  readonly given: ReadonlyMap<string, readonly string[]>
  /** When each worker still starting joins, on the run's clock. */
  readonly join: ReadonlyMap<string, number>
  /** Those of each worker started and not seen yet, in the order started. */
  readonly fresh: readonly {
    readonly free: number
    readonly join: number
    readonly given: readonly string[]
  }[]
  /** Starts the plan wants later, each when due, on the run's clock. */
  readonly later: readonly {
    readonly size: Size
    readonly at: number
    readonly free: number
    readonly join: number
    readonly given: readonly string[]
  }[]
  /** Work it saw that has since been seen running: work that left otherwise moves the plan. */
  readonly seen: Set<string>
  /** When each task seen running ends, on the run's clock. */
  readonly ends: ReadonlyMap<string, number>
  /** How many tasks the run had handed over, and those it had when planned. */
  readonly executed: number
  readonly before: ReadonlySet<string>
  /**
   * How far it read the handed-over set, kept across its steps: a Set's
   * iterator sees what is added after it, so each id is read once. Each
   * step read the whole set, O(n) an event (2026-11-05).
   */
  readonly scan: { of?: ReadonlySet<string> | undefined; it?: Iterator<string>; read: number }
  /** Each size's warm-up as it saw it: a join tells the run's own. */
  readonly warm: readonly number[]
  /** When its window moves on, on the run's clock. */
  readonly until: number
  readonly late: ReadonlySet<string>
  readonly queued: string
  readonly final: boolean
}

type Seen = Pick<
  Parameters<typeof decide>[0],
  'workers' | 'queued' | 'final' | 'sizes' | 'started' | 'warmUpMs' | 'executed' | 'nodes'
>

/**
 * Running tasks past their time by more than `slack`: one that runs that
 * long moves the plan (2026-11-05: "Reality changes by leave some
 * margin. 5% or sth").
 */
function lateOf(workers: readonly PlanWorker[], slack: number): Set<string> {
  const out = new Set<string>()
  for (const w of workers)
    for (const r of w.running) if (r.endsIn < -slack && r.id !== undefined) out.add(r.id)
  return out
}

/** Each waiting and running task's cores and memory, as a plan saw them. */
function needsOf(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
): Map<string, readonly [number, number]> {
  const out = new Map<string, readonly [number, number]>(
    tasks.map((t) => [t.id, [t.cores, t.memory] as const]),
  )
  for (const w of workers)
    for (const r of w.running) if (r.id !== undefined) out.set(r.id, [r.cores, r.memory])
  return out
}

/** Whether `is` moved from `was` past 5%, or past `least` when they are small. */
const moved = (was: number, is: number, least: number): boolean =>
  Math.abs(is - was) > Math.max(least, Math.abs(was) * MARGIN)

/** How late a task may run, or how far its time may move, before the plan is made again: 5% of the run's. */
const slackOf = (p: Plan): number => Math.max(MARGIN_MS / 5, p.endsInMs * MARGIN)

const warmsOf = (input: Seen): number[] => {
  const warm = warmOf(input.warmUpMs)
  return [warm(undefined), ...input.sizes.map((s) => warm(s.name))]
}

function forecastOf(
  p: Plan,
  ahead: Ahead,
  tasks: readonly PlanTask[],
  input: Seen,
  now: number,
): Forecast {
  return {
    at: now,
    plan: p,
    work: tasks,
    ms: new Map(tasks.map((t) => [t.id, t.ms])),
    need: needsOf(tasks, input.workers),
    workers: new Set(input.workers.map((w) => w.id).filter((id) => !p.release.includes(id))),
    count: input.workers.length + p.start.length - p.release.length,
    free: new Map([...ahead.freeInMs].map(([id, ms]) => [id, now + ms])),
    join: new Map(
      input.workers.flatMap((w) => (w.starting === true ? [[w.id, now + w.at] as const] : [])),
    ),
    given: ahead.given,
    fresh: ahead.started.map((a) => ({
      free: now + a.freeInMs,
      join: now + a.joinInMs,
      given: a.given,
    })),
    later: ahead.later.map((l) => ({
      size: l.size,
      at: now + l.inMs,
      free: now + l.freeInMs,
      join: now + l.inMs + l.joinInMs,
      given: l.given,
    })),
    seen: new Set(),
    ends: new Map(
      input.workers.flatMap((w) =>
        w.running.flatMap((r) => (r.id === undefined ? [] : [[r.id, now + r.endsIn] as const])),
      ),
    ),
    executed: input.executed.size,
    before: new Set(input.executed),
    scan: { read: 0 },
    warm: warmsOf(input),
    until: ahead.untilInMs === undefined ? Infinity : now + ahead.untilInMs,
    late: lateOf(input.workers, slackOf(p)),
    queued: [...(input.queued ?? [])].sort().join('\0'),
    final: input.final,
  }
}

/** The plan `had` made, followed a step: its decisions now, its times less the time since. */
function shown(
  last: { forecast?: Forecast },
  had: Forecast,
  step: Step,
  now: number,
  tasks: readonly PlanTask[],
): Plan & { readonly tasks: readonly PlanTask[] } {
  last.forecast = step.next
  const again = Math.min(step.next.later[0]?.at ?? Infinity, step.next.until)
  const since = now - had.at
  return {
    start: step.start,
    release: step.release,
    endsInMs: Math.max(0, had.plan.endsInMs - since),
    boundMs: had.plan.boundMs - since,
    againInMs: Number.isFinite(again) ? again - now : undefined,
    // Asked when it was played: the run keeps them.
    drain: [],
    tasks,
  }
}

type Step = { start: Size[]; release: string[]; next: Forecast }

/**
 * The plan `f` made, followed one step on when it still stands: no new
 * work, no task's time, cores or memory moved past 5%, no worker joined
 * or left but as planned, no task ran past its time. Its starts come due
 * and its workers with their work done go, as it foresaw; undefined
 * plays it anew. Planned at every task's end, a run of 1000 tasks
 * replayed itself 10 000 times (2026-11-05: "It's just about filling
 * boxes to full"; "If simulated all goes with plan so there should be no
 * replans").
 *
 * Without `tasks` (and `sizes`), only what events move is read: work it
 * did not see is `full`, read every task first.
 */
function follow(
  f: Forecast,
  tasks: readonly PlanTask[] | undefined,
  input: Seen,
  sizes: readonly Size[] | undefined,
  now: number,
): Step | 'full' | undefined {
  if (now >= f.until) return undefined
  if (f.final !== input.final) return undefined
  if ([...(input.queued ?? [])].sort().join('\0') !== f.queued) return undefined
  if (input.workers.length !== f.count) return undefined
  const warm = warmsOf(input)
  for (let i = 0; i < warm.length; i++)
    if (moved(f.warm[i]!, warm[i]!, MARGIN_MS / 5)) return undefined
  const slack = slackOf(f.plan)
  // Only what moved since is read: each task as it starts, runs and ends.
  // A waiting one's time moves with the run's, which those show.
  const ends = new Map<string, number>()
  let began = 0
  for (const w of input.workers)
    for (const r of w.running) {
      if (r.id === undefined) continue
      const was = f.need.get(r.id)
      // As for time, so for resources (2026-11-05: "And resource usage").
      if (
        was !== undefined &&
        (moved(was[0], r.cores, 0.05) || moved(was[1], r.memory, 64 * 2 ** 20))
      )
        return undefined
      const end = f.ends.get(r.id)
      if (end !== undefined) {
        ends.set(r.id, end)
        continue
      }
      // Started since: work the plan saw, as long as it played it.
      if (!f.ms.has(r.id)) return undefined
      const ms = f.ms.get(r.id)
      if (ms !== undefined && r.endsIn > ms + Math.max(MARGIN_MS / 5, ms * MARGIN)) return undefined
      ends.set(r.id, now + r.endsIn)
      f.seen.add(r.id)
      began++
    }
  // Ended since: sooner than played moves the plan, and so does one of
  // no known time ending.
  for (const [id, at] of f.ends)
    if (!ends.has(id) && (now < at - slack || (f.ms.has(id) && f.ms.get(id) === undefined)))
      return undefined
  for (const id of lateOf(input.workers, slack)) if (!f.late.has(id)) return undefined
  // More handed over than started, or fewer known: work it did not see,
  // maybe. Read it.
  if (input.executed.size > f.executed + began || input.executed.size < f.executed) {
    // Handed over and not started yet is work it saw: only one it did not
    // see sends the plan to read every task.
    if (tasks === undefined) {
      if (input.executed.size < f.executed) return 'full'
      const scan = f.scan
      if (scan.of !== input.executed) {
        scan.of = input.executed
        scan.it = input.executed.values()
        scan.read = 0
      }
      for (; scan.read < input.executed.size; scan.read++) {
        const r = scan.it!.next()
        // One left the set: the count no longer says where it read to.
        if (r.done === true) {
          scan.of = undefined
          return 'full'
        }
        const id = r.value
        if (
          !f.ms.has(id) &&
          !f.before.has(id) &&
          input.nodes.get(id)?.config.exec?.command !== undefined
        ) {
          scan.read++
          return 'full'
        }
      }
    } else {
      for (const t of tasks) if (!f.ms.has(t.id)) return undefined
      // Work that left without running (a hit, or no longer asked) frees
      // what the plan gave it.
      const waiting = new Set(tasks.map((t) => t.id))
      for (const id of f.ms.keys())
        if (!waiting.has(id) && !f.seen.has(id) && !ends.has(id)) return undefined
    }
  }
  const workers = new Set(f.workers)
  const free = new Map(f.free)
  const given = new Map(f.given)
  const join = new Map(f.join)
  const fresh = [...f.fresh]
  const release: string[] = []
  for (const w of input.workers) {
    if (!workers.has(w.id)) {
      // One the plan started, shown: it takes the next started's work.
      const next = fresh.shift()
      if (next === undefined) return undefined
      workers.add(w.id)
      free.set(w.id, next.free)
      given.set(w.id, next.given)
      join.set(w.id, next.join)
    }
    // Joined sooner or later than played, past the margin.
    const joins = join.get(w.id)
    if (joins !== undefined) {
      if (w.starting === true) {
        if (now > joins + slack) return undefined
      } else {
        if (now < joins - slack) return undefined
        join.delete(w.id)
      }
    }
    // Idle between its tasks, as played; with its work done, it goes.
    if (!w.idle || w.starting === true) continue
    const at = free.get(w.id)
    if (at === undefined || now >= at - slack) {
      // Its work done in a window with work past it: maybe needed there,
      // and one let go still counts against its size's max. A Mac let go
      // so left a Mac task no worker, and the run never ended (#4989).
      if (f.until < Infinity) return undefined
      // A task planned on it not started: its last one ended and the next
      // not handed to it yet. Let go, that one had no worker and the run
      // never ended (a two-task chain on a max-1 size, its rest within the
      // slack). Played again, the plan sees what waits for it.
      if (given.get(w.id)?.some((id) => !f.seen.has(id)) === true) return undefined
      release.push(w.id)
      workers.delete(w.id)
    }
  }
  const start: Size[] = []
  const later = [...f.later]
  while (later.length > 0 && now >= later[0]!.at) {
    const { size, free: ends, join: joins, given: runs } = later.shift()!
    // Its size taken up since: the plan no longer fits the run. Read
    // from what the run started, not from every task: each start read
    // them all (2026-11-05).
    if (sizes === undefined) {
      const kind = input.sizes.find((s) => s.name === size.name)
      if (
        input.final ||
        kind === undefined ||
        input.queued?.has(size.name) === true ||
        (input.started.get(size.name) ?? 0) >= kind.max
      )
        return undefined
    } else if (!sizes.some((s) => s.name === size.name)) return undefined
    start.push(size)
    fresh.push({ free: ends, join: joins, given: runs })
  }
  const next: Forecast = {
    ...f,
    workers,
    count: f.count + start.length - release.length,
    free,
    given,
    join,
    fresh,
    later,
    ends,
    executed: input.executed.size,
  }
  return { start, release, next }
}

/**
 * Spark's dynamic allocation: workers enough for the cores that what is
 * ready or running asks, started at once; an idle one past that leaves.
 * No play-out: it sees only the work that waits now.
 */
function backlog(
  tasks: readonly PlanTask[],
  workers: readonly PlanWorker[],
  candidates: readonly Size[],
  warmUpMs: WarmUp,
  how: Strategy,
): Plan {
  const ids = new Set(tasks.map((t) => t.id))
  const running = new Set<string>()
  for (const w of workers) for (const r of w.running) if (r.id !== undefined) running.add(r.id)
  const widest = Math.max(1, ...workers.map((w) => w.cores), ...candidates.map((c) => c.cpu))
  // Cores asked and had, all told and of each platform a task names: only
  // a worker of it runs such a task, so spare Linux cores left a Mac task
  // waiting for a Mac worker never started.
  let asked = 0
  let have = 0
  const askedOf = new Map<string, number>()
  const haveOf = new Map<string, number>()
  const add = (m: Map<string, number>, p: string | undefined, n: number): void => {
    if (p !== undefined) m.set(p, (m.get(p) ?? 0) + n)
  }
  for (const t of tasks)
    if (t.deps.every((d) => !ids.has(d) && !running.has(d))) {
      const cores = Math.min(t.cores, widest)
      asked += cores
      add(askedOf, t.platform, cores)
    }
  for (const w of workers)
    for (const r of w.running) {
      asked += r.cores
      add(askedOf, w.platform, r.cores)
    }
  for (const w of workers) {
    have += w.cores
    add(haveOf, w.platform, w.cores)
  }
  const short = (p: string | undefined): boolean =>
    p !== undefined && (haveOf.get(p) ?? 0) < (askedOf.get(p) ?? 0) - 1e-9
  const start: Size[] = []
  for (const c of candidates) {
    if (have >= asked - 1e-9 && !short(c.platform)) continue
    start.push(c)
    have += c.cpu
    add(haveOf, c.platform, c.cpu)
  }
  const release: string[] = []
  for (const w of workers)
    if (
      w.idle &&
      have - w.cores >= asked - 1e-9 &&
      (w.platform === undefined ||
        (haveOf.get(w.platform) ?? 0) - w.cores >= (askedOf.get(w.platform) ?? 0) - 1e-9)
    ) {
      release.push(w.id)
      have -= w.cores
      add(haveOf, w.platform, -w.cores)
    }
  const kept = [
    ...workers.filter((w) => !release.includes(w.id)),
    ...start.map((c, i): PlanWorker => ({
      id: `\0new${i}`,
      cores: c.cpu,
      memory: c.memory,
      platform: c.platform,
      size: c.name,
      at: warmOf(warmUpMs)(c.name),
      running: [],
      idle: false,
    })),
  ]
  const end = simulate(tasks, kept, how)
  return { start, release, endsInMs: end, boundMs: end, againInMs: undefined, drain: [] }
}
