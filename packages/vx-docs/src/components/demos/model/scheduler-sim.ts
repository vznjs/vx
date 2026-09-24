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
/** The phone form: time runs down the page at `second` units a second,
 *  until a chart would pass `tall` units of time, one column per worker. */
const DOWN = {
  width: 340,
  gutter: 30,
  right: 6,
  head: 24,
  inset: 3,
  foot: 10,
  second: 12,
  tall: 576,
}

/** Whether `text` fits `room` units in the chart's mono at 11px (0.6em a character). */
const fits = (text: string, room: number): boolean => text.length * 6.6 + 6 <= room

/** The wide form's step (2 s up to a 30 s axis, else 5 s), grown until two
 *  ticks stand at least 24 units apart, so their numbers never touch. */
function tickStep(span: number, perMs: number): number {
  const steps = [2000, 5000, 10_000, 20_000, 50_000]
  return steps.slice(span <= 30_000 ? 0 : 1).find((step) => step * perMs >= 24)!
}

function barOpen(b: Bar, unknown: ReadonlySet<string>, critical: ReadonlySet<string>): string {
  const classes = [
    'bar',
    critical.has(b.id) ? 'is-critical' : '',
    unknown.has(b.id) ? 'is-unknown' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `<g class="${classes}" data-task="${b.id}" data-lane="${b.lane}" data-start="${b.start}" data-end="${b.end}">`
}

const barTitle = (b: Bar): string => `<title>${b.id}: ${b.start / 1000}–${b.end / 1000} s</title>`

const svgOpen = (
  layout: 'wide' | 'narrow',
  width: number,
  height: number,
  sched: Schedule,
): string =>
  `<svg data-layout="${layout}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(describeSchedule(sched))}">`

const tenth = (n: number): number => Math.round(n * 10) / 10

/** The Gantt chart as SVG markup, on a time axis `span` ms long, so two
 *  charts drawn with one span compare by eye. It is drawn twice, from one
 *  schedule: time across with a row per worker, and for a phone time down
 *  the page with a column per worker; the page's stylesheet shows the one
 *  that fits (the diagram kit's `narrow`, at its breakpoint). */
export function ganttSvg(
  sched: Schedule,
  span: number,
  bound: number,
  unknown: ReadonlySet<string>,
  critical: ReadonlySet<string>,
): string {
  return across(sched, span, bound, unknown, critical) + down(sched, span, bound, unknown, critical)
}

function across(
  sched: Schedule,
  span: number,
  bound: number,
  unknown: ReadonlySet<string>,
  critical: ReadonlySet<string>,
): string {
  const { width, gutter, right, lane, bar, axis } = GANTT
  const px = (width - gutter - right) / span
  const x = (ms: number): number => tenth(gutter + ms * px)
  const height = sched.workers * lane + axis
  const step = tickStep(span, px)
  const parts: string[] = [svgOpen('wide', width, height, sched)]
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
    const w = x(b.end) - x(b.start)
    // Package over task, when the longer of the two fits the bar.
    const [pkg, task] = b.id.split('#') as [string, string]
    const cx = x(b.start) + w / 2
    const cy = (b.lane - 1) * lane + lane / 2
    parts.push(
      barOpen(b, unknown, critical),
      `<rect x="${x(b.start) + 1}" y="${(b.lane - 1) * lane + (lane - bar) / 2}" width="${Math.max(w - 2, 1)}" height="${bar}" rx="8"></rect>`,
      fits(pkg.length > task.length ? pkg : task, w)
        ? `<text x="${cx}" y="${cy - 2}">${pkg}</text><text x="${cx}" y="${cy + 11}">${task}</text>`
        : '',
      barTitle(b),
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

function down(
  sched: Schedule,
  span: number,
  bound: number,
  unknown: ReadonlySet<string>,
  critical: ReadonlySet<string>,
): string {
  const { width, gutter, right, head, inset, foot, second, tall } = DOWN
  // One scale for every chart drawn over `span`, as across: a long span
  // shrinks the scale rather than the page growing past `tall`.
  const px = Math.min(second / 1000, tall / span)
  const y = (ms: number): number => tenth(head + ms * px)
  const col = (width - gutter - right) / sched.workers
  const left = (lane: number): number => tenth(gutter + (lane - 1) * col)
  const height = Math.round(head + span * px + foot)
  const step = tickStep(span, px)
  const parts: string[] = [svgOpen('narrow', width, height, sched)]
  for (let i = 1; i <= sched.workers; i++) {
    parts.push(
      `<text class="lane-label" x="${tenth(left(i) + col / 2)}" y="14">worker ${i}</text>`,
      `<line class="lane-rule" x1="${left(i)}" y1="${head}" x2="${left(i)}" y2="${y(span)}"></line>`,
    )
  }
  for (let t = 0; t <= span; t += step) {
    parts.push(
      `<text class="tick" x="${gutter - 6}" y="${tenth(y(t) + 4)}">${t / 1000}</text>`,
      `<line class="tick-rule" x1="${gutter}" y1="${y(t)}" x2="${width - right}" y2="${y(t)}"></line>`,
    )
  }
  for (const b of sched.bars) {
    const w = col - 2 * inset
    const h = y(b.end) - y(b.start) - 2
    const [pkg, task] = b.id.split('#') as [string, string]
    const cx = tenth(left(b.lane) + col / 2)
    const cy = tenth(y(b.start) + 1 + h / 2)
    // One line where the column is wide enough, else package over task, as
    // across; a bar too short for either prints none and keeps its title.
    const label =
      fits(b.id, w) && h >= 16
        ? `<text x="${cx}" y="${tenth(cy + 4)}">${b.id}</text>`
        : fits(pkg.length > task.length ? pkg : task, w) && h >= 30
          ? `<text x="${cx}" y="${tenth(cy - 2)}">${pkg}</text><text x="${cx}" y="${tenth(cy + 11)}">${task}</text>`
          : ''
    parts.push(
      barOpen(b, unknown, critical),
      `<rect x="${tenth(left(b.lane) + inset)}" y="${tenth(y(b.start) + 1)}" width="${tenth(w)}" height="${tenth(Math.max(h, 1))}" rx="8"></rect>`,
      label,
      barTitle(b),
      '</g>',
    )
  }
  parts.push(
    `<line class="bound" data-bound="${bound}" x1="${gutter}" y1="${y(bound)}" x2="${width - right}" y2="${y(bound)}"></line>`,
    `<line class="done" data-done="${sched.makespan}" x1="${gutter}" y1="${y(sched.makespan)}" x2="${width - right}" y2="${y(sched.makespan)}"></line>`,
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
