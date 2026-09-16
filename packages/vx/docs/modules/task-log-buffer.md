# `src/orchestrator/task-log-buffer.ts` — bounded per-task log capture

## Purpose

The one bounded-tail buffer a telemetry sink uses to capture task
output, so the capping rules cannot fork between sinks. It lives in
core beside the telemetry contract for the same reason
`assembleRunSummary` does: two sinks each rolling their own buffer is
how the retention rule forks, and a forked rule means two sinks
disagree about which task's output survived. Core itself never
captures logs; today `@vzn/vx-otel`'s sink is the consumer.

## Public surface

```ts
export const LOG_WIRE_VERSION = 1
export const TASK_LOG_TAIL_CHARS = 128 * 1024 // per task, merged stdout+stderr
export const RUN_LOG_BUDGET_CHARS = 4 * 1024 * 1024 // per run, retained tails

export interface TaskLogEntry {
  taskId: string
  hash?: string
  status: 'success' | 'failed'
  content: string // the retained tail
  charsFull: number // what the task printed in all
  truncatedHeadChars: number // what the tail dropped from the front
}
export interface TaskLogBundle {
  v: typeof LOG_WIRE_VERSION
  runId: string
  workspaceId: string
  tasks: TaskLogEntry[] // failures first
}

export class TaskLogBuffer {
  append(taskId, chunk): void
  finish(taskId, status, cacheSource, hash?): void
  takeEntry(taskId): TaskLogEntry | undefined // one task, removed from the buffer
  drain(runId, workspaceId): TaskLogBundle // everything retained, failures first
  size(): number
  budgetUsed(): number // observability / tests
}
```

## The law

A log-spewing task can never OOM the capturer, and a cap always says
what it cut:

- **Per task**: only the last `TASK_LOG_TAIL_CHARS` are kept — whole
  chunks evicted from the head, no concatenation until drain, so a
  cache-hit replay (one big chunk) is one array push. `charsFull` and
  `truncatedHeadChars` ride with the entry, so "we truncated this"
  never reads as "this task printed nothing".
- **On finish**: a cache hit is DROPPED (the executed run already
  stored those bytes; a hit resolves by `hash` to that run);
  `skipped` / `aborted` are dropped; a success or failure that
  executed is RETAINED under the run budget.
- **Per run**: past `RUN_LOG_BUDGET_CHARS`, successes are evicted
  first (oldest first); failures go only when failures alone exceed the
  budget, newest first — the first failure is usually the root cause
  and the later ones its cascade. An evicted task degrades to a STUB
  (no content, everything counted as truncated), never disappears.
- The budget charges ~24 char-equivalents per retained chunk on top of
  the characters: measured on Bun 1.4, a million one-char chunks cost
  ~30 MB against ~1.4 MB for one chunk, so a pure char count would
  bound something other than memory.

## What it does NOT do

- Decide what a task's status or cache source is — the vocabulary is
  `TaskStatus` / `CacheSource` from the telemetry contract.
- Ship anything. A sink calls `takeEntry` per task or `drain` at the
  end and owns the transport.

## Tests

`tests/task-log-buffer.test.ts`: the tail cap, hit/skip dropping, the
two-tier eviction order, stub accounting
(`content.length === charsFull - truncatedHeadChars`), and the
charge/release symmetry `budgetUsed()` exposes — the invariant that
fails silently if a release does not match its charge.
