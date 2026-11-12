// Seeded task graphs of five families and how the simulator runs them:
// what tests/sim-theory.test.ts holds the planner to, and what
// scripts/optimum.ts compares with the exact optimum.
import { simulate, type SimTask } from './sim.js'

export const WARM_UP_MS = 20_000

export function rng(seed: number): () => number {
  let s = (seed % 2147483646) + 1
  return () => (s = (s * 48271) % 2147483647) / 2147483647
}

export interface Task {
  readonly ms: number
  readonly cores: number
  readonly deps: readonly number[]
}

/** Each task on each earlier one with chance `p`: 1-100 units long, mostly 1 core. */
export function random(r: () => number, n: number, p: number, cores: number): Task[] {
  return Array.from({ length: n }, (_, i) => ({
    ms: Math.round(1 + Math.exp(r() * Math.log(100))),
    cores: Math.min(cores, 1 + Math.floor(r() ** 2 * cores)),
    deps: Array.from({ length: i }, (_, j) => j).filter(() => r() < p),
  }))
}

/** Layers up to `w` wide, each task on 1-3 of the layer before. */
export function layered(r: () => number, layers: number, w: number, cores: number): Task[] {
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
export function trap(r: () => number, steps: number, fillers: number, cores: number): Task[] {
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

/** A family's graph `seed`, as run: how late past its chain and a warm-up, its worker time and floor. */
export function run(
  cores: number,
  make: (r: () => number) => Task[],
  seed: number,
  unknown = 0,
  noise = 0,
) {
  // A unit is 3 s: tasks of 3 to 300 s.
  const tasks = make(rng(seed * 7919)).map((t) => ({ ...t, ms: t.ms * 3_000 }))
  const none = rng(seed * 104729)
  // Each ran its history times a factor within `noise` of 1.
  const off = rng(seed * 15485863)
  const ms = tasks.map((t) =>
    noise === 0 ? t.ms : Math.round(t.ms * (1 - noise + 2 * noise * off())),
  )
  const graph: SimTask[] = tasks.map((t, i) => ({
    id: `t${i}`,
    deps: t.deps.map((d) => `t${d}`),
    exec: true,
    cache: true,
    ran: { ms: ms[i]!, cores: t.cores, memory: 1e8 },
    ...(none() < unknown
      ? { known: null }
      : noise === 0
        ? {}
        : { known: { ms: t.ms, cores: t.cores, memory: 1e8 } }),
  }))
  const tail: number[] = []
  for (let i = tasks.length - 1; i >= 0; i--) tail[i] = ms[i]!
  for (let i = tasks.length - 1; i >= 0; i--)
    for (const d of tasks[i]!.deps) tail[d] = Math.max(tail[d]!, ms[d]! + tail[i]!)
  const chain = Math.max(...tail)
  const r = simulate(graph, {
    sizes: [{ name: 'w', max: 1000, cpu: cores, memory: 64e9 }],
    warmUpMs: () => WARM_UP_MS,
    likely: new Set(graph.map((t) => t.id)),
  })
  return {
    late: (r.endMs - chain - WARM_UP_MS) / chain,
    lateMs: r.endMs - chain - WARM_UP_MS,
    chain,
    spent: r.workers.reduce((a, w) => a + (w.leftAt ?? w.cancelledAt ?? r.endMs) - w.spawnedAt, 0),
    floor: tasks.reduce((a, t, i) => a + (ms[i]! * t.cores) / cores, 0) + WARM_UP_MS,
  }
}
