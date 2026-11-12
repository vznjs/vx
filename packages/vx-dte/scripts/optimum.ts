#!/usr/bin/env bun
// How far the planner is from the least worker time a run can hold: small
// graphs of each family, played by the simulator, written with what the
// run held, for scripts/optimum.py to solve exactly (CP-SAT) and compare.
// The model: one worker size, each worker a warm-up long before its first
// task, every run by its chain and one warm-up; worker time is cores times
// its life, warm-up counted.
//
//   bun packages/vx-dte/scripts/optimum.ts > graphs.json [--seeds 10]
//   python3 packages/vx-dte/scripts/optimum.py graphs.json [seconds a graph]

import { parseArgs } from 'node:util'
import { layered, random, rng, trap, WARM_UP_MS, type Task } from '../tests/families.js'
import { simulate, type SimTask } from '../tests/sim.js'

const { values } = parseArgs({ options: { seeds: { type: 'string', default: '10' } } })

// Small enough for the solver to prove most optimal in seconds.
const families: [string, number, (r: () => number) => Task[]][] = [
  ['random', 4, (r) => random(r, 12, 0.15, 4)],
  ['dense', 4, (r) => random(r, 14, 0.3, 4)],
  ['layered', 4, (r) => layered(r, 3, 5, 4)],
  ['wide', 8, (r) => layered(r, 2, 10, 8)],
  ['trap', 4, (r) => trap(r, 6, 8, 4)],
]

const out = []
for (const [name, cores, make] of families)
  for (let seed = 1; seed <= Number(values.seeds); seed++) {
    // A unit is 3 s, as in tests/sim-theory.test.ts.
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
    const r = simulate(graph, {
      sizes: [{ name: 'w', max: 1000, cpu: cores, memory: 64e9 }],
      warmUpMs: () => WARM_UP_MS,
      likely: new Set(graph.map((t) => t.id)),
    })
    const held = r.workers.reduce(
      (a, w) => a + w.cores * ((w.leftAt ?? w.cancelledAt ?? r.endMs) - w.spawnedAt),
      0,
    )
    out.push({
      name,
      seed,
      cores,
      warm: WARM_UP_MS / 1000,
      chain: Math.max(...tail) / 1000,
      tasks: tasks.map((t) => ({ d: t.ms / 1000, c: t.cores, deps: t.deps })),
      ours: { end: r.endMs / 1000, held: held / 1000, workers: r.workers.length },
    })
  }
console.log(JSON.stringify(out))
