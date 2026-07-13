// The shared per-task log capture primitive (task-logs-2026-07 §1). ONE
// bounded-tail buffer used by the client sink (local runs), the serve sink
// (delegated runs), and — Phase 2 — the dist scheduler, so the capping rules
// can't drift between capture sites.
//
// The law: a log-spewing task can never OOM the capturer. Two caps enforce it:
//   - per task: only the last TASK_LOG_TAIL_CHARS of merged stdout+stderr is
//     retained (chunks evicted from the head, no concatenation until drain);
//   - per run: only RUN_LOG_BUDGET_CHARS of RETAINED completed tails ship, and
//     failed tails are never evicted by successes — a failure's output is the
//     one thing you always want to read.

import type { CacheSource, TaskStatus } from '@vzn/vx'

/** Wire sentinel for the `POST /v1/ingest/logs` body (its own format). */
export const LOG_WIRE_VERSION = 1

/**
 * Per-task tail retained (UTF-16 units — a cheap capture-side proxy; the store
 * records true stored bytes). Merged streams: what a terminal actually shows.
 */
export const TASK_LOG_TAIL_CHARS = 128 * 1024

/** Total RETAINED completed-task chars a single run ships. */
export const RUN_LOG_BUDGET_CHARS = 4 * 1024 * 1024

export interface TaskLogEntry {
  taskId: string
  /** The task's cache key when known — the hit→executed-run resolution key. */
  hash?: string
  status: 'success' | 'failed'
  /** Merged stdout+stderr in arrival order, tail-capped, ANSI preserved. */
  content: string
  /** Chars emitted before capping. */
  charsFull: number
  /** Chars dropped from the head; 0 = complete. */
  truncatedHeadChars: number
}

export interface TaskLogBundle {
  v: typeof LOG_WIRE_VERSION
  runId: string
  workspaceId: string
  tasks: TaskLogEntry[]
}

/** Retained-until-drain state for one completed task. */
interface Retained {
  taskId: string
  hash?: string
  status: 'success' | 'failed'
  chunks: string[]
  chars: number
  charsFull: number
  truncatedHeadChars: number
  /** Insertion order — the eviction tiebreak (oldest first). */
  seq: number
}

/** In-flight (not yet ended) accumulation for one task. */
interface InFlight {
  chunks: string[]
  chars: number
  charsFull: number
  truncatedHeadChars: number
}

/**
 * Bounded per-run capture. `append` keeps a chunk LIST + running char count per
 * task, evicting whole chunks from the head past `TASK_LOG_TAIL_CHARS` — no
 * string concatenation until `drain`, so a cache-hit replay (one big chunk) is
 * one array push, zero copies. `finish` decides retention; `drain` emits the
 * bundle, failures first.
 */
export class TaskLogBuffer {
  private readonly inFlight = new Map<string, InFlight>()
  private readonly retained = new Map<string, Retained>()
  private retainedChars = 0
  private seq = 0

  append(taskId: string, chunk: string): void {
    if (chunk.length === 0) return
    let acc = this.inFlight.get(taskId)
    if (acc === undefined) {
      acc = { chunks: [], chars: 0, charsFull: 0, truncatedHeadChars: 0 }
      this.inFlight.set(taskId, acc)
    }
    acc.chunks.push(chunk)
    acc.chars += chunk.length
    acc.charsFull += chunk.length
    // Evict whole chunks from the head until under the per-task tail cap. A
    // single over-cap chunk is sliced to its tail (the only place we copy).
    while (acc.chars > TASK_LOG_TAIL_CHARS && acc.chunks.length > 1) {
      const dropped = acc.chunks.shift()!
      acc.chars -= dropped.length
      acc.truncatedHeadChars += dropped.length
    }
    if (acc.chars > TASK_LOG_TAIL_CHARS && acc.chunks.length === 1) {
      const only = acc.chunks[0]!
      const keep = only.slice(only.length - TASK_LOG_TAIL_CHARS)
      acc.truncatedHeadChars += only.length - keep.length
      acc.chunks[0] = keep
      acc.chars = keep.length
    }
  }

  /**
   * task.end: decide retention.
   *   - cacheSource !== 'miss' (a hit) → DROP: the executed run already stored
   *     these bytes; a hit resolves by hash to that run.
   *   - 'skipped' / 'aborted' → DROP (no meaningful output; a tearing-down run).
   *   - a success/failed MISS → RETAIN the tail, under the run budget: adding a
   *     task that would exceed `RUN_LOG_BUDGET_CHARS` evicts oldest retained
   *     SUCCESS tails first; failed tails are evicted only by newer failed tails
   *     (oldest first) once failures alone exceed the budget.
   */
  finish(taskId: string, status: TaskStatus, cacheSource: CacheSource, hash?: string): void {
    const acc = this.inFlight.get(taskId)
    this.inFlight.delete(taskId)
    if (cacheSource !== 'miss') return
    if (status !== 'success' && status !== 'failed') return
    if (acc === undefined) return

    const entry: Retained = {
      taskId,
      ...(hash !== undefined ? { hash } : {}),
      status,
      chunks: acc.chunks,
      chars: acc.chars,
      charsFull: acc.charsFull,
      truncatedHeadChars: acc.truncatedHeadChars,
      seq: this.seq++,
    }
    // Replace an earlier retention for the same task id (a retried task ends
    // once per attempt only via the winning outcome, but be defensive).
    const prior = this.retained.get(taskId)
    if (prior !== undefined) this.retainedChars -= prior.chars
    this.retained.set(taskId, entry)
    this.retainedChars += entry.chars
    this.evictToBudget()
  }

  /**
   * Take ONE finished task's retained tail as a wire entry, removing it from
   * the buffer (so a later `drain` won't re-ship it). Used by per-task
   * incremental delivery: `finish()` retains, then the sink `takeEntry()`s and
   * ships that one task. Returns undefined for a task that wasn't retained (a
   * cache hit / skipped / still in-flight / unknown id) — the task result still
   * ships; there is just no log tail to send.
   */
  takeEntry(taskId: string): TaskLogEntry | undefined {
    const e = this.retained.get(taskId)
    if (e === undefined) return undefined
    this.retained.delete(taskId)
    this.retainedChars -= e.chars
    return {
      taskId: e.taskId,
      ...(e.hash !== undefined ? { hash: e.hash } : {}),
      status: e.status,
      content: e.chunks.join(''),
      charsFull: e.charsFull,
      truncatedHeadChars: e.truncatedHeadChars,
    }
  }

  /** Everything retained, failures first, ready to ship/store. */
  drain(runId: string, workspaceId: string): TaskLogBundle {
    const entries = [...this.retained.values()].sort((a, b) => {
      // Failures ahead of successes; within a tier, oldest first (stable).
      const fa = a.status === 'failed' ? 0 : 1
      const fb = b.status === 'failed' ? 0 : 1
      return fa !== fb ? fa - fb : a.seq - b.seq
    })
    return {
      v: LOG_WIRE_VERSION,
      runId,
      workspaceId,
      tasks: entries.map((e) => ({
        taskId: e.taskId,
        ...(e.hash !== undefined ? { hash: e.hash } : {}),
        status: e.status,
        content: e.chunks.join(''),
        charsFull: e.charsFull,
        truncatedHeadChars: e.truncatedHeadChars,
      })),
    }
  }

  /** Retained-tasks count (test/observability). */
  size(): number {
    return this.retained.size
  }

  /**
   * Evict until `retainedChars <= RUN_LOG_BUDGET_CHARS`. Successes go first
   * (oldest by seq); only when failures ALONE still exceed the budget do the
   * oldest failures go — a failure is never dropped to keep a success.
   */
  private evictToBudget(): void {
    if (this.retainedChars <= RUN_LOG_BUDGET_CHARS) return
    const order = [...this.retained.values()].sort((a, b) => {
      const sa = a.status === 'success' ? 0 : 1
      const sb = b.status === 'success' ? 0 : 1
      // Successes first (drop them first), then oldest-first within a tier.
      return sa !== sb ? sa - sb : a.seq - b.seq
    })
    for (const e of order) {
      if (this.retainedChars <= RUN_LOG_BUDGET_CHARS) break
      this.retained.delete(e.taskId)
      this.retainedChars -= e.chars
    }
  }
}
