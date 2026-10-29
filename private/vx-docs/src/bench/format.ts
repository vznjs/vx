// The head-to-head's figures as the site prints them, from the data
// scripts/bench-data.ts gathers (2026-10-29: no figure on the site is typed
// by hand). Pages name a figure with a token, `%bench.vx.warm%`; the
// Markdown plugin (src/plugins/bench.ts), the agents' Markdown
// (src/llms/pages.ts) and the landing fill it. An unknown token fails the
// build rather than print itself.

export const RUNNERS = ['vx', 'turbo', 'nx', 'vite-task'] as const
export type Runner = (typeof RUNNERS)[number]

/** One runner's measured run: compare.ts's row, its machine and its baseline. */
export interface RunnerResult {
  date: string
  machine: { os: string; cores: number; cpu: string; memoryGb: number }
  reps: number
  coldReps: number
  row: {
    runner: string
    version: string
    fresh: number
    warmNoRestore: number
    warmRestore: number
    freshCpu: number
    warmNoRestoreCpu: number
    warmRestoreCpu: number
  }
  baseline: {
    fresh: number
    warmNoRestore: number
    warmRestore: number
    freshCpu: number
    criticalPathMs: number
    workBoundMs: number
  }
}

export interface BenchData {
  shape: string
  packages: number
  tasks: number
  levels: number
  buildMs: number
  concurrency: number
  runners: Record<Runner, RunnerResult>
}

/** How the pages name each runner in a token. */
const ALIAS: Record<string, Runner> = { vx: 'vx', turbo: 'turbo', nx: 'nx', vt: 'vite-task' }
export const NAMES: Record<Runner, string> = {
  vx: 'vx',
  turbo: 'Turborepo',
  nx: 'Nx',
  'vite-task': 'Vite Task',
}

/** `3 min 6 s`, `24.15 s`, `799 ms`. */
export function duration(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms - m * 60_000) / 1000)
    return s === 60 ? `${m + 1} min 0 s` : `${m} min ${s} s`
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.round(ms)} ms`
}

/** What a runner adds over the ideal run; never below zero, a run under the ideal is noise. */
export function overhead(r: RunnerResult): Record<'warm' | 'restore' | 'cold' | 'cpu', number> {
  const { row, baseline: b } = r
  return {
    warm: Math.max(0, row.warmNoRestore - b.warmNoRestore),
    restore: Math.max(0, row.warmRestore - b.warmRestore),
    cold: Math.max(0, row.fresh - b.fresh),
    cpu: Math.max(0, row.freshCpu - b.freshCpu),
  }
}

const n = (x: number): string => x.toLocaleString('en-US')

/** The machine a run took, in a few words. */
export function machine(r: RunnerResult): string {
  const m = r.machine
  return `${m.os}, ${m.cores} cores (${m.cpu}), ${m.memoryGb} GB`
}

/** Every token a page may use, and its text. */
export function figures(d: BenchData): Map<string, string> {
  const out = new Map<string, string>()
  const vx = d.runners.vx
  out.set('tasks', n(d.tasks))
  out.set('projects', n(d.packages))
  out.set('levels', String(d.levels))
  out.set('concurrency', String(d.concurrency))
  // Each task's sleep, in the shape's ratios (private/vx-bench/shape.ts).
  out.set('task.build', duration(d.buildMs))
  out.set('task.test', duration(d.buildMs / 2))
  out.set('task.lint', duration(d.buildMs / 4))
  out.set('task.publish', duration(d.buildMs / 10))
  out.set('ideal.cold', duration(vx.baseline.fresh))
  out.set('ideal.critical', duration(vx.baseline.criticalPathMs))
  out.set('ideal.work', duration(vx.baseline.workBoundMs))
  out.set('ideal.cpu', duration(vx.baseline.freshCpu))
  for (const [alias, runner] of Object.entries(ALIAS)) {
    const r = d.runners[runner]
    for (const [k, ms] of Object.entries(overhead(r))) out.set(`${alias}.${k}`, duration(ms))
    out.set(`${alias}.version`, r.row.version)
    out.set(`${alias}.date`, r.date.slice(0, 10))
    out.set(`${alias}.machine`, machine(r))
  }
  out.set('provenance', provenance(d))
  return out
}

/** Which build of each tool ran, when, and where. */
export function provenance(d: BenchData): string {
  const runs = RUNNERS.map((runner) => {
    const r = d.runners[runner]
    const v = runner === 'vx' ? r.row.version.replace(/^vx /, '') : r.row.version
    return `${NAMES[runner]} ${v} on ${r.date.slice(0, 10)}`
  })
  const machines = [...new Set(RUNNERS.map((runner) => machine(d.runners[runner])))]
  return `Measured: ${runs.join(', ')}; ${machines.join(' and ')}.`
}

export const TOKEN = /%bench\.([a-z.-]+)%/g

/** The text with every `%bench.…%` token filled; an unknown one throws. */
export function fill(text: string, table: Map<string, string>): string {
  return text.replace(TOKEN, (_, key: string) => {
    const v = table.get(key)
    if (v === undefined) throw new Error(`unknown benchmark token %bench.${key}%`)
    return v
  })
}
