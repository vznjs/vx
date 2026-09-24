// The scheduler simulator's model (Learn page W4, item 685). It computes no
// schedule itself: `schedule()` hands the graph to vx-bench's simulator,
// which ranks ready tasks with vx's own code (core's
// `computeReverseDepCount` and `mergePriorities`, the history plugin's
// `criticalPathPriorities`) and whose dispatch loop the bench holds to the
// real `runGraph`. The page's static render and the element that redraws it
// both read this module, so the fallback and the live chart are one code
// path. What is here is the page's own: the graph, the worker lanes a Gantt
// chart draws, the bounds, and the SVG.

import {
  pluginPriorities,
  POLICIES,
  priorities,
  simulate,
  type Policy,
  type SimTask,
} from '../../../../../vx-bench/schedule-policy.js'

export { POLICIES, type Policy, type SimTask }

const s = (id: string, seconds: number, deps: string[] = []): SimTask => ({
  id,
  deps,
  dur: seconds * 1000,
})

/** W1's toy monorepo with a lint task per package and `app#docs`, which
 *  builds app's documentation: it is long, waits for nothing and nothing
 *  waits on it. Durations in ms. */
export const SIM_TASKS: readonly SimTask[] = [
  s('utils#build', 6),
  s('utils#test', 3, ['utils#build']),
  s('ui#build', 2, ['utils#build']),
  s('ui#test', 1, ['ui#build']),
  s('api#build', 6, ['utils#build']),
  s('api#test', 2, ['api#build']),
  s('app#build', 6, ['ui#build', 'api#build']),
  s('app#test', 6, ['app#build']),
  s('utils#lint', 1),
  s('ui#lint', 2),
  s('api#lint', 1),
  s('app#lint', 2),
  s('app#docs', 10),
]

export const DEFAULT_WORKERS = 2
export const MAX_WORKERS = 4
export const MAX_SECONDS = 30
/** The pair the static page draws: vx with no plugin, and with the history plugin. */
export const DEFAULT_PAIR: readonly [Policy, Policy] = ['count', 'median']

export const POLICY_NAME: Record<Policy, string> = {
  count: 'Tasks waiting',
  median: 'Learned durations',
  'unknown-first': 'No history first',
  oracle: 'True durations',
}

export const POLICY_NOTE: Record<Policy, string> = {
  count: 'vx',
  median: 'history plugin',
  'unknown-first': 'measured, not adopted',
  oracle: 'knows every time',
}

export interface Bar {
  id: string
  /** 1-based worker lane. */
  lane: number
  start: number
  end: number
}

export interface Schedule {
  policy: Policy
  workers: number
  makespan: number
  bars: Bar[]
}

/** Run `tasks` on `workers` under `policy`, where `unknown` holds the tasks
 *  the history has never seen, and lay the result out in worker lanes. */
export function schedule(
  tasks: readonly SimTask[],
  unknown: ReadonlySet<string>,
  policy: Policy,
  workers: number,
): Schedule {
  const { makespan, spans } = simulate(tasks, priorities(policy, tasks, unknown), workers)
  // vx's workers have no identity; a chart needs lanes. Each task takes the
  // lowest lane free when it starts, in dispatch order (which is start order).
  const freeAt: number[] = Array.from({ length: workers }, () => 0)
  const bars = spans.map((span) => {
    const lane = freeAt.findIndex((t) => t <= span.start)
    freeAt[lane] = span.end
    return { id: span.id, lane: lane + 1, start: span.start, end: span.end }
  })
  return { policy, workers, makespan, bars }
}

/** The longest chain of dependent work, by true duration: the remaining
 *  critical path the history plugin scores, with every task known. */
export function criticalPath(tasks: readonly SimTask[]): { length: number; chain: string[] } {
  const remaining = pluginPriorities('oracle', tasks, new Set())!
  const longest = (ids: readonly string[]): string =>
    ids.reduce((best, id) => (remaining.get(id)! > remaining.get(best)! ? id : best))
  const chain = [longest(tasks.filter((t) => t.deps.length === 0).map((t) => t.id))]
  for (;;) {
    const next = tasks.filter((t) => t.deps.includes(chain.at(-1)!)).map((t) => t.id)
    if (next.length === 0) break
    chain.push(longest(next))
  }
  return { length: remaining.get(chain[0]!)!, chain }
}

function totalWork(tasks: readonly SimTask[]): number {
  return tasks.reduce((sum, t) => sum + t.dur, 0)
}

/** No order finishes sooner: the critical path runs one task at a time,
 *  and the work cannot be done faster than all workers busy. */
export function lowerBound(tasks: readonly SimTask[], workers: number): number {
  return Math.max(criticalPath(tasks).length, totalWork(tasks) / workers)
}

/** `27 s`, `23.5 s`. */
export function secs(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}

/** The bound in one line, with what sets it: the longest chain, or all
 *  the work shared by the workers. */
export function boundsSentence(tasks: readonly SimTask[], workers: number): string {
  const chain = criticalPath(tasks).length
  const shared = totalWork(tasks) / workers
  const why =
    chain >= shared
      ? `the longest chain takes ${secs(chain)}`
      : `all the work on ${workers === 1 ? '1 worker' : `${workers} workers`} takes ${secs(shared)}`
  return `No order beats ${secs(lowerBound(tasks, workers))}: ${why}.`
}

/** What the chart shows, in words: its text alternative. */
export function describeSchedule(sched: Schedule): string {
  const lanes = Array.from({ length: sched.workers }, (_, i) => {
    const bars = sched.bars.filter((b) => b.lane === i + 1)
    const runs =
      bars.length === 0
        ? 'nothing'
        : bars.map((b) => `${b.id} ${b.start / 1000}–${b.end / 1000} s`).join(', ')
    return `worker ${i + 1} runs ${runs}`
  })
  return `${POLICY_NAME[sched.policy]} on ${sched.workers === 1 ? '1 worker' : `${sched.workers} workers`} finishes at ${secs(sched.makespan)}: ${lanes.join('; ')}.`
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const GANTT = { width: 600, gutter: 64, right: 10, lane: 38, bar: 32, axis: 22 }

/** The Gantt chart as SVG markup, on a time axis `span` ms long, so two
 *  charts drawn with one span compare by eye. */
export function ganttSvg(
  sched: Schedule,
  span: number,
  bound: number,
  unknown: ReadonlySet<string>,
  critical: ReadonlySet<string>,
): string {
  const { width, gutter, right, lane, bar, axis } = GANTT
  const px = (width - gutter - right) / span
  const x = (ms: number): number => Math.round((gutter + ms * px) * 10) / 10
  const height = sched.workers * lane + axis
  const step = span <= 30_000 ? 2000 : 5000
  const parts: string[] = [
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(describeSchedule(sched))}">`,
  ]
  for (let i = 1; i <= sched.workers; i++) {
    const y = (i - 1) * lane
    parts.push(
      `<text class="lane-label" x="0" y="${y + lane / 2 + 4}">worker ${i}</text>`,
      `<line class="lane-rule" x1="${gutter}" y1="${y + lane}" x2="${width - right}" y2="${y + lane}"></line>`,
    )
  }
  for (let t = 0; t <= span; t += step) {
    parts.push(
      `<text class="tick" x="${x(t)}" y="${height - 6}">${t / 1000}</text>`,
      `<line class="tick-rule" x1="${x(t)}" y1="0" x2="${x(t)}" y2="${sched.workers * lane}"></line>`,
    )
  }
  for (const b of sched.bars) {
    const classes = [
      'bar',
      critical.has(b.id) ? 'is-critical' : '',
      unknown.has(b.id) ? 'is-unknown' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const w = x(b.end) - x(b.start)
    // Package over task, when the longer of the two fits the bar in the
    // diagram's mono at 11px (0.6em a character).
    const [pkg, task] = b.id.split('#') as [string, string]
    const fits = Math.max(pkg.length, task.length) * 6.6 + 6 <= w
    const cx = x(b.start) + w / 2
    const cy = (b.lane - 1) * lane + lane / 2
    parts.push(
      `<g class="${classes}" data-task="${b.id}" data-lane="${b.lane}" data-start="${b.start}" data-end="${b.end}">`,
      `<rect x="${x(b.start) + 1}" y="${(b.lane - 1) * lane + (lane - bar) / 2}" width="${Math.max(w - 2, 1)}" height="${bar}" rx="8"></rect>`,
      fits
        ? `<text x="${cx}" y="${cy - 2}">${pkg}</text><text x="${cx}" y="${cy + 11}">${task}</text>`
        : '',
      `<title>${b.id}: ${b.start / 1000}–${b.end / 1000} s</title>`,
      '</g>',
    )
  }
  parts.push(
    `<line class="bound" data-bound="${bound}" x1="${x(bound)}" y1="0" x2="${x(bound)}" y2="${sched.workers * lane}"></line>`,
    `<line class="done" data-done="${sched.makespan}" x1="${x(sched.makespan)}" y1="0" x2="${x(sched.makespan)}" y2="${sched.workers * lane}"></line>`,
    '</svg>',
  )
  return parts.join('')
}

/** Finish times for every worker count and policy, over one set of tasks. */
export function finishTable(
  tasks: readonly SimTask[],
  unknown: ReadonlySet<string>,
): { workers: number; bound: number; makespans: Record<Policy, number> }[] {
  return Array.from({ length: MAX_WORKERS }, (_, i) => {
    const workers = i + 1
    const makespans = {} as Record<Policy, number>
    for (const p of POLICIES) makespans[p] = schedule(tasks, unknown, p, workers).makespan
    return { workers, bound: lowerBound(tasks, workers), makespans }
  })
}
