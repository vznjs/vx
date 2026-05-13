// Orchestrator-side event bus the TUI (or any structural consumer)
// subscribes to. Tagged-union events; the consumer pattern is a
// reducer-style switch on `event.kind`. New kinds are additive and
// existing consumers default to ignoring them.
//
// The Logger interface (./logger.ts) stays parallel — it carries the
// terminal's framed-block output. The Observer is a structural sink
// that gets the SAME stdout/stderr chunks plus state-change events
// the Logger doesn't see (cacheProbe, remoteCache, runStart/runEnd).

import type { TaskNode } from '../graph/task-graph.js'
import type { TaskOutcome } from '../graph/scheduler.js'

/** Per-task aggregates pulled from the `runs` table at runStart. */
export interface TaskHistory {
  runs: number
  avgMs: number
  p50Ms: number
  p99Ms: number
  successRate: number
  hitRate: number
  recent: { startedAt: number; durationMs: number; status: string; hash: string }[]
}

/** Keyed by `${project}#${task}`. Missing keys = never-run-before. */
export type HistoryTable = Map<string, TaskHistory>

export type ObserverEvent =
  | {
      kind: 'runStart'
      runId: string
      nodes: readonly TaskNode[]
      concurrency: number
      remoteCacheEnabled: boolean
      startedAtMs: number
      historyTable: HistoryTable
    }
  | { kind: 'taskStart'; nodeId: string; startNs: bigint; slot: number }
  | { kind: 'taskStdout'; nodeId: string; chunk: string }
  | { kind: 'taskStderr'; nodeId: string; chunk: string }
  | { kind: 'taskComplete'; outcome: TaskOutcome }
  | {
      kind: 'cacheProbe'
      nodeId: string
      status: 'hit-local' | 'hit-remote' | 'miss' | 'no-cache'
    }
  | {
      kind: 'remoteCache'
      op: 'GET' | 'PUT' | 'HEAD'
      hash: string
      bytes?: number
      latencyMs: number
      ok: boolean
    }
  | {
      kind: 'runEnd'
      ok: boolean
      outcomes: readonly TaskOutcome[]
      totalMs: number
      endedAtMs: number
    }

export interface Observer {
  emit(event: ObserverEvent): void
}

/**
 * Wrap an Observer so a buggy consumer can't crash the run. Errors
 * thrown by `inner.emit` are logged once to stderr and swallowed.
 * Passing `undefined` returns a no-op observer so callsites can use a
 * single `safe.emit(...)` regardless of whether a consumer is wired.
 */
export function makeSafeObserver(inner: Observer | undefined): Observer {
  if (inner === undefined) return { emit: () => undefined }
  return {
    emit(event) {
      try {
        inner.emit(event)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[vx] observer error: ${message}\n`)
      }
    },
  }
}
