// Bounded head-evicting tail for one stream of one still-running task.
//
// A PERSISTENT task (dev server, watcher, daemon) is unbounded by
// construction: unlike a one-shot command, nothing about it terminating
// bounds how much it writes. Anything that accumulates its output therefore
// needs a cap, and the cap has to be honest — a truncated log that reads as
// complete is worse than one that says what it lost.
//
// `orchestrator/logger.ts` is the sole holder: it registers a tail per
// persistent task at taskStart and keeps one for the rest of the run, so a
// single mechanism covers both the pre-ready window and everything after.
// `exec/runner.ts` used to keep a SECOND pre-ready copy fed from the same
// chunks that nothing ever read; it was deleted rather than kept in sync,
// since two copies of this rule is how they drift — one grew a bound and
// the other did not, which is the defect this file was extracted to close
// (a never-ready `readyWhen` grew vx's heap ~100 MiB/s with the 64 KiB cap
// sitting unused, because it was only ever engaged once the task became
// ready). It stays in `util` because `exec` cannot import `orchestrator`,
// so a future second holder on that side has somewhere to import from.

/** Per-stream cap on retained output for a task that may never end. */
export const PERSISTENT_TAIL_CHARS = 64 * 1024

export interface Tail {
  chunks: string[]
  chars: number
  /** Characters evicted from the head. Non-zero means the tail is partial. */
  dropped: number
}

export function createTail(): Tail {
  return { chunks: [], chars: 0, dropped: 0 }
}

export function appendTail(t: Tail, chunk: string, limit = PERSISTENT_TAIL_CHARS): void {
  if (chunk.length === 0) return
  t.chunks.push(chunk)
  t.chars += chunk.length
  // Evict WHOLE chunks from the head — no concatenation until the flush
  // joins once, so a chatty server costs one array push per chunk.
  while (t.chars > limit && t.chunks.length > 1) {
    const gone = t.chunks.shift()!
    t.chars -= gone.length
    t.dropped += gone.length
  }
  // A single chunk over the cap is the one place we copy.
  if (t.chars > limit) {
    const only = t.chunks[0]!
    const keep = only.slice(only.length - limit)
    t.dropped += only.length - keep.length
    t.chunks[0] = keep
    t.chars = keep.length
  }
}

/** Join the retained text. The tail keeps its chunks — see `resetTail`. */
export function tailText(t: Tail): string {
  return t.chunks.length === 1 ? t.chunks[0]! : t.chunks.join('')
}

/** Drop everything retained, keeping the tail usable for a new phase. */
export function resetTail(t: Tail): void {
  t.chunks.length = 0
  t.chars = 0
  t.dropped = 0
}
