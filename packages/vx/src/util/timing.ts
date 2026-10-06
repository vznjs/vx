// Stage timing for the run path, printed to stderr when `VX_TIMING` is set.
//
// The CPU profiler attributes a tight loop's cost unreliably and hides
// where an `await` waited; a stage table answers "where did the warm run
// go?" directly. Marks are cumulative from this module's load — process
// start and the imports ahead of it sit outside the table; the table shows
// each stage's own share. Stage marks are kept whether or not the table
// prints (a push per stage, ~15 a run): a telemetry sink draws them as
// spans (`stageTimes`). The per-call `span`s stay off unless enabled.

const enabled = process.env.VX_TIMING !== undefined && process.env.VX_TIMING !== ''
let t0 = Bun.nanoseconds()
// The wall clock at t0, read then: `performance.timeOrigin` plus the
// monotonic clock drifted 34 ms from `Date.now()` on macOS CI, so stages
// drawn from it sat outside the run they belong to.
let wall0 = Date.now()
const marks: Array<[label: string, ns: number]> = []

let begun = false

/**
 * A run begins. The process's first counts from this module's load, so
 * `startup` holds the imports; a later one in the same process (an
 * embedder's second `run()`) starts a table of its own, or its stages
 * would follow the last run's and its `startup` would hold the idle between.
 */
export function beginRun(): void {
  if (begun) restartTimings()
  begun = true
}

/** Record the end of a stage. */
export function mark(label: string): void {
  marks.push([label, Bun.nanoseconds() - t0])
}

/** One stage's wall window, in epoch ms. */
export interface StageTime {
  name: string
  startedAt: number
  endedAt: number
}

/** The stages marked so far, each from the previous mark's end (the first from this module's load). */
export function stageTimes(): StageTime[] {
  let prev = 0
  return marks.map(([name, ns]) => {
    const stage = { name, startedAt: wall0 + prev / 1e6, endedAt: wall0 + ns / 1e6 }
    prev = ns
    return stage
  })
}

const spans = new Map<string, [count: number, ns: number]>()
const noop = (): void => {}

/**
 * Start a new table: `vx watch` runs one per cycle in one process, and
 * without this a cycle's table reprinted every earlier cycle's rows and
 * its first stage counted the idle wait before it.
 */
export function restartTimings(): void {
  t0 = Bun.nanoseconds()
  wall0 = Date.now()
  marks.length = 0
  spans.clear()
}

/**
 * Time one occurrence of a repeated operation (a per-task probe, a restore):
 * `const end = span('probe'); …; end()`. Accumulated by label and printed
 * under the stage table. Returns a shared no-op when off, so the hot path
 * allocates nothing.
 */
export function span(label: string): () => void {
  if (!enabled) return noop
  const start = Bun.nanoseconds()
  return () => {
    const cur = spans.get(label)
    const ns = Bun.nanoseconds() - start
    if (cur === undefined) spans.set(label, [1, ns])
    else {
      cur[0]++
      cur[1] += ns
    }
  }
}

/** Print the stage table (once, at the end of a run). No-op unless enabled. */
export function printTimings(): void {
  if (!enabled || marks.length === 0) return
  const width = Math.max(...marks.map(([l]) => l.length))
  let prev = 0
  const lines = ['[vx timing]  stage'.padEnd(width + 14) + '    own   cumulative']
  for (const [label, ns] of marks) {
    const own = (ns - prev) / 1e6
    lines.push(
      `             ${label.padEnd(width)}  ${own.toFixed(1).padStart(6)}ms  ${(ns / 1e6).toFixed(1).padStart(8)}ms`,
    )
    prev = ns
  }
  if (spans.size > 0) {
    lines.push('[vx timing]  accumulated                     total   count')
    for (const [label, [count, ns]] of [...spans].sort((a, b) => b[1][1] - a[1][1])) {
      lines.push(
        `             ${label.padEnd(24)}  ${(ns / 1e6).toFixed(1).padStart(8)}ms  ${String(count).padStart(6)}`,
      )
    }
    // The trap this table sets, said where it is sprung: a span's total is
    // WALL summed per call, and the run's spans are taken under the
    // scheduler's concurrency, so a span that overlaps other work reads
    // far larger than the work it names. `output dirs` at 124 µs a task is
    // a handful of `lstat`s (items 254 and 407). Compare spans to each
    // other, and measure a suspect one in isolation before chasing it.
    lines.push(
      '             (wall per call, summed; concurrent calls overlap — compare spans, not totals)',
    )
  }
  process.stderr.write(lines.join('\n') + '\n')
}
