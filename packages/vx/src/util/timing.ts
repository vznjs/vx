// Stage timing for the run path, printed to stderr when `VX_TIMING` is set.
//
// The CPU profiler attributes a tight loop's cost unreliably and hides
// where an `await` waited; a stage table answers "where did the warm run
// go?" directly, and costs one boolean check per mark when off. Marks are
// cumulative from process start; the table shows each stage's own share.

const enabled = process.env.VX_TIMING !== undefined && process.env.VX_TIMING !== ''
const t0 = Bun.nanoseconds()
const marks: Array<[label: string, ns: number]> = []

/** Record the end of a stage. No-op unless `VX_TIMING` is set. */
export function mark(label: string): void {
  if (!enabled) return
  marks.push([label, Bun.nanoseconds() - t0])
}

const spans = new Map<string, [count: number, ns: number]>()
const noop = (): void => {}

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
  }
  process.stderr.write(lines.join('\n') + '\n')
}
