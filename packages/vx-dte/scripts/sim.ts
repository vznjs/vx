#!/usr/bin/env bun
// Plays a distributed run on the simulator (`tests/sim.ts`) from a run
// fixture (`scripts/fixture.ts`): the CI graph, how long each task that
// missed ran, and, where it has them, what history knew and how long each
// size's workers took to join. Over `--orders` shuffles of those joins:
// the median and worst end, and the core time the workers were held.
//
//   bun packages/vx-dte/scripts/sim.ts [fixture.json] [--orders 30]
//     [--max 12] [--cpu 4] [--warm-up 20000] [--pace small=1.3]
//
// With no `joins` in the fixture, one size: `--max` workers of `--cpu`
// cores that each join `--warm-up` after their ask.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { rng } from '../tests/families.js'
import { simulate, type SimTask } from '../tests/sim.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    orders: { type: 'string', default: '30' },
    max: { type: 'string', default: '12' },
    cpu: { type: 'string', default: '4' },
    'warm-up': { type: 'string', default: '20000' },
    /** A size's pace in place of the fixture's, `small=1.3`; repeatable. */
    pace: { type: 'string', multiple: true, default: [] },
  },
})

/** The sizes main's CI declares (`.vx/workspace.ts`), for a fixture with joins. */
const MAIN = [
  { name: 'small', max: 9, cpu: 4, memory: 16e9, platform: 'linux-x64' },
  { name: 'mac', max: 3, cpu: 2, memory: 7e9, platform: 'darwin-arm64' },
  { name: 'arm', max: 1, cpu: 4, memory: 16e9, platform: 'linux-arm64' },
]
const HOME = 'linux-x64'

type Row = [ms: number, cores: number, memoryMb: number, afterMs?: number]
const file = positionals[0] ?? path.join(import.meta.dir, '../tests/fixtures/main-run-d36eed9.json')
const f = JSON.parse(readFileSync(file, 'utf8')) as {
  nodes: (SimTask & { platform?: string })[]
  ran: Record<string, Row>
  known?: Record<string, Row | null>
  joins?: Record<string, number[]>
  warmUps?: Record<string, number>
  /** Per size, how much later each next worker joined than the one before (ms). */
  spreads?: Record<string, number>
  /** Per size, how many times history's time its tasks took, as an earlier run learned. */
  paces?: Record<string, number>
}
const graph: SimTask[] = f.nodes.map((n) => {
  const r = f.ran[n.id]
  const k = f.known?.[n.id]
  const t: SimTask =
    r === undefined
      ? n
      : {
          ...n,
          ran: {
            ms: r[0],
            cores: r[1],
            memory: r[2] * 1e6,
            ...(r[3] === undefined ? {} : { afterMs: r[3] }),
          },
        }
  if (k === undefined) return t
  return {
    ...t,
    known:
      k === null
        ? null
        : {
            ms: k[0],
            cores: k[1],
            memory: k[2] * 1e6,
            ...(k[3] === undefined ? {} : { afterMs: k[3] }),
          },
  }
})
const likely = new Set(graph.filter((t) => t.ran !== undefined).map((t) => t.id))
const joins = f.joins
const sizes =
  joins === undefined
    ? [{ name: 'small', max: Number(values.max), cpu: Number(values.cpu), memory: 16e9 }]
    : MAIN
const paces = Object.fromEntries(
  values.pace.map((p) => {
    const [size, x] = p.split('=')
    return [size!, Number(x)]
  }),
)
const orders = Number(values.orders)
const ends: number[] = []
const held: number[] = []
for (let seed = 0; seed < orders; seed++) {
  const r = rng(seed * 7919 + 1)
  const js: Record<string, number[]> = {}
  for (const [k, v] of Object.entries(joins ?? {})) {
    const a = [...v]
    // The first order is the run's own.
    if (seed > 0)
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1))
        ;[a[i], a[j]] = [a[j]!, a[i]!]
      }
    js[k] = a
  }
  const s = simulate(graph, {
    sizes,
    likely,
    ...(joins === undefined
      ? { warmUpMs: () => Number(values['warm-up']) }
      : {
          home: HOME,
          warmUpMs: (_: number, size: string, k: number) => js[size]![(k - 1) % js[size]!.length]!,
          warmUpsMs: new Map(Object.entries(f.warmUps ?? {})),
          spreadsMs: new Map(Object.entries(f.spreads ?? {})),
          paces: new Map(Object.entries({ ...f.paces, ...paces })),
        }),
  })
  ends.push(s.endMs)
  held.push(s.heldMs)
}
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1]!
const s = (ms: number): string => `${(ms / 1000).toFixed(1)} s`
console.log(`${file}: ${likely.size} tasks ran, ${orders} join orders`)
console.log(`end     median ${s(median(ends))}, worst ${s(Math.max(...ends))}`)
console.log(`held    median ${Math.round(median(held) / 1000)} core-s`)
