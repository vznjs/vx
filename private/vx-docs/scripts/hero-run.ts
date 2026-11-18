// The landing graph's run (src/data/hero-run.json): a 30-task workspace
// played by vx-dte's own simulator (packages/vx-dte/tests/sim.ts), the
// planner and placing the plugin runs. Every worker start, join, task and
// leave the hero shows is when this run had it. `bun scripts/hero-run.ts`.

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { simulate, type SimTask } from '../../../packages/vx-dte/tests/sim.ts'

const s = 1000
const GB = 1e9
// Five libraries and two apps. A lib's build waits on the builds it imports;
// typecheck on them too; test on its own build; an app's e2e on its build.
const libs: Record<string, string[]> = {
  utils: [],
  schema: ['utils'],
  core: ['utils', 'schema'],
  ui: ['utils'],
  api: ['core', 'schema'],
}
const apps: Record<string, string[]> = { web: ['ui', 'core'], admin: ['ui', 'api'] }
// How each task ran when it missed (s, cores); a task missing here hit.
const RAN: Record<string, [number, number]> = {
  'utils#build': [9, 2],
  'schema#build': [12, 2],
  'core#build': [24, 3],
  'core#test': [38, 2],
  'core#typecheck': [14, 1.5],
  'api#build': [18, 2],
  'api#test': [31, 2],
  'api#typecheck': [11, 1.5],
  'api#lint': [8, 1],
  'web#build': [34, 4],
  'web#test': [22, 2],
  'web#typecheck': [16, 1.5],
  'web#e2e': [41, 2],
  'admin#build': [27, 3],
  'admin#test': [19, 2],
  'admin#typecheck': [13, 1.5],
  'admin#lint': [9, 1],
  'admin#e2e': [36, 2],
}

const graph: SimTask[] = []
const add = (id: string, deps: string[]): void => {
  const r = RAN[id]
  graph.push({
    id,
    deps,
    exec: true,
    cache: true,
    ...(r ? { ran: { ms: r[0] * s, cores: r[1], memory: 2 * GB } } : {}),
  })
}
for (const [name, up] of [...Object.entries(libs), ...Object.entries(apps)]) {
  const builds = up.map((u) => `${u}#build`)
  add(`${name}#build`, builds)
  add(`${name}#typecheck`, builds)
  add(`${name}#lint`, [])
  add(`${name}#test`, [`${name}#build`])
  if (name in apps) add(`${name}#e2e`, [`${name}#build`])
}
if (graph.length !== 30) throw new Error(`${graph.length} tasks`)

// Warm-ups vary, as CI runners do.
const WARM = [21, 26, 18, 24, 29, 20]
const r = simulate(graph, {
  sizes: [{ name: 'linux-4', max: 6, cpu: 4, memory: 16 * GB }],
  warmUpMs: (n) => WARM[(n - 1) % WARM.length]! * s,
  likely: new Set(Object.keys(RAN)),
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
