// The derived run aggregate — the single view-model every surface holds.
// Raw RunEvents are the source of truth; this reduces them into the same
// counters/per-task status the terminal summary already renders, so a
// web/TUI/MCP surface can render reactively from one place instead of
// re-deriving. A devframe shared-state holds a RunState and re-reduces on
// each event; the terminal keeps its own inline counters (byte-identical,
// untouched). See docs/design/event-stream-2026-06.md.

import { isGroupTask, type TaskStatus } from '../graph/index.js'
import type { RunEvent } from './events.js'

/** Per-task lifecycle as seen by a surface. */
export type TaskState = 'running' | TaskStatus

export interface TaskRecord {
  id: string
  state: TaskState
  /** Final duration once complete; absent while running. */
  durationMs?: number
  /** True for a persistent task left running after its outcome landed. */
  persistent?: boolean
}

/** Cache-miss duration spread — the same numbers the final summary shows. */
export interface Spread {
  maxMs: number
  minMs: number
  sumMs: number
  count: number
}

export interface RunState {
  total: number
  done: number
  failed: number
  succeeded: number
  upToDate: number
  restoredLocal: number
  restoredRemote: number
  skipped: number
  /** Ids currently executing (a worker holds them). */
  running: string[]
  /** Per-task records, keyed by id. Group tasks are excluded (no work). */
  tasks: Record<string, TaskRecord>
  spread: Spread | null
}

export function initRunState(total = 0): RunState {
  return {
    total,
    done: 0,
    failed: 0,
    succeeded: 0,
    upToDate: 0,
    restoredLocal: 0,
    restoredRemote: 0,
    skipped: 0,
    running: [],
    tasks: {},
    spread: null,
  }
}

/**
 * Fold one event into the aggregate, returning a NEW state (pure — never
 * mutates `prev`, so it's safe to feed a devframe `sharedState.mutate`
 * that diffs old vs new). Mirrors `defaultLogger`'s inline bookkeeping:
 * group tasks (no exec) are ignored, an `aborted` task reverts to pending
 * (freed, never counted), and the spread tracks success+failed only.
 */
export function reduce(prev: RunState, event: RunEvent): RunState {
  switch (event.kind) {
    case 'run:start':
      return initRunState(event.info.total)

    case 'task:start': {
      if (isGroupTask(event.node)) return prev
      const id = event.node.id
      return {
        ...prev,
        running: [...prev.running, id],
        tasks: { ...prev.tasks, [id]: { id, state: 'running' } },
      }
    }

    case 'task:complete': {
      if (isGroupTask(event.node)) return prev
      const id = event.node.id
      const { status, durationMs } = event.outcome
      const running = prev.running.filter((r) => r !== id)

      // Aborted (killed by a shutdown signal): free the slot, count
      // nothing, drop the record — the run is tearing down.
      if (status === 'aborted') {
        const tasks = { ...prev.tasks }
        delete tasks[id]
        return { ...prev, running, tasks }
      }

      const persistent = event.node.config.exec?.persistent !== undefined && status === 'success'
      const next: RunState = {
        ...prev,
        done: prev.done + 1,
        running,
        tasks: {
          ...prev.tasks,
          [id]: { id, state: status, durationMs, ...(persistent ? { persistent: true } : {}) },
        },
      }
      switch (status) {
        case 'success':
          next.succeeded = prev.succeeded + 1
          break
        case 'cache-hit':
          if (event.outcome.restored === false) next.upToDate = prev.upToDate + 1
          else next.restoredLocal = prev.restoredLocal + 1
          break
        case 'cache-hit-remote':
          if (event.outcome.restored === false) next.upToDate = prev.upToDate + 1
          else next.restoredRemote = prev.restoredRemote + 1
          break
        case 'failed':
          next.failed = prev.failed + 1
          break
        case 'skipped':
          next.skipped = prev.skipped + 1
          break
      }
      if (status === 'success' || status === 'failed') {
        const s = prev.spread
        next.spread = {
          maxMs: Math.max(s?.maxMs ?? 0, durationMs),
          minMs: Math.min(s?.minMs ?? Infinity, durationMs),
          sumMs: (s?.sumMs ?? 0) + durationMs,
          count: (s?.count ?? 0) + 1,
        }
      }
      return next
    }

    // stdout/stderr/status/end carry no aggregate signal.
    default:
      return prev
  }
}
