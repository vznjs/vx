// vx's own stdout and stderr hold the readers of its tasks' output back.
// A task's pipe is read on credit (exec/read-off.ts), so a reader that waits
// stalls the task as a direct pipe would. Writing to a full stdout did not
// wait: Bun queues what the pipe refuses, so a slow reader of vx
// (`vx run … | slow-tool`) cost vx the backlog in memory, 260 MB for a
// 128 MiB log. A write that returns false (Bun has no `writableNeedDrain`)
// now holds every reader until that stream drains, closes or fails.

interface Drains {
  once?(event: string, listener: () => void): unknown
  off?(event: string, listener: () => void): unknown
}

const pending = new Map<Drains, Promise<void>>()

/** Note what a `write()` to `stream` returned. */
export function noteWrite(stream: object, accepted: unknown): void {
  const s = stream as Drains
  if (accepted !== false || pending.has(s) || typeof s.once !== 'function') return
  pending.set(
    s,
    new Promise<void>((resolve) => {
      const done = (): void => {
        for (const e of EVENTS) s.off?.(e, done)
        pending.delete(s)
        resolve()
      }
      for (const e of EVENTS) s.once!(e, done)
    }),
  )
}
const EVENTS = ['drain', 'close', 'error', 'finish'] as const

/** A stream still draining, or `undefined` when output may flow. */
export function outputPaced(): Promise<void> | undefined {
  for (const p of pending.values()) return p
  return undefined
}
