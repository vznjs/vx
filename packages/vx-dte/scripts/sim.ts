#!/usr/bin/env bun
// Plays a distributed run on the simulator (`tests/sim.ts`) from a run
// fixture: the CI graph and how long each task that missed ran. What the
// summary's Workers table would say, with the best any worker count does.
//
//   bun packages/vx-dte/scripts/sim.ts [fixture.json] [--max 12] [--cpu 4]
//     [--warm-up 20000] [--order critical-path] [--place best-fit]
//     [--book measured] [--scale plan] [--no-forecast]

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { DEFAULT_STRATEGY, STRATEGIES, type Strategy } from '../src/strategy.js'
import { bestMs, simulate, type SimTask } from '../tests/sim.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    max: { type: 'string', default: '12' },
    cpu: { type: 'string', default: '4' },
    'warm-up': { type: 'string', default: '20000' },
    order: { type: 'string', default: DEFAULT_STRATEGY.order },
    place: { type: 'string', default: DEFAULT_STRATEGY.place },
    book: { type: 'string', default: DEFAULT_STRATEGY.book },
    scale: { type: 'string', default: DEFAULT_STRATEGY.scale },
    'no-forecast': { type: 'boolean', default: false },
  },
})

const file = positionals[0] ?? path.join(import.meta.dir, '../tests/fixtures/main-run-a09b987.json')
const f = JSON.parse(readFileSync(file, 'utf8')) as {
  nodes: { id: string; deps: string[]; exec: boolean; cache: boolean }[]
  ran: Record<string, number[]>
}
const graph: SimTask[] = f.nodes.map((n) => {
  const r = f.ran[n.id]
  return r === undefined ? n : { ...n, ran: { ms: r[0]!, cores: r[1]!, memory: r[2]! * 1e6 } }
})

const how = { ...DEFAULT_STRATEGY } as Record<keyof Strategy, string>
for (const k of Object.keys(STRATEGIES) as (keyof Strategy)[]) {
  const v = values[k]!
  if (!(STRATEGIES[k] as readonly string[]).includes(v))
    throw new Error(`--${k} ${v}: one of ${STRATEGIES[k].join(', ')}`)
  how[k] = v
}
const size = { name: 'small', max: Number(values.max), cpu: Number(values.cpu), memory: 16e9 }
const warmUp = Number(values['warm-up'])
const likely = new Set(graph.filter((t) => t.ran !== undefined && t.cache).map((t) => t.id))
const r = simulate(graph, {
  sizes: [size],
  warmUpMs: () => warmUp,
  how: how as unknown as Strategy,
  ...(values['no-forecast'] ? {} : { likely }),
})

const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
console.log(`${file}: ${r.executed} tasks ran, strategy ${Object.values(how).join(' / ')}`)
console.log(`end       ${s(r.endMs)}  (best any worker count: ${s(bestMs(graph, size, warmUp))})`)
console.log(`cpu       ${Math.round(r.utilization * 100)}% of joined workers' cores`)
console.log(`churn     ${r.churn}   over-sent ${r.overSent}`)
for (const w of r.workers) {
  const state =
    w.joinedAt === undefined
      ? 'cancelled'
      : `joined ${s(w.joinedAt)}, left ${s(w.leftAt ?? r.endMs)}`
  console.log(
    `  ${w.id.padEnd(10)} ${state.padEnd(28)} ${String(w.tasks).padStart(3)} done · busy ${s(w.busyMs)} · idle ${s(w.idleMs)}`,
  )
}
