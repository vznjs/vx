// The landing graph's run (src/data/hero-run.json): a 10-task workspace
// played by vx-dte's own simulator (packages/vx-dte/tests/sim.ts), the
// planner and placing the plugin runs. Every worker start, join, task and
// leave the hero shows is when this run had it. `bun scripts/hero-run.ts`.

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { simulate, type SimTask } from '../../../packages/vx-dte/tests/sim.ts'

const s = 1000
const GB = 1e9
// Three libraries and an app: a build waits on the builds it imports, a
// test or e2e on its own build. How each miss ran (s, cores); the rest hit.
const TASKS: [string, string[], [number, number]?][] = [
  ['utils#build', [], [9, 2]],
  ['utils#lint', []],
  ['core#build', ['utils#build'], [24, 3]],
  ['core#test', ['core#build'], [38, 2]],
  ['ui#build', ['utils#build'], [14, 2]],
  ['ui#lint', []],
  ['web#build', ['core#build', 'ui#build'], [30, 4]],
  ['web#test', ['web#build'], [22, 2]],
  ['web#e2e', ['web#build'], [34, 2]],
  ['web#lint', []],
]
const graph: SimTask[] = TASKS.map(([id, deps, r]) => ({
  id,
  deps,
  exec: true,
  cache: true,
  ...(r ? { ran: { ms: r[0] * s, cores: r[1], memory: 2 * GB } } : {}),
}))
if (graph.length !== 10) throw new Error(`${graph.length} tasks`)

// Warm-ups vary, as CI runners do.
const WARM = [21, 26, 18, 24, 29, 20]
const r = simulate(graph, {
  sizes: [{ name: 'linux-4', max: 6, cpu: 4, memory: 16 * GB }],
  warmUpMs: (n) => WARM[(n - 1) % WARM.length]! * s,
  likely: new Set(TASKS.filter((x) => x[2]).map((x) => x[0])),
})

const byTask = new Map<string, string>()
for (const w of r.workers) for (const t of w.ran) byTask.set(t, w.id)
const out = {
  endMs: Math.round(r.endMs),
  tasks: graph.map((t) => ({
    id: t.id,
    deps: t.deps,
    ...(t.ran
      ? {
          cores: t.ran.cores,
          worker: byTask.get(t.id)!,
          startMs: Math.round(r.startedAt.get(t.id)!),
          endMs: Math.round(r.endedAt.get(t.id)!),
        }
      : { hit: true }),
  })),
  workers: r.workers.map((w) => ({
    id: w.id,
    cores: w.cores,
    spawnMs: Math.round(w.spawnedAt),
    joinMs: w.joinedAt === undefined ? null : Math.round(w.joinedAt),
    leaveMs: Math.round(w.leftAt ?? w.cancelledAt ?? r.endMs),
  })),
}
writeFileSync(
  path.resolve(import.meta.dir, '../src/data/hero-run.json'),
  `${JSON.stringify(out, null, 2)}\n`,
)
console.log(
  `end ${out.endMs / s} s, ${out.workers.length} workers, utilization ${r.utilization.toFixed(2)}`,
)
for (const w of out.workers) console.log(w)
