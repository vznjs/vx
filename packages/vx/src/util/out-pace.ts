// vx's own stdout and stderr hold the readers of its tasks' output back.
// A task's pipe is read on credit (exec/read-off.ts), so a reader that waits
// stalls the task as a direct pipe would. Writing to a full stdout did not
// wait: Bun queues what the pipe refuses, so a slow reader of vx
// (`vx run … | slow-tool`) cost vx the backlog in memory, 260 MB for a
// 128 MiB log. A write that returns false (Bun has no `writableNeedDrain`)
// now holds every reader until that stream drains, closes or fails. A
// stream that failed or closed paces nothing again: past an EPIPE (`vx run
// … | head -1`) Bun refuses every write and raises no event more, and a
// task printing live held its reader, and the run, for good.

interface Drains {
  once?(event: string, listener: () => void): unknown
  off?(event: string, listener: () => void): unknown
  errored?: unknown
  destroyed?: boolean
}

const pending = new Map<Drains, Promise<void>>()
const gone = new WeakSet<Drains>()

/** Note what a `write()` to `stream` returned. */
export function noteWrite(stream: object, accepted: unknown): void {
  const s = stream as Drains
  if (accepted !== false || pending.has(s) || typeof s.once !== 'function') return
  if (gone.has(s) || (s.errored ?? null) !== null || s.destroyed === true) return
  pending.set(
    s,
    new Promise<void>((resolve) => {
      const on = EVENTS.map((e) => {
        const done = (): void => {
          for (const [i, f] of on.entries()) s.off?.(EVENTS[i]!, f)
          if (e !== 'drain') gone.add(s)
          pending.delete(s)
          resolve()
        }
        return done
      })
      for (const [i, f] of on.entries()) s.once!(EVENTS[i]!, f)
    }),
  )
}
const EVENTS = ['drain', 'close', 'error', 'finish'] as const

/** A stream still draining, or `undefined` when output may flow. */
export function outputPaced(): Promise<void> | undefined {
  for (const p of pending.values()) return p
  return undefined
}
