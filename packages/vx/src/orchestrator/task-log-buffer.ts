// The shared per-task log capture primitive (task-logs-2026-07 §1). ONE
// bounded-tail buffer every telemetry sink uses — today `@vzn/vx-otel`'s
// sink — so the capping rules can't drift between capture sites.
//
// It lives in CORE, beside the telemetry contract, for the same reason
// `assembleRunSummary` does: two sinks that each roll their own bounded buffer
// is how the retention rule forks, and a forked rule means two sinks disagree
// about which task's output survived. A sink is the only consumer — core
// itself never captures logs — but the vocabulary it decides in (`TaskStatus`,
// `CacheSource`, "a hit's bytes belong to the run that executed") is core's.
//
// The law: a log-spewing task can never OOM the capturer. Two caps enforce it:
//   - per task: only the last TASK_LOG_TAIL_CHARS of merged stdout+stderr is
//     retained (chunks evicted from the head, no concatenation until drain);
//   - per run: only RUN_LOG_BUDGET_CHARS of RETAINED completed tails ship, and
//     failed tails are never evicted by successes — a failure's output is the
//     one thing you always want to read.
//
// Both caps report themselves: an evicted or head-trimmed task still ships,
// carrying how much was dropped, so "we truncated this" never reads as "this
// task printed nothing".

import type { TaskStatus } from '../graph/index.js'
import type { CacheSource } from '../graph/index.js'

/** Version of the drained-bundle shape below. It is the canonical drained
 *  logs format, not one transport's: every sink ships the same object. */
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
  /** Emptied when the run budget evicts this task; `chars` goes to 0 and the
   *  dropped count moves to `truncatedHeadChars` (see `evictToBudget`). */
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
 * Per-retained-chunk overhead, in char-equivalents, charged against the RUN
 * budget on top of the characters themselves.
 *
 * The budget exists to bound MEMORY, but a char count is not one: a task that
 * emits a byte at a time (unbuffered progress output) stores the same content
 * as thousands of separate strings, each with its own header and allocation.
 * MEASURED on Bun 1.4: 1 000 000 chars arrive as one chunk for ~1.4 MB of
 * marginal RSS, and as 1 000 000 one-char chunks for ~30 MB — so a 4 MiB
 * char budget could hold ~80 MB of actual memory. Charging each chunk ~24
 * char-equivalents makes the budget track what it is trying to limit; chunky
 * output is unaffected (one 128 KiB chunk pays 24 on 131 072).
 *
 * The per-task TAIL cap deliberately stays a pure char count — it bounds how
 * much a reader is shown, which is a different question from how much the
 * process holds.
 */
const CHUNK_OVERHEAD_CHARS = 24

/** What one retained entry costs the run budget: content + per-chunk overhead. */
function budgetCost(chars: number, chunkCount: number): number {
  return chars + chunkCount * CHUNK_OVERHEAD_CHARS
}

/**
 * Bounded per-run capture. `append` keeps a chunk LIST + running char count per
 * task, evicting from the head past `TASK_LOG_TAIL_CHARS` — no
 * string concatenation until `drain`, so a cache-hit replay (one big chunk) is
 * one array push, zero copies. `finish` decides retention; `drain` emits the
 * bundle, failures first.
 */
export class TaskLogBuffer {
  private readonly inFlight = new Map<string, InFlight>()
  private readonly retained = new Map<string, Retained>()
  private retainedChars = 0
  private seq = 0
  /**
   * Retained entries in eviction order, kept as they arrive: successes are
   * stubbed from `successHead` on (oldest first), failures from the end
   * (newest first). An entry since stubbed, taken or replaced is skipped
   * where it lies. A sort of every entry per finish made a run past the
   * budget quadratic: 40,000 tasks took 17 s in a sink's `onRecord`.
   */
  private readonly successes: Retained[] = []
  private successHead = 0
  private failures: Retained[] = []

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
    // Evict whole chunks from the head until under the per-task tail cap;
    // the one that straddles the cap is sliced to what still fits (the only
    // place we copy). Dropped whole, a 128 KiB chunk and a 7-char one after
    // it kept the 7 chars alone.
    while (acc.chars > TASK_LOG_TAIL_CHARS) {
      const head = acc.chunks[0]!
      const excess = acc.chars - TASK_LOG_TAIL_CHARS
      if (head.length <= excess) {
        acc.chunks.shift()
        acc.chars -= head.length
        acc.truncatedHeadChars += head.length
        continue
      }
      let start = excess
      // A cut between a surrogate pair would open the tail on a lone low
      // surrogate, which a sink's UTF-8 encode turns into U+FFFD.
      const first = head.charCodeAt(start)
      if (first >= 0xdc00 && first <= 0xdfff) start++
      acc.chunks[0] = head.slice(start)
      acc.chars -= start
      acc.truncatedHeadChars += start
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
    if (prior !== undefined) this.retainedChars -= budgetCost(prior.chars, prior.chunks.length)
    this.retained.set(taskId, entry)
    this.retainedChars += budgetCost(entry.chars, entry.chunks.length)
    ;(status === 'success' ? this.successes : this.failures).push(entry)
    this.compact()
    this.evictToBudget()
  }

  /** Whether `e` may still be stubbed: retained as it is, content and all. */
  private evictable(e: Retained): boolean {
    return e.chars > 0 && this.retained.get(e.taskId) === e
  }

  /**
   * Drop what eviction would only skip, once the queues hold twice what is
   * retained: a sink that takes every entry (`takeEntry`) never evicts, and
   * its queues would grow by a task each. Amortized constant per finish.
   */
  private compact(): void {
    const room = 2 * this.retained.size + 1024
    if (this.successes.length - this.successHead > room || this.successHead > room) {
      const live = this.successes.slice(this.successHead).filter((e) => this.evictable(e))
      this.successes.length = 0
      this.successes.push(...live)
      this.successHead = 0
    }
    if (this.failures.length > room) this.failures = this.failures.filter((e) => this.evictable(e))
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
    this.retainedChars -= budgetCost(e.chars, e.chunks.length)
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
   * Budget charged right now, in char-equivalents (test/observability).
   *
   * Exposed because the charge/release symmetry is the invariant that keeps
   * the cap meaningful and the one that fails SILENTLY: a release that does
   * not match its charge drifts `retainedChars` a little per task, and a
   * long run ends up bounding something other than what it thinks.
   */
  budgetUsed(): number {
    return this.retainedChars
  }

  /**
   * Evict until `retainedChars <= RUN_LOG_BUDGET_CHARS`. Successes go first
   * (oldest by seq); only when failures ALONE still exceed the budget do the
   * newest failures go — a failure is never dropped to keep a success.
   *
   * An evicted task is degraded to a STUB (no content, `truncatedHeadChars`
   * = everything it emitted) rather than removed. Dropping the entry makes a
   * budget eviction indistinguishable from a task that printed nothing — the
   * reader gets "no logs captured" either way, which is a confident false
   * statement in the one case where they most need the output (a run with
   * enough failing tasks to blow the budget). A stub costs a few dozen bytes,
   * keeps the `content.length === charsFull - truncatedHeadChars` accounting
   * honest, and renders through the truncation banner the per-task cap
   * already uses — a store that enforces its own run budget should degrade
   * the same way (slice to empty, add the remainder to the truncated count).
   *
   * The cost is a stub per evicted task in the end-of-run bundle: measured at
   * ~190 JSON bytes each, so ~1.9 MiB at the 10k-task scale target and ~9.3 MiB
   * at 50k — a sink that posts the whole bundle in one request sizes its cap
   * against that; one that ships per task as it finishes (`takeEntry`) never
   * sees it.
   */
  private evictToBudget(): void {
    // Successes are dropped first, always, and keep oldest-first: none of
    // them is more interesting than another, and recency is the better
    // guess. Failures go newest-first: when failures alone blow the budget,
    // the FIRST failure is usually the root cause and the later ones its
    // cascade, so it must be the last thing stubbed.
    while (this.retainedChars > RUN_LOG_BUDGET_CHARS && this.successHead < this.successes.length) {
      const e = this.successes[this.successHead++]!
      if (this.evictable(e)) this.stub(e)
    }
    while (this.retainedChars > RUN_LOG_BUDGET_CHARS && this.failures.length > 0) {
      const e = this.failures.pop()!
      if (this.evictable(e)) this.stub(e)
    }
  }

  private stub(e: Retained): void {
    this.retainedChars -= budgetCost(e.chars, e.chunks.length)
    e.truncatedHeadChars += e.chars
    e.chunks = []
    e.chars = 0
  }
}
