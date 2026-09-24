// Scheduler policy benchmark: does a task with NO history deserve to run
// FIRST (Nx's rule, `tasks-schedule.spec.ts:497`, held here over the whole
// ranking where Nx applies it only as its last tie-break) rather than at the
// workspace median `@vzn/vx-schedule-history` gives it today? Parity row
// N-M7, item 669.
//
//   bun packages/vx-bench/schedule-policy.ts [--md] [--seeds N]
//
// A deterministic discrete-event simulation of `runGraph`'s exec tier.
// The priorities are the REAL ones: `criticalPathPriorities` from the
// plugin, merged over core's `computeReverseDepCount` by core's own
// `mergePriorities`. Only the dispatch loop is mirrored from
// `packages/vx/src/graph/scheduler.ts`, and `tests/schedule-policy.test.ts`
// replays the fixtures through the real `runGraph` on a virtual clock to
// hold the mirror to it. What is mirrored:
//   - `ReadyHeap`: highest priority first; equal priorities break by
//     ENQUEUE order (roots in graph-insertion order at startup, a
//     dependent when its last dep finishes) — not insertion order.
//   - completion: each finished task enqueues its ready dependents and
//     then dispatches (`finishOne` + `tick`) before the next completion
//     is seen, so of two tasks ending at the same instant the first to
//     have STARTED settles and fills the free worker first.
// No cache, no admission, no restore tier: every task runs, which is the
// case where order matters.
//
// The Learn page's scheduler simulator (packages/vx-docs, item 685) imports
// this module into the browser, so everything it reaches at run time must
// stay platform-free: the two ranking files below import only types, and
// the report at the bottom runs only under `import.meta.main`.

import type { HistoryTable, TaskHistory, TaskNode } from '@vzn/vx'
// Source files, not the packages' entry points: the sim must rank exactly
// as core and the plugin rank, and either entry point loads all of core.
import { computeReverseDepCount, mergePriorities } from '../vx/src/graph/priorities.js'
import { criticalPathPriorities } from '../vx-schedule-history/src/critical-path.js'

export type Policy = 'count' | 'median' | 'unknown-first' | 'oracle'
export const POLICIES: readonly Policy[] = ['count', 'median', 'unknown-first', 'oracle']

export interface SimTask {
  readonly id: string
  readonly deps: readonly string[]
  /** The TRUE duration in ms; the policy sees it only through history. */
  readonly dur: number
}

export interface SimSpan {
  readonly id: string
  readonly start: number
  readonly end: number
}

export interface SimResult {
  readonly makespan: number
  /** Task ids in dispatch order. */
  readonly order: readonly string[]
  /** When each task ran, in dispatch order: what a Gantt chart draws. */
  readonly spans: readonly SimSpan[]
}

function taskNode(t: SimTask): TaskNode {
  return {
    id: t.id,
    projectName: t.id,
    projectDir: `/sim/${t.id}`,
    taskName: 'task',
    config: { exec: { command: 'true' } } as TaskNode['config'],
    deps: [...t.deps],
    requested: true,
  }
}

function known(p50: number): TaskHistory {
  return {
    runs: 5,
    p50DurationMs: p50,
    p99DurationMs: p50,
    successRate: 1,
    hitRate: 0,
    failureMode: 'stable',
  }
}

export function nodeMap(tasks: readonly SimTask[]): Map<string, TaskNode> {
  return new Map(tasks.map((t) => [t.id, taskNode(t)]))
}

/**
 * What the plugin's `schedule` hook would hand `runGraph` under `policy`
 * (`undefined` for `count`: no plugin), where `unknown` holds the tasks
 * the history has never seen and every other task's p50 is its true
 * duration.
 *
 * `unknown-first` passes an `assume` duration for each unknown task one
 * above the longest KNOWN remaining critical path (unknowns counted as 0),
 * so any task with an unknown on its remaining path outranks every task
 * without one, and two unknowns outrank one. Finite, not `Infinity`: the
 * plugin SUMS durations down a path, and `mergePriorities` multiplies by
 * 2^20 and adds the count tie-break, which a sum of infinities would erase.
 */
export function pluginPriorities(
  policy: Policy,
  tasks: readonly SimTask[],
  unknown: ReadonlySet<string>,
): ReadonlyMap<string, number> | undefined {
  if (policy === 'count') return undefined
  const list = [...nodeMap(tasks).values()]
  const history = new Map<string, TaskHistory>()
  for (const t of tasks) {
    if (policy === 'oracle' || !unknown.has(t.id)) history.set(t.id, known(t.dur))
  }
  const table: HistoryTable = history
  if (policy !== 'unknown-first') return criticalPathPriorities(list, table)
  const zero: Record<string, number> = {}
  for (const id of unknown) zero[id] = 0
  let longestKnown = 0
  for (const v of criticalPathPriorities(list, table, zero).values()) {
    if (v > longestKnown) longestKnown = v
  }
  const assume: Record<string, number> = {}
  for (const id of unknown) assume[id] = longestKnown + 1
  return criticalPathPriorities(list, table, assume)
}

/** The ranking `runGraph` derives from `pluginPriorities`: core's merge over core's baseline. */
export function priorities(
  policy: Policy,
  tasks: readonly SimTask[],
  unknown: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const baseline = computeReverseDepCount(nodeMap(tasks))
  const plugin = pluginPriorities(policy, tasks, unknown)
  return plugin === undefined ? baseline : mergePriorities(baseline, plugin)
}

/** Greedy list scheduling of `tasks` on `workers`, ranked by `priority`. */
export function simulate(
  tasks: readonly SimTask[],
  priority: ReadonlyMap<string, number>,
  workers: number,
): SimResult {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const dependents = new Map<string, string[]>()
  const pending = new Map<string, number>()
  for (const t of tasks) {
    pending.set(t.id, t.deps.length)
    for (const d of t.deps) {
      const list = dependents.get(d)
      if (list) list.push(t.id)
      else dependents.set(d, [t.id])
    }
  }
  // (priority DESC, enqueue seq ASC) — `ReadyHeap.higher`. A linear scan
  // is exact and the graphs are small enough.
  const ready: Array<{ id: string; seq: number }> = []
  let seq = 0
  const push = (id: string): void => {
    ready.push({ id, seq: seq++ })
  }
  const pop = (): string => {
    let best = 0
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i]!
      const b = ready[best]!
      const pa = priority.get(a.id) ?? 0
      const pb = priority.get(b.id) ?? 0
      if (pa > pb || (pa === pb && a.seq < b.seq)) best = i
    }
    return ready.splice(best, 1)[0]!.id
  }
  for (const t of tasks) if (t.deps.length === 0) push(t.id)

  const running: Array<{ id: string; end: number; started: number }> = []
  const order: string[] = []
  const spans: SimSpan[] = []
  let now = 0
  let makespan = 0
  const tick = (): void => {
    while (running.length < workers && ready.length > 0) {
      const id = pop()
      const end = now + byId.get(id)!.dur
      running.push({ id, end, started: order.length })
      order.push(id)
      spans.push({ id, start: now, end })
    }
  }
  tick()
  while (running.length > 0) {
    let next = 0
    for (let i = 1; i < running.length; i++) {
      const a = running[i]!
      const b = running[next]!
      if (a.end < b.end || (a.end === b.end && a.started < b.started)) next = i
    }
    const done = running.splice(next, 1)[0]!
    now = done.end
    makespan = Math.max(makespan, now)
    for (const d of dependents.get(done.id) ?? []) {
      const left = pending.get(d)! - 1
      pending.set(d, left)
      if (left === 0) push(d)
    }
    tick()
  }
  if (order.length !== tasks.length) throw new Error('simulate: the graph has a cycle')
  return { makespan, order, spans }
}

// --- Graphs -----------------------------------------------------------------

/** mulberry32: small, seeded, and the same on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Log-normal ms, median 1 s, σ = 1 (a 10× spread covers ~95 %), clamped to [10 ms, 60 s]. */
function duration(rand: () => number): number {
  const u = Math.max(rand(), 1e-12)
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
  return Math.min(60_000, Math.max(10, Math.round(1000 * Math.exp(z))))
}

export interface Shape {
  readonly name: string
  readonly workers: number
  /** Structure is seeded too, so a layered graph differs per seed. */
  readonly build: (rand: () => number) => Array<{ id: string; deps: string[] }>
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

function layered(layers: number, width: number) {
  return (rand: () => number) => {
    const out: Array<{ id: string; deps: string[] }> = []
    for (let l = 0; l < layers; l++) {
      for (let i = 0; i < width; i++) {
        const deps = new Set<string>()
        if (l > 0) {
          const fan = 1 + Math.floor(rand() * 3)
          for (let k = 0; k < fan; k++) deps.add(`L${l - 1}.${Math.floor(rand() * width)}`)
        }
        out.push({ id: `L${l}.${i}`, deps: [...deps] })
      }
    }
    return out
  }
}

/**
 * A package monorepo: each package's build waits on its dependencies'
 * builds, its test on its own build, its lint on nothing — the shape a
 * new package (or a new task on every package) lands in.
 */
function monorepo(packages: number) {
  return (rand: () => number) => {
    const out: Array<{ id: string; deps: string[] }> = []
    for (let p = 0; p < packages; p++) {
      const deps = new Set<string>()
      if (p > 0) {
        const fan = Math.floor(rand() * 4)
        for (let k = 0; k < fan; k++) deps.add(`p${Math.floor(rand() * p)}#build`)
      }
      out.push({ id: `p${p}#build`, deps: [...deps] })
      out.push({ id: `p${p}#test`, deps: [`p${p}#build`] })
      out.push({ id: `p${p}#lint`, deps: [] })
    }
    return out
  }
}

export const SHAPES: readonly Shape[] = [
  {
    name: 'deep-chain(200)',
    workers: 8,
    build: () => range(200).map((i) => ({ id: `c${i}`, deps: i === 0 ? [] : [`c${i - 1}`] })),
  },
  {
    name: 'wide-fan(500)',
    workers: 8,
    build: () => [
      { id: 'root', deps: [] },
      ...range(500).map((i) => ({ id: `f${i}`, deps: ['root'] })),
    ],
  },
  {
    name: 'diamond(200)',
    workers: 8,
    build: () => [
      { id: 'top', deps: [] },
      ...range(200).map((i) => ({ id: `m${i}`, deps: ['top'] })),
      { id: 'bottom', deps: range(200).map((i) => `m${i}`) },
    ],
  },
  {
    name: 'work-bound(400/8w)',
    workers: 8,
    build: () => range(400).map((i) => ({ id: `w${i}`, deps: [] })),
  },
  {
    name: 'cp-bound(60chain+300filler)',
    workers: 4,
    build: () => [
      ...range(300).map((i) => ({ id: `f${i}`, deps: [] })),
      ...range(60).map((i) => ({ id: `c${i}`, deps: i === 0 ? [] : [`c${i - 1}`] })),
    ],
  },
  { name: 'mixed-layered(20x40/8w)', workers: 8, build: layered(20, 40) },
  { name: 'mixed-layered(30x60/12w)', workers: 12, build: layered(30, 60) },
  { name: 'mixed-layered(40x50/16w)', workers: 16, build: layered(40, 50) },
  { name: 'monorepo(200pkg/8w)', workers: 8, build: monorepo(200) },
]

/** Fraction of tasks the history has never seen. 5–25 % is the warm repo that gained a task. */
const MASKS: readonly number[] = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1]

export interface Instance {
  readonly tasks: SimTask[]
  readonly unknown: Set<string>
}

/** One seeded graph + true durations + history mask; the same for every policy. */
export function instance(shape: Shape, seed: number, unknownFraction: number): Instance {
  const structure = prng(seed * 7919 + 1)
  const durs = prng(seed * 104_729 + 2)
  const mask = prng(seed * 1_299_709 + 3)
  const tasks = shape.build(structure).map((t) => ({ ...t, dur: duration(durs) }))
  const ids = tasks.map((t) => t.id)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(mask() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
  }
  return { tasks, unknown: new Set(ids.slice(0, Math.round(unknownFraction * ids.length))) }
}

// --- Report -----------------------------------------------------------------

interface Cell {
  shape: string
  workers: number
  tasks: number
  mask: number
  medianMs: number
  /** Per policy: mean and worst (largest) Δ% makespan against `median`. */
  delta: Record<Policy, { mean: number; worst: number }>
}

function run(seeds: number): Cell[] {
  const cells: Cell[] = []
  for (const shape of SHAPES) {
    for (const mask of MASKS) {
      const deltas: Record<Policy, number[]> = {
        count: [],
        median: [],
        'unknown-first': [],
        oracle: [],
      }
      let medianSum = 0
      let size = 0
      for (let seed = 1; seed <= seeds; seed++) {
        const { tasks, unknown } = instance(shape, seed, mask)
        size = tasks.length
        const ms = {} as Record<Policy, number>
        for (const p of POLICIES) {
          ms[p] = simulate(tasks, priorities(p, tasks, unknown), shape.workers).makespan
        }
        medianSum += ms.median
        for (const p of POLICIES) deltas[p].push(((ms[p] - ms.median) / ms.median) * 100)
      }
      const delta = {} as Cell['delta']
      for (const p of POLICIES) {
        const d = deltas[p]
        delta[p] = { mean: d.reduce((a, b) => a + b, 0) / d.length, worst: Math.max(...d) }
      }
      cells.push({
        shape: shape.name,
        workers: shape.workers,
        tasks: size,
        mask,
        medianMs: Math.round(medianSum / seeds),
        delta,
      })
    }
  }
  return cells
}

const pct = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(2)}`

function report(cells: readonly Cell[], seeds: number): string {
  const head = [
    'graph',
    'w',
    'tasks',
    'unknown',
    'ms:median',
    'Δ% unknown-first mean/worst',
    'Δ% count mean/worst',
    'Δ% oracle mean/worst',
  ]
  const rows = cells.map((c) => [
    c.shape,
    String(c.workers),
    String(c.tasks),
    `${Math.round(c.mask * 100)}%`,
    String(c.medianMs),
    `${pct(c.delta['unknown-first'].mean)} / ${pct(c.delta['unknown-first'].worst)}`,
    `${pct(c.delta.count.mean)} / ${pct(c.delta.count.worst)}`,
    `${pct(c.delta.oracle.mean)} / ${pct(c.delta.oracle.worst)}`,
  ])
  const realistic = cells.filter((c) => c.mask > 0 && c.mask <= 0.25)
  const meanOf = (xs: readonly Cell[], f: (c: Cell) => number): number =>
    xs.reduce((a, c) => a + f(c), 0) / xs.length
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map((_, i) => (i === 0 ? '---' : '--:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
    `${seeds} seeds per cell; Δ% is makespan against \`median\` (negative = faster), mean and`,
    'worst (largest) over the seeds.',
    '',
    `- realistic masks (5–25 % unknown), mean of the cell means: unknown-first ${pct(meanOf(realistic, (c) => c.delta['unknown-first'].mean))} %, oracle ${pct(meanOf(realistic, (c) => c.delta.oracle.mean))} %, count ${pct(meanOf(realistic, (c) => c.delta.count.mean))} %`,
    `- unknown-first, worst cell mean over ALL cells: ${pct(Math.max(...cells.map((c) => c.delta['unknown-first'].mean)))} %; worst single seed: ${pct(Math.max(...cells.map((c) => c.delta['unknown-first'].worst)))} %`,
  ]
  return lines.join('\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--seeds')
  const seeds = at === -1 ? 30 : Number(args[at + 1])
  const out = report(run(seeds), seeds)
  process.stdout.write(`${args.includes('--md') ? out : out.replaceAll('|', ' ')}\n`)
}
