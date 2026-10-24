// Two goals for how many workers a run starts, played on `sim.ts` (M,
// 2026-10-24), and the known algorithms for each:
// - wall time: end the run soonest (today's planner);
// - compute: spend no more runner time than one worker would, and start
//   more only when that makes the run faster; else one.
// Runner time is every job's, from its start to its end: the warm-up
// counts, and so does the orchestrator's job, which waits the whole run.
// Sim only: the real planner is unchanged until M picks.

import { simulate as playPlan, type PlanTask, type Size } from '../src/planner.js'
import { DEFAULT_STRATEGY } from '../src/strategy.js'
import { simulate, type ScaleState, type SimOptions, type SimResult, type SimTask } from './sim.js'

export interface Outcome {
  readonly strategy: string
  readonly wallMs: number
  /** Every worker's ms from its start to its end, warm-up included. */
  readonly workerMs: number
  /** `workerMs` and the orchestrator's job, which runs from the start to the end. */
  readonly runnerMs: number
  /** GitHub's bill: each job rounded up to a whole minute. */
  readonly billedMin: number
  readonly workers: number
}

export function outcome(strategy: string, r: SimResult): Outcome {
  let workerMs = 0
  let billedMin = Math.ceil(r.endMs / 60_000)
  let workers = 0
  for (const w of r.workers) {
    const end = w.leftAt ?? w.cancelledAt ?? r.endMs
    workerMs += end - w.spawnedAt
    billedMin += Math.ceil((end - w.spawnedAt) / 60_000)
    if (w.joinedAt !== undefined) workers++
  }
  return {
    strategy,
    wallMs: r.endMs,
    workerMs,
    runnerMs: workerMs + r.endMs,
    billedMin,
    workers,
  }
}

const capped = (sizes: readonly Size[], n: number): Size[] =>
  sizes.map((s) => ({ ...s, max: Math.min(s.max, n) }))

/** Each platform's one worker: the compute goal's budget. */
export function oneWorker(graph: readonly SimTask[], o: SimOptions): Outcome {
  return outcome('1 worker', simulate(graph, { ...o, sizes: capped(o.sizes, 1) }))
}

/** Today's planner: the fewest workers that end the known work near its best (wall time). */
export function planner(graph: readonly SimTask[], o: SimOptions): Outcome {
  return outcome('wall: planner (HEFT rank, best-fit)', simulate(graph, o))
}

/** Spark's dynamic allocation: enough cores for what is ready or running (wall time). */
export function backlog(graph: readonly SimTask[], o: SimOptions): Outcome {
  return outcome(
    'wall: backlog (Spark)',
    simulate(graph, { ...o, how: { ...DEFAULT_STRATEGY, scale: 'backlog' } }),
  )
}

/**
 * The compute goal decided before the run, from history: the planner's own
 * list schedule (`planner.simulate`: critical-path rank, best-fit) gives
 * each worker count's end, which costs that many warm-ups and the run's
 * jobs; the fastest count within one worker's cost runs, capped there.
 * Cost-aware workflow scheduling's budget-constrained choice (as in
 * Malawski SC'12, Rodriguez and Buyya's budget-and-deadline line).
 */
export function budgeted(graph: readonly SimTask[], o: SimOptions): Outcome {
  const warmUp = o.warmUpMs?.(1) ?? 20_000
  const tasks = planTasksOf(graph, o.home)
  const cost = (n: number): { end: number; ms: number } => {
    // A size gets no more workers than it has tasks for.
    const of = (s: Size): number => tasks.filter((t) => t.platform === s.platform).length
    const workers = o.sizes.flatMap((s) =>
      Array.from({ length: Math.min(s.max, n, of(s)) }, (_, i) => ({
        id: `${s.name}${i}`,
        cores: s.cpu,
        memory: s.memory,
        platform: s.platform,
        at: warmUp,
        running: [],
        idle: true,
      })),
    )
    const end = playPlan(tasks, workers)
    // Each worker runs from its start to the end; the orchestrator's job too.
    return { end, ms: workers.length * end + end }
  }
  const max = Math.max(...o.sizes.map((s) => s.max))
  const one = cost(1)
  let pick = 1
  let best = one.end
  for (let n = 2; n <= max; n++) {
    const c = cost(n)
    if (c.ms <= one.ms && c.end < best) {
      pick = n
      best = c.end
    }
  }
  return outcome(
    `compute: budgeted list schedule (${pick} max)`,
    simulate(graph, { ...o, sizes: capped(o.sizes, pick) }),
  )
}

/**
 * The compute goal decided as the run goes, as a cost-aware autoscaler:
 * one worker per platform first; another starts only when the work queued
 * past what the started workers will take within a warm-up would keep the
 * new one busy for longer than its own warm-up costs, so it pays for
 * itself in the orchestrator's time saved (Kubernetes' cluster autoscaler
 * scales on pending work; this adds the warm-up as the price). An idle
 * worker with nothing queued for it leaves.
 */
export function payForItself(graph: readonly SimTask[], o: SimOptions): Outcome {
  const scaler = (s: ScaleState): { start: Size[]; release: string[] } => {
    const start: Size[] = []
    const release: string[] = []
    for (const size of s.sizes) {
      const mine = s.workers.filter((w) => w.platform === size.platform)
      const queued = s.queued.filter((q) => (q.platform ?? size.platform) === size.platform)
      if (mine.length === 0) {
        if (queued.length > 0) start.push(size)
        continue
      }
      const cores = mine.reduce((n, w) => n + w.cores, 0)
      // Core-ms the started workers owe: what runs and what waits.
      const owed =
        mine.reduce((n, w) => n + w.left.reduce((a, b) => a + b, 0), 0) +
        queued.reduce((n, q) => n + q.ms * q.cores, 0)
      // What is still queued once the warm-up has passed, per new core.
      const past = Math.max(0, owed - cores * s.warmUpMs)
      const share = (past * size.cpu) / (cores + size.cpu) / size.cpu
      if (mine.length < size.max && share > 2 * s.warmUpMs) start.push(size)
      if (queued.length === 0)
        for (const w of mine) if (w.joined && w.left.length === 0) release.push(w.id)
    }
    return { start, release }
  }
  return outcome('compute: pay-for-itself autoscaler', simulate(graph, { ...o, scaler }))
}

/**
 * The compute goal's best answer, known only after the run: each worker
 * count played out, the fastest within one worker's cost. The bound the
 * other two are measured against.
 */
export function oracle(graph: readonly SimTask[], o: SimOptions, one: Outcome): Outcome {
  const max = Math.max(...o.sizes.map((s) => s.max))
  let pick = one
  for (let n = 2; n <= max; n++) {
    const r = outcome('', simulate(graph, { ...o, sizes: capped(o.sizes, n) }))
    if (r.runnerMs <= one.runnerMs && r.wallMs < pick.wallMs) pick = { ...r, strategy: `${n}` }
  }
  return { ...pick, strategy: `compute: oracle (${pick === one ? 1 : pick.strategy} max)` }
}

/** The graph's misses as the planner's tasks, each waiting only on misses. */
function planTasksOf(graph: readonly SimTask[], home: string | undefined): PlanTask[] {
  const byId = new Map(graph.map((t) => [t.id, t]))
  const up = (id: string, seen: Set<string>): string[] =>
    byId.get(id)!.deps.flatMap((d) => {
      if (seen.has(d) || !byId.has(d)) return []
      seen.add(d)
      return byId.get(d)!.ran === undefined ? up(d, seen) : [d]
    })
  return graph.flatMap((t) => {
    const k = t.known === undefined ? t.ran : (t.known ?? undefined)
    if (t.ran === undefined || !t.exec) return []
    return [
      {
        id: t.id,
        cores: Math.max(0.25, k?.cores ?? 1),
        memory: k?.memory ?? 0,
        ms: k?.ms ?? 20_000,
        deps: up(t.id, new Set()),
        platform: t.platform ?? home,
      },
    ]
  })
}
