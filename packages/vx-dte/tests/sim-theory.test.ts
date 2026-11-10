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

// Each family's worker time, over five graphs, on its floor (all its
// work on cores, one warm-up): the plan this replaced cost 1.63, 1.62,
// 1.59, 1.40 and 2.55, and ended 1% late on average, 4% at most.
const families: [name: string, cores: number, make: (r: () => number) => Task[], cost: number][] = [
  ['random', 4, (r) => random(r, 40, 0.05, 4), 1.45],
  ['dense', 4, (r) => random(r, 80, 0.15, 4), 1.9],
  ['layered', 4, (r) => layered(r, 6, 12, 4), 1.75],
  ['wide', 8, (r) => layered(r, 3, 40, 8), 1.55],
  ['trap', 4, (r) => trap(r, 10, 30, 4), 1.65],
]

for (const [name, cores, make, cost] of families)
  it(`${name} graphs end at their chain on little worker time`, () => {
    let spentAll = 0
    let floorAll = 0
    for (const seed of [1, 2, 3, 4, 5]) {
      // A unit is 3 s: tasks of 3 to 300 s.
      const tasks = make(rng(seed * 7919)).map((t) => ({ ...t, ms: t.ms * 3_000 }))
      const graph: SimTask[] = tasks.map((t, i) => ({
        id: `t${i}`,
        deps: t.deps.map((d) => `t${d}`),
        exec: true,
        cache: true,
        ran: { ms: t.ms, cores: t.cores, memory: 1e8 },
      }))
      const tail: number[] = []
      for (let i = tasks.length - 1; i >= 0; i--) tail[i] = tasks[i]!.ms
      for (let i = tasks.length - 1; i >= 0; i--)
        for (const d of tasks[i]!.deps) tail[d] = Math.max(tail[d]!, tasks[d]!.ms + tail[i]!)
      const chain = Math.max(...tail)
      const work = tasks.reduce((a, t) => a + (t.ms * t.cores) / cores, 0)
      const r = simulate(graph, {
        sizes: [{ name: 'w', max: 1000, cpu: cores, memory: 64e9 }],
        warmUpMs: () => WARM_UP_MS,
        likely: new Set(graph.map((t) => t.id)),
      })
      const spent = r.workers.reduce(
        (a, w) => a + (w.leftAt ?? w.cancelledAt ?? r.endMs) - w.spawnedAt,
        0,
      )
      // A worker's warm-up past the chain, and 2.5% for a planned place a
      // task's first worker could not give it (trap, seed 1).
      expect(r.endMs).toBeLessThanOrEqual(chain * 1.025 + WARM_UP_MS)
      spentAll += spent
      floorAll += work + WARM_UP_MS
    }
    expect(spentAll / floorAll).toBeLessThanOrEqual(cost)
  })
