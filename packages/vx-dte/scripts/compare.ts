#!/usr/bin/env bun
// The blog's comparison (one-run-on-your-own-runners): one graph, five ways
// CI could run it on 4 vCPU machines that each take a warm-up to start.
// Every way but vx DTE is played by the planner's ideal packer (no task
// slows another), so each gets the benefit of the doubt; vx DTE is played
// by the full simulator (`tests/sim.ts`), sharing and all.
//
//   bun packages/vx-dte/scripts/compare.ts
//
// tests/sim.test.ts holds the post's claim: vx DTE ends no later than any.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { simulate as pack, type PlanTask } from '../src/planner.js'
import { DEFAULT_STRATEGY } from '../src/strategy.js'
import { simulate, type SimTask } from '../tests/sim.js'

const W = 20_000
const CORES = 4
const MEMORY = 16e9

/** vx's own main run a09b987: its CI graph and the 65 tasks that missed. */
function vxRun(): SimTask[] {
  const file = path.join(import.meta.dir, '../tests/fixtures/main-run-a09b987.json')
  const f = JSON.parse(readFileSync(file, 'utf8')) as {
    nodes: { id: string; deps: string[]; exec: boolean; cache: boolean }[]
    ran: Record<string, number[]>
  }
  return f.nodes.map((n) => {
    const r = f.ran[n.id]
    return r === undefined ? n : { ...n, ran: { ms: r[0]!, cores: r[1]!, memory: r[2]! * 1e6 } }
  })
}

/**
 * An app monorepo after a change to its base library: 24 libraries, each
 * built on the one before it and one further down, with a test and a lint
 * each; 4 apps on six libraries each, built, tested and run end to end.
 */
function appRepo(): SimTask[] {
  const t: SimTask[] = []
  const add = (id: string, deps: string[], ms: number, cores: number): void => {
    t.push({ id, deps, exec: true, cache: true, ran: { ms, cores, memory: 1e9 } })
  }
  for (let i = 0; i < 24; i++) {
    const up = i === 0 ? [] : [...new Set([`lib${i - 1}#build`, `lib${i >> 1}#build`])]
    add(
      `lib${i}#build`,
      up.filter((d) => d !== `lib${i}#build`),
      20_000,
      1.5,
    )
    add(`lib${i}#test`, [`lib${i}#build`], 45_000, 1)
    add(`lib${i}#lint`, [], 10_000, 1)
  }
  for (let a = 0; a < 4; a++) {
    const libs = Array.from({ length: 6 }, (_, k) => `lib${(a * 5 + k * 3) % 24}#build`)
    add(`app${a}#build`, [...new Set(libs)], 90_000, 3)
    add(`app${a}#test`, [`app${a}#build`], 60_000, 1)
    add(`app${a}#e2e`, [`app${a}#build`], 150_000, 1.5)
  }
  return t
}

export interface Outcome {
  readonly way: string
  readonly endMs: number
  /** Machine time billed: each job or worker from its start to its end, warm-up included. */
  readonly machineMs: number
  readonly jobs: number
}

/** The tasks that run, each waiting only on others that run (a hit ends at once). */
function misses(graph: readonly SimTask[]): PlanTask[] {
  const byId = new Map(graph.map((t) => [t.id, t]))
  const up = (id: string, seen: Set<string>): string[] =>
    byId.get(id)!.deps.flatMap((d) => {
      if (seen.has(d) || !byId.has(d)) return []
      seen.add(d)
      return byId.get(d)!.ran === undefined ? up(d, seen) : [d]
    })
  return graph.flatMap((t) =>
    t.ran === undefined || !t.exec
      ? []
      : [
          {
            id: t.id,
            cores: t.ran.cores,
            memory: t.ran.memory,
            ms: t.ran.ms,
            deps: up(t.id, new Set()),
          },
        ],
  )
}

const machine = (id: string, at = 0) => ({
  id,
  cores: CORES,
  memory: MEMORY,
  at,
  running: [],
  idle: true,
})

/** How long one machine runs these tasks, from when it is up, packing their cores. */
const span = (tasks: readonly PlanTask[]): number => {
  const ids = new Set(tasks.map((t) => t.id))
  return pack(
    tasks.map((t) => ({ ...t, deps: t.deps.filter((d) => ids.has(d)) })),
    [machine('m')],
  )
}

function oneMachine(tasks: readonly PlanTask[]): Outcome {
  const end = W + span(tasks)
  return { way: 'One machine', endMs: end, machineMs: end, jobs: 1 }
}

/**
 * A matrix fixed in YAML: k jobs, each its share of every task by count,
 * hit or miss, rebuilding the misses its share needs. A job whose share
 * all hit still starts.
 */
function matrix(all: readonly string[], tasks: readonly PlanTask[], k: number): Outcome {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const closure = (ids: string[]): PlanTask[] => {
    const seen = new Set<string>()
    const walk = (id: string): void => {
      if (seen.has(id)) return
      seen.add(id)
      for (const d of byId.get(id)!.deps) walk(d)
    }
    for (const id of ids) walk(id)
    return [...seen].map((id) => byId.get(id)!)
  }
  let end = 0
  let machineMs = 0
  for (let j = 0; j < k; j++) {
    const share = all.filter((id, i) => i % k === j && byId.has(id))
    const ms = W + span(closure(share))
    end = Math.max(end, ms)
    machineMs += ms
  }
  return { way: `Static matrix, ${k} jobs`, endMs: end, machineMs, jobs: k }
}

/**
 * Two stages: a build job runs every task another waits on, then a matrix
 * of k jobs splits the rest of every task by count, as `matrix` does.
 */
function stages(all: readonly string[], tasks: readonly PlanTask[], k: number): Outcome {
  const upstream = new Set(tasks.flatMap((t) => t.deps))
  const build = W + span(tasks.filter((t) => upstream.has(t.id)))
  const rest = tasks.filter((t) => !upstream.has(t.id))
  const byId = new Map(rest.map((t) => [t.id, t]))
  let slowest = 0
  let machineMs = build
  for (let j = 0; j < k; j++) {
    const ms =
      W + span(all.filter((id, i) => i % k === j && byId.has(id)).map((id) => byId.get(id)!))
    slowest = Math.max(slowest, ms)
    machineMs += ms
  }
  return { way: `Build stage, then ${k} jobs`, endMs: build + slowest, machineMs, jobs: k + 1 }
}

/** Distributed, carelessly: k workers up front, a task each, as they get ready, until the run ends. */
function naive(tasks: readonly PlanTask[], k: number): Outcome {
  const whole = tasks.map((t) => ({ ...t, cores: CORES, memory: MEMORY }))
  const workers = Array.from({ length: k }, (_, i) => machine(`w${i}`, W))
  const end = pack(whole, workers, {
    order: 'fifo',
    place: 'first-fit',
    book: 'whole',
    scale: 'backlog',
  })
  // The orchestrator's job is billed for the run too.
  return { way: `Naive DTE, ${k} workers`, endMs: end, machineMs: end * (k + 1), jobs: k + 1 }
}

function vxDte(graph: readonly SimTask[]): Outcome {
  const r = simulate(graph, {
    sizes: [{ name: 'small', max: 12, cpu: CORES, memory: MEMORY }],
    warmUpMs: () => W,
    how: DEFAULT_STRATEGY,
    likely: new Set(graph.filter((t) => t.ran !== undefined && t.cache).map((t) => t.id)),
  })
  let machineMs = r.endMs
  for (const w of r.workers) machineMs += (w.leftAt ?? w.cancelledAt ?? r.endMs) - w.spawnedAt
  return {
    way: `vx DTE, ${r.workers.length} workers`,
    endMs: r.endMs,
    machineMs,
    jobs: r.workers.length + 1,
  }
}

/** The same graph on a PR that misses only these: the rest hit. */
const only = (graph: readonly SimTask[], miss: RegExp): SimTask[] =>
  graph.map((t) => {
    if (t.ran === undefined || miss.test(t.id)) return t
    const { ran: _, ...hit } = t
    return hit
  })

export interface Case {
  readonly name: string
  readonly tasks: number
  /** Core-ms of work: each task's ms times its cores. */
  readonly work: number
  /** One machine, the matrix, the build stage, naive DTE, vx DTE. */
  readonly ways: readonly Outcome[]
}

/** The post's four runs, each played every way. */
export function compare(): Case[] {
  const vx = vxRun()
  const app = appRepo()
  return (
    [
      ['vx main a09b987', vx, vx],
      ['a vx PR: lint and 6 test shards miss', only(vx, /#lint\.ox|shard-[1-6]$/), vx],
      ['app monorepo, base library changed', app, app],
      ['app monorepo, one app changed', only(app, /^app0#/), app],
    ] as const
  ).map(([name, graph, full]) => {
    const tasks = misses(graph)
    // The matrix is sized once, for a full run, as YAML is.
    const k = vxDte(full).jobs - 1
    const all = graph.filter((t) => t.exec).map((t) => t.id)
    return {
      name,
      tasks: tasks.length,
      work: tasks.reduce((s, t) => s + t.ms! * t.cores, 0),
      ways: [
        oneMachine(tasks),
        matrix(all, tasks, k),
        stages(all, tasks, k),
        naive(tasks, k),
        vxDte(graph),
      ],
    }
  })
}

if (import.meta.main)
  for (const c of compare()) {
    console.log(
      `\n${c.name}: ${c.tasks} tasks run, ${(c.work / 60_000).toFixed(1)} core-minutes of work`,
    )
    console.log('way | end | machine-minutes | CPU used')
    for (const o of c.ways)
      console.log(
        `${o.way} | ${(o.endMs / 1000).toFixed(1)} s | ${(o.machineMs / 60_000).toFixed(1)} | ${Math.round((100 * c.work) / (o.machineMs * CORES))}%`,
      )
  }
