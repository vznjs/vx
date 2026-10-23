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
import { assign, ordered } from '../src/dispatch.js'
import type { PlanTask } from '../src/planner.js'
import { DEFAULT_STRATEGY, type Strategy } from '../src/strategy.js'
import { simulate, type SimTask } from '../tests/sim.js'

const W = 20_000
const CORES = 4
const MEMORY = 16e9
// The orchestrator only coordinates, so it runs on a 1 vCPU machine: a
// quarter of a 4 vCPU one where minutes are priced by vCPU (Nx's credit
// table: 5 a minute against 20).
const ORCHESTRATOR = 0.25

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

/** A task on a lane, from its start to its end, `cores` high, `at` cores up. */
export interface Bar {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly cores: number
  at: number
}

/** A job or worker: started at `from`, up at `up` (after its warm-up), gone at `to`. */
export interface Lane {
  readonly from: number
  readonly up: number
  readonly to: number
  readonly bars: readonly Bar[]
}

export interface Outcome {
  readonly way: string
  readonly endMs: number
  /**
   * Machine time billed, in 4 vCPU minutes: each job or worker from its
   * start to its end, warm-up included; the orchestrator at its share.
   */
  readonly machineMs: number
  readonly lanes: readonly Lane[]
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

/** Stack each lane's bars so none overlaps another running beside it. */
function stack(bars: Bar[]): Bar[] {
  const placed: Bar[] = []
  for (const b of bars.toSorted((x, y) => x.start - y.start)) {
    const beside = placed.filter((p) => p.start < b.end && b.start < p.end)
    let at = 0
    for (const p of beside.toSorted((x, y) => x.at - y.at))
      if (at + b.cores > p.at + 1e-9 && p.at + p.cores > at + 1e-9) at = p.at + p.cores
    b.at = Math.min(at, CORES - b.cores)
    placed.push(b)
  }
  return placed
}

/**
 * The planner's ideal packer (`planner.ts` simulate), each task kept: the
 * tasks on machines that are up at `ups`, from `t0`, as each fits.
 */
function lay(
  tasks: readonly PlanTask[],
  ups: readonly number[],
  how: Strategy = DEFAULT_STRATEGY,
): { end: number; bars: Bar[][] } {
  const ids = new Set(tasks.map((t) => t.id))
  const byId = new Map(tasks.map((t) => [t.id, { ...t, deps: t.deps.filter((d) => ids.has(d)) }]))
  const dependants = new Map<string, string[]>()
  const waits = new Map<string, number>()
  for (const t of byId.values()) {
    waits.set(t.id, t.deps.length)
    for (const d of t.deps) dependants.set(d, [...(dependants.get(d) ?? []), t.id])
  }
  const tail = new Map<string, number>()
  const tailOf = (id: string): number => {
    let t = tail.get(id)
    if (t !== undefined) return t
    t = byId.get(id)!.ms!
    for (const d of dependants.get(id) ?? []) t = Math.max(t, byId.get(id)!.ms! + tailOf(d))
    tail.set(id, t)
    return t
  }
  const bins = ups.map((at, i) => ({
    id: String(i),
    cores: CORES,
    memory: MEMORY,
    used: { cores: 0, memory: 0 },
    running: 0,
    at,
  }))
  const bars: Bar[][] = ups.map(() => [])
  const ends: {
    at: number
    bin: (typeof bins)[number]
    id: string
    cores: number
    memory: number
  }[] = []
  let ready = [...byId.values()].filter((t) => t.deps.length === 0).map((t) => t.id)
  let now = 0
  let end = 0
  let left = byId.size
  while (left > 0) {
    ready = ordered(ready, how.order, tailOf, (id) => byId.get(id)!, CORES)
    const to = assign(
      ready.map((id) => ({ id, need: byId.get(id)! })),
      bins.filter((b) => b.at <= now),
      undefined,
      how.place,
    )
    for (const [id, bin] of to) {
      const t = byId.get(id)!
      ready = ready.filter((r) => r !== id)
      const cores = Math.min(t.cores, CORES)
      const memory = Math.min(t.memory, MEMORY)
      // assign already counted it on the bin.
      ends.push({ at: now + t.ms!, bin, id, cores, memory })
      bars[Number(bin.id)]!.push({ id, start: now, end: now + t.ms!, cores, at: 0 })
    }
    let next = Infinity
    for (const e of ends) next = Math.min(next, e.at)
    for (const b of bins) if (b.at > now) next = Math.min(next, b.at)
    if (next === Infinity) throw new Error(`lay: stuck with ${ready.join(' ')}`)
    now = next
    for (const e of ends.filter((x) => x.at <= now)) {
      ends.splice(ends.indexOf(e), 1)
      e.bin.used.cores -= e.cores
      e.bin.used.memory -= e.memory
      e.bin.running--
      left--
      end = Math.max(end, e.at)
      for (const d of dependants.get(e.id) ?? []) {
        waits.set(d, waits.get(d)! - 1)
        if (waits.get(d) === 0) ready.push(d)
      }
    }
  }
  return { end, bars }
}

/** One job, up after its warm-up from `from`, running these tasks. */
function job(tasks: readonly PlanTask[], from = 0): Lane {
  const { end, bars } = lay(tasks, [from + W])
  return { from, up: from + W, to: Math.max(from + W, end), bars: bars[0]! }
}

const billed = (lanes: readonly Lane[]): number => lanes.reduce((s, l) => s + l.to - l.from, 0)
const last = (lanes: readonly Lane[]): number => Math.max(...lanes.map((l) => l.to))

function oneMachine(tasks: readonly PlanTask[]): Outcome {
  const lanes = [job(tasks)]
  return { way: 'One machine', endMs: last(lanes), machineMs: billed(lanes), lanes }
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
  const lanes = Array.from({ length: k }, (_, j) =>
    job(closure(all.filter((id, i) => i % k === j && byId.has(id)))),
  )
  return { way: `Static matrix, ${k} jobs`, endMs: last(lanes), machineMs: billed(lanes), lanes }
}

/**
 * Two stages: a build job runs every task another waits on, then a matrix
 * of k jobs splits the rest of every task by count, as `matrix` does.
 */
function stages(all: readonly string[], tasks: readonly PlanTask[], k: number): Outcome {
  const upstream = new Set(tasks.flatMap((t) => t.deps))
  const build = job(tasks.filter((t) => upstream.has(t.id)))
  const byId = new Map(tasks.filter((t) => !upstream.has(t.id)).map((t) => [t.id, t]))
  const lanes = [
    build,
    ...Array.from({ length: k }, (_, j) =>
      job(
        all.filter((id, i) => i % k === j && byId.has(id)).map((id) => byId.get(id)!),
        build.to,
      ),
    ),
  ]
  return {
    way: `Build stage, then ${k} jobs`,
    endMs: last(lanes),
    machineMs: billed(lanes),
    lanes,
  }
}

/** Distributed, carelessly: k workers up front, a task each, as they get ready, until the run ends. */
function naive(tasks: readonly PlanTask[], k: number): Outcome {
  const whole = tasks.map((t) => ({ ...t, cores: CORES, memory: MEMORY }))
  const { end, bars } = lay(
    whole,
    Array.from({ length: k }, () => W),
    { order: 'fifo', place: 'first-fit', book: 'whole', scale: 'backlog' },
  )
  // Each holds a whole worker, though it uses only its own cores.
  const used = new Map(tasks.map((t) => [t.id, Math.min(t.cores, CORES)]))
  const lanes = bars.map((b) => ({
    from: 0,
    up: W,
    to: end,
    bars: b.map((x) => ({ ...x, cores: used.get(x.id)! })),
  }))
  return {
    way: `Naive DTE, ${k} workers`,
    endMs: end,
    machineMs: billed(lanes) + end * ORCHESTRATOR,
    lanes,
  }
}

function vxDte(graph: readonly SimTask[]): Outcome {
  const r = simulate(graph, {
    sizes: [{ name: 'small', max: 12, cpu: CORES, memory: MEMORY }],
    warmUpMs: () => W,
    how: DEFAULT_STRATEGY,
    likely: new Set(graph.filter((t) => t.ran !== undefined && t.cache).map((t) => t.id)),
  })
  const byId = new Map(graph.map((t) => [t.id, t]))
  const lanes = r.workers.map((w) => ({
    from: w.spawnedAt,
    up: w.joinedAt ?? w.cancelledAt!,
    to: w.leftAt ?? w.cancelledAt ?? r.endMs,
    bars: w.ran.map((id) => ({
      id,
      start: r.startedAt.get(id)!,
      end: r.endedAt.get(id)!,
      cores: Math.min(byId.get(id)!.ran!.cores, CORES),
      at: 0,
    })),
  }))
  return {
    way: `vx DTE, ${r.workers.length} workers`,
    endMs: r.endMs,
    machineMs: billed(lanes) + r.endMs * ORCHESTRATOR,
    lanes,
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
    const k = vxDte(full).lanes.length
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

const LANE = 20
const GAP = 4

/**
 * A case as the post draws it: each way's jobs and workers as lanes on
 * one clock, each task a bar as tall as the cores it used, warm-up and
 * idle time shaded. Plain HTML and SVG; charts.css animates `--vxg-t`
 * from 0 to 1000 so every lane fills at once, and holds it at 1000 for
 * a reader who asks for less motion.
 */
function gantt(c: Case, title: string): string {
  const max = Math.max(...c.ways.map((o) => o.endMs))
  const d = (n: number): number => Math.round(n * 10) / 10
  const x = (ms: number): number => d((ms / max) * 1000)
  const rect = (cls: string, from: number, to: number, y: number, h: number): string =>
    to <= from
      ? ''
      : `<rect class="${cls}" x="${x(from)}" y="${d(y)}" width="${d(Math.max(0.5, x(to) - x(from)))}" height="${d(h)}" style="--s:${x(from)};--e:${x(to)}"/>`
  const ways = c.ways.map((o, n) => {
    const height = o.lanes.length * (LANE + GAP)
    const lanes = o.lanes.map((l, i) => {
      const y = i * (LANE + GAP)
      const unit = LANE / CORES
      return (
        rect('w', l.from, l.up, y, LANE) +
        rect('o', l.up, l.to, y, LANE) +
        stack([...l.bars])
          .map((b) => rect('t', b.start, b.end, y + LANE - (b.at + b.cores) * unit, b.cores * unit))
          .join('')
      )
    })
    const label = `${o.way}: ends ${(o.endMs / 1000).toFixed(1)} s, ${(o.machineMs / 60_000).toFixed(1)} machine-minutes`
    return (
      `<div class="vx-gantt-way${n === c.ways.length - 1 ? ' vx-gantt-lead' : ''}">` +
      `<div class="vx-gantt-head"><span>${o.way}</span><span class="vx-gantt-end" style="--e:${x(o.endMs)}">${(o.endMs / 1000).toFixed(1)} s · ${(o.machineMs / 60_000).toFixed(1)} min</span></div>` +
      `<svg viewBox="0 0 1000 ${height}" preserveAspectRatio="none" height="${height}" role="img" aria-label="${label}">` +
      lanes.join('') +
      `<rect class="vx-gantt-now" x="0" y="0" width="2" height="${height}"/></svg></div>`
    )
  })
  return `<figure class="vx-gantt"><figcaption>${title}</figcaption>${ways.join('')}</figure>`
}

const html = process.argv.indexOf('--html')
if (import.meta.main && html !== -1) {
  // `--html N "title"`: case N drawn for the post.
  const cases = compare()
  console.log(gantt(cases[Number(process.argv[html + 1])]!, process.argv[html + 2] ?? ''))
} else if (import.meta.main)
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
