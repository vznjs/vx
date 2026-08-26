#!/usr/bin/env bun
/**
 * Scheduler-policy benchmark — Phase 1 of
 * `docs/design/lookahead-scheduler-2026-07.md`.
 *
 *   bun bench/schedule-policy.ts [--md]
 *
 * The instrument the design calls for: it turns "should time-based
 * (predictive) priority be the default?" (Phase 2) and any future lookahead
 * claim (Phase 3) into NUMBERS instead of arguments.
 *
 * It compares the two REAL priority policies vx already ships —
 *   • `count`  — the duration-BLIND default `computeReverseDepCount`;
 *   • `remCP`  — the time-based predictive priority that `defineWorkspace({
 *                predictive: true })` produces: `mergePriorities(count,
 *                computePredictedPriorities(nodes, history))`.
 * — across a matrix of graph shapes, using the ACTUAL priority functions from
 * `src/` (no reimplementation of the weights — only the priorities that could
 * drift are imported).
 *
 * Makespan comes from a deterministic discrete-event simulation of `runGraph`'s
 * greedy, work-conserving, exec-tier list policy (pop highest priority DESC /
 * enqueue-seq ASC onto a free worker; a task finishes at start+dur; completing
 * it unblocks dependents). Simulated (logical) durations — not wall-clock —
 * keep every number reproducible and flake-free, and let a 3000-node graph
 * measure in milliseconds. The sim is self-validated below against three
 * hand-computed makespans (a chain, a work-bound fan, and the design's
 * Example-D Graham anomaly) so its fidelity is pinned, not assumed.
 *
 * NOTE: this is the LOCAL scheduler policy. The distributed/cloud
 * `taskDurationHints` LPT path is a separate mechanism (decision log
 * 2026-07-14) and is out of scope here.
 */

import { computeReverseDepCount, mergePriorities } from '../packages/vx/src/graph/scheduler.js'
import type { TaskConfig } from '../packages/vx/src/config.js'
import type { TaskNode } from '../packages/vx/src/graph/index.js'
import type { HistoryTable, TaskHistory } from '../packages/vx/src/orchestrator/history.js'
import { computePredictedPriorities } from '../packages/vx/src/orchestrator/predict.js'

interface BenchTask {
  id: string
  deps: string[]
  dur: number
}
interface BenchGraph {
  name: string
  tasks: BenchTask[]
  workers: number
  /** Ids whose finish time is the "requested output ready" latency. */
  requested: string[]
}

// A tiny seeded LCG so the mixed-duration graphs are reproducible (no
// Math.random — the numbers are committed and must not drift run to run).
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0
    return s / 0x1_0000_0000
  }
}

// ---------------------------------------------------------------------------
// Reuse the REAL priority functions. Only `id`/`deps` are read by them; the
// rest of TaskNode is inert filler.
// ---------------------------------------------------------------------------

function toNodes(tasks: readonly BenchTask[]): Map<string, TaskNode> {
  const m = new Map<string, TaskNode>()
  for (const t of tasks) {
    m.set(t.id, {
      id: t.id,
      projectName: t.id,
      projectDir: '/',
      taskName: t.id,
      config: {} as TaskConfig,
      deps: t.deps,
      requested: false,
    })
  }
  return m
}

function toHistory(tasks: readonly BenchTask[]): HistoryTable {
  const m = new Map<string, TaskHistory>()
  for (const t of tasks) {
    const h: TaskHistory = {
      runs: 1,
      p50DurationMs: t.dur,
      p99DurationMs: t.dur,
      successRate: 1,
      hitRate: 0,
      failureMode: 'stable',
    }
    m.set(t.id, h)
  }
  return m
}

/**
 * The final priority map each real mode hands `runGraph`:
 *   • count      — the duration-blind default.
 *   • remCP      — predictive with WARM history (real per-task p50s).
 *   • remCP-cold — predictive with an EMPTY history: exactly what a cold-cache
 *                  `predictive: true` run produces (every dur → the workspace-
 *                  median fallback, so priority collapses to uniform-duration
 *                  critical-path DEPTH). This is the case the Phase-2
 *                  "make predictive the default" decision must not regress —
 *                  measured against the graph's REAL durations.
 */
function priorityFor(
  mode: 'count' | 'remCP' | 'remCP-cold',
  tasks: readonly BenchTask[],
): ReadonlyMap<string, number> {
  const nodes = toNodes(tasks)
  const count = computeReverseDepCount(nodes)
  if (mode === 'count') return count
  const history = mode === 'remCP' ? toHistory(tasks) : new Map<string, TaskHistory>()
  return mergePriorities(count, computePredictedPriorities([...nodes.values()], history))
}

// ---------------------------------------------------------------------------
// Discrete-event simulation of runGraph's greedy exec-tier list policy.
// ---------------------------------------------------------------------------

interface SimResult {
  makespan: number
  finish: Map<string, number>
}

function simulate(
  tasks: readonly BenchTask[],
  priority: ReadonlyMap<string, number>,
  workers: number,
): SimResult {
  const dur = new Map(tasks.map((t) => [t.id, t.dur]))
  const pending = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const t of tasks) {
    pending.set(t.id, t.deps.length)
    if (!dependents.has(t.id)) dependents.set(t.id, [])
  }
  for (const t of tasks) {
    for (const d of t.deps) {
      const l = dependents.get(d)
      if (l) l.push(t.id)
      else dependents.set(d, [t.id])
    }
  }

  let seq = 0
  const readySeq = new Map<string, number>()
  const ready: string[] = []
  const enqueue = (id: string): void => {
    readySeq.set(id, seq++)
    ready.push(id)
  }
  for (const t of tasks) if ((pending.get(t.id) ?? 0) === 0) enqueue(t.id)

  // Pop by (priority DESC, enqueue-seq ASC) — runGraph's heap contract.
  const pop = (): string | undefined => {
    if (ready.length === 0) return undefined
    let bi = 0
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i]!
      const b = ready[bi]!
      const pa = priority.get(a) ?? 0
      const pb = priority.get(b) ?? 0
      if (pa > pb || (pa === pb && readySeq.get(a)! < readySeq.get(b)!)) bi = i
    }
    return ready.splice(bi, 1)[0]
  }

  const running: { id: string; done: number }[] = []
  const finish = new Map<string, number>()
  let clock = 0
  let free = workers
  let completed = 0

  while (completed < tasks.length) {
    while (free > 0 && ready.length > 0) {
      const id = pop()!
      running.push({ id, done: clock + (dur.get(id) ?? 0) })
      free--
    }
    if (running.length === 0) break // cycle guard — a DAG never hits this
    let next = Infinity
    for (const r of running) if (r.done < next) next = r.done
    clock = next
    for (let i = running.length - 1; i >= 0; i--) {
      const r = running[i]!
      if (r.done !== clock) continue
      finish.set(r.id, r.done)
      free++
      completed++
      running.splice(i, 1)
      for (const dep of dependents.get(r.id) ?? []) {
        const p = (pending.get(dep) ?? 0) - 1
        pending.set(dep, p)
        if (p === 0) enqueue(dep)
      }
    }
  }
  return { makespan: clock, finish }
}

// ---------------------------------------------------------------------------
// Graph shape generators.
// ---------------------------------------------------------------------------

function deepChain(n: number, dur: number): BenchGraph {
  const tasks: BenchTask[] = []
  for (let i = 0; i < n; i++) tasks.push({ id: `c${i}`, deps: i > 0 ? [`c${i - 1}`] : [], dur })
  return { name: `deep-chain(${n})`, tasks, workers: 8, requested: [`c${n - 1}`] }
}

function wideFan(n: number, dur: number): BenchGraph {
  const tasks: BenchTask[] = [{ id: 'root', deps: [], dur }]
  for (let i = 0; i < n; i++) tasks.push({ id: `l${i}`, deps: ['root'], dur })
  return { name: `wide-fan(${n})`, tasks, workers: 8, requested: [] }
}

function diamond(width: number, dur: number): BenchGraph {
  const mids = Array.from({ length: width }, (_, i) => `m${i}`)
  const tasks: BenchTask[] = [{ id: 'root', deps: [], dur }]
  for (const m of mids) tasks.push({ id: m, deps: ['root'], dur })
  tasks.push({ id: 'sink', deps: mids, dur })
  return { name: `diamond(${width})`, tasks, workers: 8, requested: ['sink'] }
}

/** The design's Example D — a symmetric critical fork + a long non-crit + short filler. */
function grahamAnomaly(): BenchGraph {
  return {
    name: 'graham-anomaly(D)',
    workers: 2,
    requested: ['A2', 'B2'],
    tasks: [
      { id: 'H', deps: [], dur: 2 },
      { id: 'A', deps: ['H'], dur: 10 },
      { id: 'A2', deps: ['A'], dur: 10 },
      { id: 'B', deps: ['H'], dur: 10 },
      { id: 'B2', deps: ['B'], dur: 10 },
      { id: 'N', deps: [], dur: 10 },
      { id: 'S', deps: [], dur: 2 },
    ],
  }
}

/** Work-bound: many independent equal tasks — should TIE (LPT vs count irrelevant). */
function workBound(n: number, dur: number, workers: number): BenchGraph {
  return {
    name: `work-bound(${n}/${workers}w)`,
    workers,
    requested: [],
    tasks: Array.from({ length: n }, (_, i) => ({ id: `w${i}`, deps: [], dur })),
  }
}

/** CP-bound: one long chain dominates; short filler tasks — should TIE. */
function cpBound(chain: number, filler: number): BenchGraph {
  const tasks: BenchTask[] = []
  for (let i = 0; i < chain; i++)
    tasks.push({ id: `k${i}`, deps: i > 0 ? [`k${i - 1}`] : [], dur: 100 })
  for (let i = 0; i < filler; i++) tasks.push({ id: `f${i}`, deps: [], dur: 5 })
  return {
    name: `cp-bound(${chain}chain+${filler}filler)`,
    tasks,
    workers: 4,
    requested: [`k${chain - 1}`],
  }
}

/**
 * Mixed-duration layered DAG — the case the design predicts time-based
 * priority should WIN: the duration-blind count front-loads a task that
 * unblocks MANY short tasks over one that unblocks a single LONG chain.
 * Each node depends on a few random nodes in the layer below; durations are
 * bimodal (a few long poles among many short tasks).
 */
function mixedLayered(layers: number, perLayer: number, workers: number, seed: number): BenchGraph {
  const rnd = lcg(seed)
  const tasks: BenchTask[] = []
  const byLayer: string[][] = []
  for (let L = 0; L < layers; L++) {
    const row: string[] = []
    for (let i = 0; i < perLayer; i++) {
      const id = `n${L}_${i}`
      const deps: string[] = []
      if (L > 0) {
        const below = byLayer[L - 1]!
        const k = 1 + Math.floor(rnd() * 3)
        for (let j = 0; j < k; j++) deps.push(below[Math.floor(rnd() * below.length)]!)
      }
      // Bimodal: ~15% long poles (800-1200ms), rest short (20-120ms).
      const dur = rnd() < 0.15 ? 800 + Math.floor(rnd() * 400) : 20 + Math.floor(rnd() * 100)
      tasks.push({ id, deps: [...new Set(deps)], dur })
      row.push(id)
    }
    byLayer.push(row)
  }
  return {
    name: `mixed-layered(${layers}x${perLayer}/${workers}w)`,
    tasks,
    workers,
    requested: byLayer[layers - 1]!,
  }
}

// ---------------------------------------------------------------------------
// Self-validation — pin the sim against three hand-computed makespans so its
// fidelity is proven, not assumed. Throws (fails the bench) on drift.
// ---------------------------------------------------------------------------

function assertEq(label: string, got: number, want: number): void {
  if (got !== want) throw new Error(`sim self-check FAILED: ${label} = ${got}, expected ${want}`)
}

function selfValidate(): void {
  // A chain's makespan is the sum of its durations regardless of policy/workers.
  const chain = deepChain(5, 10)
  for (const mode of ['count', 'remCP'] as const) {
    assertEq(
      `${chain.name}/${mode}`,
      simulate(chain.tasks, priorityFor(mode, chain.tasks), chain.workers).makespan,
      50,
    )
  }
  // 8 equal tasks on 2 workers → ceil(8/2)*dur = 4*10 = 40.
  const wb = workBound(8, 10, 2)
  for (const mode of ['count', 'remCP'] as const) {
    assertEq(
      `${wb.name}/${mode}`,
      simulate(wb.tasks, priorityFor(mode, wb.tasks), wb.workers).makespan,
      40,
    )
  }
  // Example D: greedy-remCP is optimal at 30 (design §Example D).
  const d = grahamAnomaly()
  assertEq(
    `${d.name}/remCP`,
    simulate(d.tasks, priorityFor('remCP', d.tasks), d.workers).makespan,
    30,
  )
}

// ---------------------------------------------------------------------------
// Run the matrix.
// ---------------------------------------------------------------------------

function pct(base: number, other: number): number {
  if (base === 0) return 0
  return ((other - base) / base) * 100
}

interface Row {
  name: string
  workers: number
  tasks: number
  msCount: number
  msRemCP: number
  msDeltaPct: number
  msColdDeltaPct: number
  latCount: number
  latRemCP: number
  latDeltaPct: number
}

function measure(g: BenchGraph): Row {
  const rc = simulate(g.tasks, priorityFor('count', g.tasks), g.workers)
  const rr = simulate(g.tasks, priorityFor('remCP', g.tasks), g.workers)
  const rcold = simulate(g.tasks, priorityFor('remCP-cold', g.tasks), g.workers)
  const lat = (r: SimResult): number =>
    g.requested.length === 0
      ? r.makespan
      : Math.max(...g.requested.map((id) => r.finish.get(id) ?? 0))
  const latC = lat(rc)
  const latR = lat(rr)
  return {
    name: g.name,
    workers: g.workers,
    tasks: g.tasks.length,
    msCount: rc.makespan,
    msRemCP: rr.makespan,
    msDeltaPct: pct(rc.makespan, rr.makespan),
    msColdDeltaPct: pct(rc.makespan, rcold.makespan),
    latCount: latC,
    latRemCP: latR,
    latDeltaPct: pct(latC, latR),
  }
}

const GRAPHS: BenchGraph[] = [
  deepChain(200, 50),
  wideFan(500, 40),
  diamond(200, 30),
  grahamAnomaly(),
  workBound(400, 25, 8),
  cpBound(60, 300),
  mixedLayered(20, 40, 8, 1),
  mixedLayered(30, 60, 12, 2),
  mixedLayered(40, 50, 16, 3),
]

function fmt(n: number): string {
  return n.toFixed(0)
}
function sign(n: number): string {
  const s = n.toFixed(1)
  return n > 0 ? `+${s}` : s
}

async function main(): Promise<void> {
  selfValidate()
  const rows = GRAPHS.map(measure)

  const header = [
    'graph',
    'w',
    'tasks',
    'ms:count',
    'ms:remCP',
    'Δms%',
    'Δms%cold',
    'lat:count',
    'lat:remCP',
    'Δlat%',
  ]
  const lines = rows.map((r) => [
    r.name,
    String(r.workers),
    String(r.tasks),
    fmt(r.msCount),
    fmt(r.msRemCP),
    sign(r.msDeltaPct),
    sign(r.msColdDeltaPct),
    fmt(r.latCount),
    fmt(r.latRemCP),
    sign(r.latDeltaPct),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)))
  const pad = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  const out: string[] = []
  out.push('Scheduler policy benchmark — makespan + requested-output latency')
  out.push('(negative Δ = remCP/predictive is FASTER than the duration-blind default)')
  out.push('')
  out.push(pad(header))
  out.push(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const l of lines) out.push(pad(l))

  const mixed = rows.filter((r) => r.name.startsWith('mixed'))
  const meanMixedMs = mixed.reduce((a, r) => a + r.msDeltaPct, 0) / (mixed.length || 1)
  const worstMs = Math.max(...rows.map((r) => r.msDeltaPct))
  out.push('')
  out.push(`mixed-duration makespan Δ (mean): ${sign(meanMixedMs)}%  ← the Phase-2 signal`)
  out.push(`worst makespan regression across ALL shapes: ${sign(worstMs)}%`)
  const report = out.join('\n')
  console.log(report)

  if (process.argv.includes('--md')) {
    const md = [
      '# Scheduler policy benchmark',
      '',
      'Generated by `bun bench/schedule-policy.ts --md`. Compares the makespan +',
      'requested-output latency of the duration-blind default priority (`count` =',
      '`computeReverseDepCount`) vs the time-based predictive priority (`remCP` =',
      '`mergePriorities(count, computePredictedPriorities)`), via a deterministic',
      "discrete-event simulation of `runGraph`'s greedy exec-tier list policy.",
      'Negative Δ = predictive is faster.',
      '',
      '```',
      report,
      '```',
    ].join('\n')
    await Bun.write('bench/schedule-policy.md', md + '\n')
    console.log('\nwrote bench/schedule-policy.md')
  }
}

await main()
