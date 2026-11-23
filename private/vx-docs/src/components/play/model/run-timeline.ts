// The run-timeline simulator: one cold `vx run build test lint` over the
// story workspace, scheduled the way vx's scheduler does it. No DOM here.
//
// Rules modelled, each from the source:
// - A task starts only once every task it depends on succeeded
//   (packages/vx/src/graph/scheduler.ts, `willSkip`).
// - Default: a failure skips its dependents, transitively, and every
//   independent task still runs to the end (docs/cli.md § Failure
//   propagation). A skip names the root of its block: `skipped (blocked by
//   @demo/ui#build)` (scheduler.ts `skip`, report/events.ts `skippedLabel`).
// - `--fail-fast` / `run.failFast`: the first failure stops the run. Tasks
//   still running are killed and end `aborted`; every task not started ends
//   `skipped`, bare when nothing it waits on failed.
// - At most `concurrency` tasks run at once (`--concurrency`).
// - Among ready tasks, the longest remaining path runs first; ties go in the
//   order they became ready. That is the critical-path score
//   (src/graph/critical-path.ts) the `@vzn/vx-history` schedule plugin feeds
//   the ready heap (src/graph/ready-heap.ts). Core alone ranks by how many
//   tasks wait on each one (src/graph/priorities.ts); on this graph both put
//   @demo/ui#build first.
// - The summary's task row: failed · success · skipped · aborted · total,
//   where total counts every task (src/report/summary.ts
//   `formatSummarySection`).
//
// Durations are made-up units: bar lengths are an example, not a speed claim.

export interface SimTask {
  id: string
  command: string
  deps: readonly string[]
  /** Made-up time units. */
  units: number
}

export const STORY_TASKS: readonly SimTask[] = [
  { id: '@demo/ui#build', command: 'vite build', deps: [], units: 4 },
  { id: '@demo/ui#test', command: 'vitest run', deps: [], units: 3 },
  { id: '@demo/ui#lint', command: 'oxlint', deps: [], units: 1 },
  { id: '@demo/web#build', command: 'vite build', deps: ['@demo/ui#build'], units: 3 },
  { id: '@demo/web#test', command: 'vitest run', deps: ['@demo/ui#build'], units: 2 },
  { id: '@demo/web#lint', command: 'oxlint', deps: [], units: 1 },
  { id: '@demo/docs#build', command: 'vite build', deps: [], units: 2 },
  { id: '@demo/docs#lint', command: 'oxlint', deps: [], units: 1 },
]

export type Status = 'success' | 'failed' | 'skipped' | 'aborted'

export interface Outcome {
  id: string
  status: Status
  /** The task at the root of a skip's block; absent for fail-fast's bare skip. */
  blockedBy?: string
  /** Lane and time span, for a task that started. */
  lane?: number
  start?: number
  end?: number
}

export interface Options {
  concurrency: number
  fail?: string | undefined
  failFast: boolean
}

export interface Run {
  /** In the order the tasks were listed. */
  outcomes: Outcome[]
  /** When the last task ended. */
  end: number
  counts: Record<Status, number>
}

/** Each task's own units plus the longest chain of tasks waiting on it. */
export function remainingPath(tasks: readonly SimTask[]): Map<string, number> {
  const memo = new Map<string, number>()
  const of = (t: SimTask): number => {
    const known = memo.get(t.id)
    if (known !== undefined) return known
    const after = tasks.filter((d) => d.deps.includes(t.id)).map(of)
    const v = t.units + Math.max(0, ...after)
    memo.set(t.id, v)
    return v
  }
  for (const t of tasks) of(t)
  return memo
}

export function simulate(opts: Options, tasks: readonly SimTask[] = STORY_TASKS): Run {
  const rank = remainingPath(tasks)
  const out = new Map<string, Outcome>()
  const running: Outcome[] = []
  const ready: string[] = []
  let readySeq = 0
  const readyAt = new Map<string, number>()
  let stopped = false
  let now = 0

  const settled = (id: string) =>
    out.get(id)?.end !== undefined || out.get(id)?.status === 'skipped'
  const blockerOf = (t: SimTask): string | undefined => {
    for (const d of t.deps) {
      const o = out.get(d)!
      if (o.status === 'failed' || o.status === 'aborted') return d
    }
    for (const d of t.deps) {
      const o = out.get(d)!
      if (o.status === 'skipped' && o.blockedBy !== undefined) return o.blockedBy
    }
    return undefined
  }
  // Settle what can no longer run, and queue what can, until nothing changes.
  const release = () => {
    for (let changed = true; changed;) {
      changed = false
      for (const t of tasks) {
        if (out.has(t.id) || readyAt.has(t.id) || !t.deps.every(settled)) continue
        const blocked = t.deps.some((d) => out.get(d)!.status !== 'success')
        if (blocked || stopped) {
          const blockedBy = blockerOf(t)
          out.set(t.id, { id: t.id, status: 'skipped', ...(blockedBy ? { blockedBy } : {}) })
          changed = true
        } else {
          readyAt.set(t.id, readySeq++)
          ready.push(t.id)
        }
      }
    }
  }
  const dispatch = () => {
    ready.sort((a, b) => rank.get(b)! - rank.get(a)! || readyAt.get(a)! - readyAt.get(b)!)
    while (!stopped && running.length < opts.concurrency && ready.length > 0) {
      const id = ready.shift()!
      const busy = new Set(running.map((r) => r.lane))
      let lane = 0
      while (busy.has(lane)) lane++
      const t = tasks.find((x) => x.id === id)!
      const o: Outcome = {
        id,
        status: id === opts.fail ? 'failed' : 'success',
        lane,
        start: now,
        end: now + t.units,
      }
      // `end` marks a finished task for `settled`; a running one is tracked apart.
      running.push(o)
    }
  }

  release()
  dispatch()
  while (running.length > 0) {
    now = Math.min(...running.map((r) => r.end!))
    const done = running.filter((r) => r.end === now)
    for (const r of done) {
      running.splice(running.indexOf(r), 1)
      out.set(r.id, r)
    }
    if (opts.failFast && done.some((r) => r.status === 'failed')) {
      stopped = true
      for (const r of running.splice(0)) out.set(r.id, { ...r, status: 'aborted', end: now })
      for (const id of ready.splice(0)) out.set(id, { id, status: 'skipped' })
    }
    release()
    dispatch()
  }

  const counts: Record<Status, number> = { success: 0, failed: 0, skipped: 0, aborted: 0 }
  const outcomes = tasks.map((t) => out.get(t.id)!)
  for (const o of outcomes) counts[o.status]++
  return { outcomes, end: now, counts }
}

/** A task's status as vx's outcome table words it. */
export function statusLabel(o: Outcome): string {
  if (o.status === 'failed') return 'failed (exit 1)'
  if (o.status === 'skipped')
    return o.blockedBy === undefined ? 'skipped' : `skipped (blocked by ${o.blockedBy})`
  return o.status
}

/** The summary's `tasks` row, its parts in vx's fixed order with their tones. */
export function summaryParts(run: Run): Array<{ text: string; tone: Status | 'total' }> {
  const c = run.counts
  const parts: Array<{ text: string; tone: Status | 'total' }> = []
  if (c.failed > 0) parts.push({ text: `${c.failed} failed`, tone: 'failed' })
  if (c.success > 0) parts.push({ text: `${c.success} success`, tone: 'success' })
  if (c.skipped > 0) parts.push({ text: `${c.skipped} skipped`, tone: 'skipped' })
  if (c.aborted > 0) parts.push({ text: `${c.aborted} aborted`, tone: 'aborted' })
  parts.push({ text: `${run.outcomes.length} total`, tone: 'total' })
  return parts
}

/** The command line the controls stand for. */
export function commandLine(opts: Options): string {
  return `vx run build test lint --concurrency ${opts.concurrency}${opts.failFast ? ' --fail-fast' : ''}`
}

/** The command line as HTML, each word unbreakable so a narrow screen wraps between flags. */
export function commandHtml(opts: Options): string {
  return commandLine(opts)
    .split(' ')
    .map((w) => `<span class="w">${esc(w)}</span>`)
    .join(' ')
}

/** One plain sentence on what the run did. */
export function sentence(run: Run, opts: Options): string {
  const { failed, skipped, aborted } = run.counts
  if (failed === 0) {
    const took = `Everything ran. ${opts.concurrency} at a time, the run took ${run.end} units.`
    if (opts.concurrency === 1) return took
    return `${took} One at a time would take ${simulate({ ...opts, concurrency: 1 }).end}.`
  }
  if (opts.failFast) {
    const killed =
      aborted === 0
        ? 'Nothing else was running.'
        : `${aborted} running task${aborted === 1 ? ' was' : 's were'} killed.`
    return `${opts.fail} failed, so vx stopped at once. ${killed} ${skipped} never started.`
  }
  if (skipped === 0)
    return `${opts.fail} failed. Nothing waits on it, so every other task still ran.`
  return `${opts.fail} failed. Only the ${skipped} task${skipped === 1 ? '' : 's'} waiting on it ${skipped === 1 ? 'was' : 'were'} skipped; the rest still ran.`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const TONE: Record<Status | 'total', string> = {
  success: 'is-ok',
  failed: 'is-danger',
  skipped: 'is-warn',
  aborted: 'is-danger quiet',
  total: 'is-muted',
}

const short = (id: string) => id.replace(/^@demo\//, '')

/**
 * The timeline, the tasks that never started and the summary row, as HTML.
 * One copy for the build-time render and the browser: the static state is
 * the same markup the element writes. Each bar carries its start and units so
 * the element can play it.
 */
export function renderRun(run: Run, opts: Options): string {
  const span = Math.max(run.end, 1)
  const pct = (n: number) => `${((n / span) * 100).toFixed(3)}%`
  const lanes = Array.from({ length: opts.concurrency }, (_, lane) => {
    const bars = run.outcomes
      .filter((o) => o.lane === lane)
      .map(
        (o) =>
          `<li class="bar is-${o.status}" style="left:${pct(o.start!)};width:${pct(o.end! - o.start!)}"` +
          ` data-start="${o.start}" data-units="${o.end! - o.start!}" title="${esc(`${o.id}: ${statusLabel(o)}`)}">` +
          `<span class="fill"></span><span class="name" aria-hidden="true">${esc(short(o.id))}</span>` +
          `<span class="sr-only">${esc(`${o.id}: ${statusLabel(o)}`)}</span></li>`,
      )
      .join('')
    return `<li class="lane"><span class="slot">slot ${lane + 1}</span><ol class="track" role="list">${bars}</ol></li>`
  }).join('')
  const never = run.outcomes.filter((o) => o.start === undefined)
  const skipped =
    never.length === 0
      ? ''
      : `<p class="never"><span class="vx-label">never started</span> ${never
          .map(
            (o) =>
              `<span class="chip is-skipped" title="${esc(statusLabel(o))}">${esc(short(o.id))}</span>`,
          )
          .join(' ')}</p>`
  const summary = summaryParts(run)
    .map((p) => `<span class="${TONE[p.tone]}">${esc(p.text)}</span>`)
    .join(' <span class="is-muted">·</span> ')
  const table = run.outcomes
    .map((o) => {
      const status = statusLabel(o)
      return `<span class="id">${esc(o.id)}</span>${' '.repeat(18 - o.id.length)}<span class="${TONE[o.status]}">${esc(status)}</span>`
    })
    .join('\n')
  return (
    `<ol class="lanes" role="list" aria-label="${esc(`What ran in each of ${opts.concurrency} slots`)}">${lanes}</ol>` +
    `<p class="axis"><span>0</span><span>time →</span><span>${run.end} units</span></p>` +
    skipped +
    `<div class="term"><pre tabindex="0" aria-label="Each task's outcome, as vx words it">${table}</pre>` +
    `<p class="tasks"><span class="is-muted">tasks</span>  ${summary}</p></div>`
  )
}
