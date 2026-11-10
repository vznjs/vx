// The planner on graph families, not on vx's own runs: a run should end
// at its longest chain after one warm-up, the critical path never
// waiting for a worker, on the least worker time that allows
// (2026-11-10). Exact history; seeded, so each number is fixed.
import { expect, it } from 'bun:test'
import { simulate, type SimTask } from './sim.js'

const WARM_UP_MS = 20_000

function rng(seed: number): () => number {
  let s = (seed % 2147483646) + 1
  return () => (s = (s * 48271) % 2147483647) / 2147483647
}

interface Task {
  readonly ms: number
  readonly cores: number
  readonly deps: readonly number[]
}

/** Each task on each earlier one with chance `p`: 1-100 units long, mostly 1 core. */
function random(r: () => number, n: number, p: number, cores: number): Task[] {
  return Array.from({ length: n }, (_, i) => ({
    ms: Math.round(1 + Math.exp(r() * Math.log(100))),
    cores: Math.min(cores, 1 + Math.floor(r() ** 2 * cores)),
    deps: Array.from({ length: i }, (_, j) => j).filter(() => r() < p),
  }))
}

/** Layers up to `w` wide, each task on 1-3 of the layer before. */
function layered(r: () => number, layers: number, w: number, cores: number): Task[] {
  const tasks: Task[] = []
  let prev: number[] = []
  for (let l = 0; l < layers; l++) {
    const cur: number[] = []
    for (let i = 1 + Math.floor(r() * w); i > 0; i--) {
      const deps =
        prev.length === 0
          ? []
          : [
              ...new Set(
                Array.from(
                  { length: 1 + Math.floor(r() * 3) },
                  () => prev[Math.floor(r() * prev.length)]!,
                ),
              ),
            ]
      cur.push(tasks.length)
      tasks.push({
        ms: Math.round(1 + Math.exp(r() * Math.log(60))),
        cores: Math.min(cores, 1 + Math.floor(r() ** 2 * cores)),
        deps,
      })
    }
    prev = cur
  }
  return tasks
}

/** A chain whose every other step needs a whole worker, beside long one-core fillers. */
function trap(r: () => number, steps: number, fillers: number, cores: number): Task[] {
  return [
    ...Array.from({ length: steps }, (_, i) => ({
      ms: Math.round(5 + r() * 10),
      cores: i % 2 === 0 ? 1 : cores,
      deps: i === 0 ? [] : [i - 1],
    })),
    ...Array.from({ length: fillers }, () => ({
      ms: Math.round(10 + r() * 40),
      cores: 1,
      deps: [],
    })),
  ]
}

// Over ten graphs a family, each ends past its chain and one warm-up by
// 1% on average and 8% at most, and its worker time on its floor (all
// its work on cores, one warm-up) is at most `cost`. Wall time first,
// then worker time (2026-11-10): the plan of fewest workers within 5%
// ended 0.6 to 2% late on average, 10% at most, for 1.30 to 1.57.
const families: [name: string, cores: number, make: (r: () => number) => Task[], cost: number][] = [
  ['random', 4, (r) => random(r, 40, 0.05, 4), 1.55],
  ['dense', 4, (r) => random(r, 80, 0.15, 4), 1.7],
  ['layered', 4, (r) => layered(r, 6, 12, 4), 1.7],
  ['wide', 8, (r) => layered(r, 3, 40, 8), 1.65],
  ['trap', 4, (r) => trap(r, 10, 30, 4), 1.55],
]

/** A family's graph `seed`, as run: how late past its chain and a warm-up, its worker time and floor. */
function run(cores: number, make: (r: () => number) => Task[], seed: number, unknown = 0) {
  // A unit is 3 s: tasks of 3 to 300 s.
  const tasks = make(rng(seed * 7919)).map((t) => ({ ...t, ms: t.ms * 3_000 }))
  const none = rng(seed * 104729)
  const graph: SimTask[] = tasks.map((t, i) => ({
    id: `t${i}`,
    deps: t.deps.map((d) => `t${d}`),
    exec: true,
    cache: true,
    ran: { ms: t.ms, cores: t.cores, memory: 1e8 },
    ...(none() < unknown ? { known: null } : {}),
  }))
  const tail: number[] = []
  for (let i = tasks.length - 1; i >= 0; i--) tail[i] = tasks[i]!.ms
  for (let i = tasks.length - 1; i >= 0; i--)
    for (const d of tasks[i]!.deps) tail[d] = Math.max(tail[d]!, tasks[d]!.ms + tail[i]!)
  const chain = Math.max(...tail)
  const r = simulate(graph, {
    sizes: [{ name: 'w', max: 1000, cpu: cores, memory: 64e9 }],
    warmUpMs: () => WARM_UP_MS,
    likely: new Set(graph.map((t) => t.id)),
  })
  return {
    late: (r.endMs - chain - WARM_UP_MS) / chain,
    spent: r.workers.reduce((a, w) => a + (w.leftAt ?? w.cancelledAt ?? r.endMs) - w.spawnedAt, 0),
    floor: tasks.reduce((a, t) => a + (t.ms * t.cores) / cores, 0) + WARM_UP_MS,
  }
}

for (const [name, cores, make, cost] of families)
  it(`${name} graphs end at their chain on little worker time`, () => {
    let spent = 0
    let floor = 0
    let late = 0
    for (let seed = 1; seed <= 10; seed++) {
      const r = run(cores, make, seed)
      expect(r.late).toBeLessThanOrEqual(0.08)
      late += r.late / 10
      spent += r.spent
      floor += r.floor
    }
    expect(late).toBeLessThanOrEqual(0.01)
    expect(spent / floor).toBeLessThanOrEqual(cost)
  })

// A third of the tasks of no history, each guessed at 30 s: a chain
// through one has no slack the plan can prove, so it starts as it gets
// ready. Waiting on the guess, the plan before ended 3.5 to 13% late on
// average (2026-11-10). A guessed task books what it guesses and slows
// what shares its worker, so one graph moves a family's average: wide
// seed 9 went from 12% to 18% with ready holds, while 30 more seeds
// went from 9.9% to 9.5%.
for (const [name, cores, make] of families)
  it(`${name} graphs a third unmeasured end within 7% of their chain`, () => {
    let late = 0
    for (let seed = 1; seed <= 10; seed++) late += run(cores, make, seed, 0.3).late / 10
    expect(late).toBeLessThanOrEqual(0.07)
  })
