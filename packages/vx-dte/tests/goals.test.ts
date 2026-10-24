// The wall-time goal against the compute goal (tests/goals.ts), on main's
// runs and on shapes main does not have. The table it prints is the
// comparison; what it asserts holds by each rule's construction.

import { describe, expect, it } from 'bun:test'
import type { Size } from '../src/planner.js'
import a09 from './fixtures/main-run-a09b987.json'
import f2163 from './fixtures/main-run-2026-10-23.json'
import cold26434 from './fixtures/main-run-26434e7-cold.json'
import {
  backlog,
  budgeted,
  oneWorker,
  oracle,
  type Outcome,
  payForItself,
  planner,
} from './goals.js'
import type { SimOptions, SimTask } from './sim.js'

const small: Size = { name: 'small', max: 12, cpu: 4, memory: 16e9 }

interface Fixture {
  readonly nodes: readonly {
    id: string
    deps: string[]
    exec: boolean
    cache: boolean
    platform?: string
  }[]
  readonly ran: Record<string, readonly number[]>
}

const load = (f: Fixture): SimTask[] =>
  f.nodes.map((n) => {
    const r = f.ran[n.id]
    return r === undefined ? n : { ...n, ran: { ms: r[0]!, cores: r[1]!, memory: r[2]! * 1e6 } }
  })

const task = (id: string, deps: string[], ms: number, cores = 1, platform?: string): SimTask => ({
  id,
  deps,
  exec: true,
  cache: true,
  ran: { ms, cores, memory: 5e8 },
  ...(platform === undefined ? {} : { platform }),
})

/** Every task cached and missed: what a cold run asks. */
const cold = (g: SimTask[]): SimTask[] =>
  g.map((t) =>
    t.exec && t.ran === undefined ? { ...t, ran: { ms: 2_000, cores: 1, memory: 2e8 } } : t,
  )

const mac: Size = { name: 'mac', max: 4, cpu: 3, memory: 7e9, platform: 'darwin-arm64' }
const linux: Size = { ...small, platform: 'linux-x64' }
const arm: Size = { name: 'arm', max: 1, cpu: 4, memory: 16e9, platform: 'linux-arm64' }

const cases: { name: string; graph: SimTask[]; o: SimOptions }[] = [
  // Real: 152 s, 13 workers (2026-10-24).
  {
    name: 'main 26434e7, cold (122 tasks ran)',
    graph: load(cold26434),
    o: { sizes: [linux, arm, mac], home: 'linux-x64' },
  },
  { name: 'main a09b987 (65 misses)', graph: load(a09), o: { sizes: [small] } },
  { name: 'main 2163fff (23 misses)', graph: load(f2163), o: { sizes: [small] } },
  { name: 'main a09b987, cold', graph: cold(load(a09)), o: { sizes: [small] } },
  {
    name: '200 small tasks (2 s, 1 core)',
    graph: Array.from({ length: 200 }, (_, i) => task(`t${i}`, [], 2_000)),
    o: { sizes: [small] },
  },
  {
    name: 'one long tail (90 s) beside 40 short (5 s)',
    graph: [
      task('long', [], 90_000),
      ...Array.from({ length: 40 }, (_, i) => task(`s${i}`, [], 5_000)),
    ],
    o: { sizes: [small] },
  },
  {
    name: 'a wide suite: 46 shards of 40 s',
    graph: [
      task('build', [], 10_000, 3),
      ...Array.from({ length: 46 }, (_, i) => task(`shard${i}`, ['build'], 40_000)),
    ],
    o: { sizes: [small] },
  },
  {
    name: 'mixed platforms: 30 Linux, 6 Mac (30 s)',
    graph: [
      ...Array.from({ length: 30 }, (_, i) => task(`l${i}`, [], 30_000)),
      ...Array.from({ length: 6 }, (_, i) => task(`m${i}`, [], 30_000, 1, 'darwin-arm64')),
    ],
    o: { sizes: [linux, mac], home: 'linux-x64' },
  },
]

const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
const row = (r: Outcome, one: Outcome): string =>
  `| ${r.strategy} | ${s(r.wallMs)} | ${s(r.runnerMs)} (${((100 * r.runnerMs) / one.runnerMs).toFixed(0)}%) | ${s(r.workerMs)} | ${r.billedMin} | ${r.workers} |`

const report: string[] = []

for (const c of cases)
  describe(c.name, () => {
    const one = oneWorker(c.graph, c.o)
    const all = [
      one,
      planner(c.graph, c.o),
      backlog(c.graph, c.o),
      budgeted(c.graph, c.o),
      payForItself(c.graph, c.o),
      oracle(c.graph, c.o, one),
    ]
    report.push(
      `\n### ${c.name}\n\n| strategy | wall | runner (vs 1 worker) | workers' | billed min | workers |\n|---|---|---|---|---|---|`,
      ...all.map((r) => row(r, one)),
    )
    it('the oracle never costs more than one worker, and is never slower', () => {
      const best = all.at(-1)!
      expect(best.runnerMs).toBeLessThanOrEqual(one.runnerMs)
      expect(best.wallMs).toBeLessThanOrEqual(one.wallMs)
    })
    it('the budgeted rule, decided from history before the run, costs no more than one worker', () => {
      expect(all[3]!.runnerMs).toBeLessThanOrEqual(one.runnerMs)
    })
  })

it('prints the comparison', () => {
  if (process.env['VX_GOALS_REPORT']) console.log(report.join('\n'))
  expect(report.length).toBeGreaterThan(0)
})
