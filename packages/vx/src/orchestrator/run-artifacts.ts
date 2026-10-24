// `--profile[=<path>]`: Chrome-trace JSON of the run. Each task is a single
// complete event (`ph: 'X'`) with ts / dur in microseconds derived from the
// hrtime spans the runner already captures. Default path: profile.json
// (cwd-relative).

import path from 'node:path'
import type { TaskOutcome } from '../graph/index.js'

export interface ProfileArgs {
  target: string
  cwd: string
  outcomes: readonly TaskOutcome[]
  /** Each executor's own events (`TaskExecutor.profile`), `ts` on `performance.now()`. */
  executors?: readonly (readonly Record<string, unknown>[])[]
}

// ns → us; bigint arithmetic to avoid precision loss before converting to
// a JSON-safe number.
function spanUs(o: TaskOutcome): { startUs: number; durUs: number } {
  return {
    startUs: Number(o.wallclockStartNs! / 1000n),
    durUs: Number((o.wallclockEndNs! - o.wallclockStartNs!) / 1000n),
  }
}

/**
 * Each task's `tid`: its project's lane, or the project's next lane when it
 * overlaps a task already there. Slices on one thread must nest, and two
 * tasks of one project running side by side do not: Perfetto drops one.
 */
function lanes(timed: readonly TaskOutcome[]): Map<TaskOutcome, number> {
  const ends = new Map<string, { tid: number; endUs: number }[]>()
  const tidOf = new Map<TaskOutcome, number>()
  let tids = 0
  const byStart = timed.map((o) => ({ o, ...spanUs(o) })).sort((a, b) => a.startUs - b.startUs)
  for (const { o, startUs, durUs } of byStart) {
    let own = ends.get(o.node.projectName)
    if (own === undefined) ends.set(o.node.projectName, (own = []))
    let lane = own.find((l) => l.endUs <= startUs)
    if (lane === undefined) own.push((lane = { tid: ++tids, endUs: 0 }))
    lane.endUs = startUs + durUs
    tidOf.set(o, lane.tid)
  }
  return tidOf
}

/**
 * Chrome trace JSON. Spec:
 *   https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
 *
 * One complete event (`ph: 'X'`) per task with `ts` and `dur` in
 * microseconds (Chrome's unit; we have ns from hrtime, divide by 1000).
 * Each project gets its own `tid`, and one more for each task it runs
 * beside another, so concurrent tasks render on distinct rows.
 */
export async function writeRunProfile(args: ProfileArgs): Promise<string> {
  const outPath = path.resolve(args.cwd, args.target)
  const timed = args.outcomes.filter(
    (o) => o.wallclockStartNs !== undefined && o.wallclockEndNs !== undefined,
  )
  const tidOf = lanes(timed)
  const traceEvents = timed.map((o) => {
    const tid = tidOf.get(o)!
    const { startUs, durUs } = spanUs(o)
    return {
      name: o.node.id,
      cat: o.status,
      ph: 'X',
      ts: startUs,
      dur: durUs,
      pid: 1,
      tid,
      args: {
        exitCode: o.exitCode,
        hash: o.hash ?? null,
        ...(o.cpuMs !== undefined ? { cpuMs: o.cpuMs } : {}),
        ...(o.peakRssBytes !== undefined ? { peakRssBytes: o.peakRssBytes } : {}),
        // A remote hit's download and ingest: the rest of its span is vx's.
        ...(o.fetchMs !== undefined ? { fetchMs: o.fetchMs } : {}),
      },
    }
  })
  // An executor's processes follow the run's own, each executor's after
  // the last; its times move onto the runner's hrtime clock.
  const shiftUs = Number(process.hrtime.bigint() / 1000n) - performance.now() * 1000
  let next = 2
  const theirs: Record<string, unknown>[] = []
  for (const events of args.executors ?? []) {
    let top = 0
    for (const e of events) {
      const pid = typeof e['pid'] === 'number' ? e['pid'] : 1
      top = Math.max(top, pid)
      theirs.push({
        ...e,
        pid: next - 1 + pid,
        ...(typeof e['ts'] === 'number' ? { ts: Math.round(e['ts'] + shiftUs) } : {}),
      })
    }
    next += top
  }
  const named =
    theirs.length === 0
      ? []
      : [{ ph: 'M', name: 'process_name', pid: 1, tid: 0, args: { name: 'run' } }]
  await Bun.write(
    outPath,
    JSON.stringify({ traceEvents: [...named, ...traceEvents, ...theirs] }, null, 2),
  )
  return outPath
}
