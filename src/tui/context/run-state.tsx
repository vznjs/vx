// Run state: tasks + selection. Mirrors Turbo's `TasksByStatus`
// shape — three buckets (running, planned, finished) so the task
// list naturally sorts running-first, planned-next, finished-last.
//
// Solid `createStore` mutates in place reactively; components reading
// e.g. `state.running` automatically re-render when we splice.

import { createStore, produce } from 'solid-js/store'
import { createSimpleContext } from './helper.tsx'
import type { ObserverEvent } from '../../orchestrator/observer.js'

export type TaskStatus =
  | 'running'
  | 'success'
  | 'cache-hit'
  | 'cache-hit-remote'
  | 'failed'
  | 'skipped'

export interface TaskRow {
  id: string
  projectName: string
  taskName: string
  status: 'planned' | TaskStatus
  startMs?: number
  endMs?: number
  exitCode?: number
  cacheStatus?: 'hit-local' | 'hit-remote' | 'miss' | 'no-cache'
}

export interface RunState {
  runId: string
  startedAtMs: number
  concurrency: number
  remoteCacheEnabled: boolean
  totalTasks: number
  /** All tasks keyed by id. Used for fast lookup. */
  byId: Record<string, TaskRow>
  /** Currently-running task ids, in start order. */
  running: string[]
  /** Planned (not-yet-started) task ids, in graph order. */
  planned: string[]
  /** Finished tasks sorted Turbo-style: failures first, then successes, then cached. */
  finished: string[]
  /** Currently-selected task id (drives the LogPane). */
  selectedId: string | null
  /** True once the orchestrator's runEnd fired. */
  done: boolean
  /** Toggled by the user; persists across the post-run paint. */
  exitRequested: boolean
}

function emptyState(): RunState {
  return {
    runId: '',
    startedAtMs: 0,
    concurrency: 0,
    remoteCacheEnabled: false,
    totalTasks: 0,
    byId: {},
    running: [],
    planned: [],
    finished: [],
    selectedId: null,
    done: false,
    exitRequested: false,
  }
}

function finishedRank(status: TaskStatus): number {
  // failures first (most useful to see), then success, then cached.
  if (status === 'failed') return 0
  if (status === 'success') return 1
  if (status === 'cache-hit' || status === 'cache-hit-remote') return 2
  return 3
}

const { provider: RunStateProvider, use: useRunState } = createSimpleContext({
  name: 'RunState',
  init: () => {
    const [state, setState] = createStore<RunState>(emptyState())

    function moveOut(id: string): void {
      setState(
        produce((s) => {
          s.running = s.running.filter((x) => x !== id)
          s.planned = s.planned.filter((x) => x !== id)
        }),
      )
    }

    function insertFinished(id: string): void {
      setState(
        produce((s) => {
          const row = s.byId[id]
          if (!row || row.status === 'planned') return
          const rank = finishedRank(row.status as TaskStatus)
          let i = 0
          while (i < s.finished.length) {
            const existing = s.byId[s.finished[i]!]
            if (existing && finishedRank(existing.status as TaskStatus) > rank) break
            i++
          }
          s.finished.splice(i, 0, id)
        }),
      )
    }

    function apply(event: ObserverEvent): void {
      switch (event.kind) {
        case 'runStart': {
          setState(
            produce((s) => {
              s.runId = event.runId
              s.startedAtMs = event.startedAtMs
              s.concurrency = event.concurrency
              s.remoteCacheEnabled = event.remoteCacheEnabled
              s.totalTasks = event.nodes.length
              s.byId = {}
              s.running = []
              s.planned = []
              s.finished = []
              s.done = false
              s.exitRequested = false
              for (const node of event.nodes) {
                s.byId[node.id] = {
                  id: node.id,
                  projectName: node.projectName,
                  taskName: node.taskName,
                  status: 'planned',
                }
                s.planned.push(node.id)
              }
              if (!s.selectedId && event.nodes.length > 0) {
                s.selectedId = event.nodes[0]!.id
              }
            }),
          )
          return
        }
        case 'taskStart': {
          moveOut(event.nodeId)
          setState(
            produce((s) => {
              const row = s.byId[event.nodeId]
              if (!row) return
              row.status = 'running'
              row.startMs = Date.now()
              s.running.push(event.nodeId)
            }),
          )
          return
        }
        case 'cacheProbe': {
          setState(
            produce((s) => {
              const row = s.byId[event.nodeId]
              if (!row) return
              row.cacheStatus = event.status
            }),
          )
          return
        }
        case 'taskComplete': {
          const id = event.outcome.node.id
          moveOut(id)
          setState(
            produce((s) => {
              const row = s.byId[id]
              if (!row) return
              row.status = event.outcome.status as TaskStatus
              row.exitCode = event.outcome.exitCode
              row.endMs = Date.now()
            }),
          )
          insertFinished(id)
          return
        }
        case 'runEnd': {
          setState('done', true)
          return
        }
        default:
          return
      }
    }

    function select(id: string): void {
      setState('selectedId', id)
    }

    function selectNext(): void {
      const ordered = [...state.running, ...state.planned, ...state.finished]
      if (ordered.length === 0) return
      const idx = state.selectedId ? ordered.indexOf(state.selectedId) : -1
      const next = ordered[Math.min(ordered.length - 1, idx + 1)]
      if (next) setState('selectedId', next)
    }

    function selectPrev(): void {
      const ordered = [...state.running, ...state.planned, ...state.finished]
      if (ordered.length === 0) return
      const idx = state.selectedId ? ordered.indexOf(state.selectedId) : 0
      const prev = ordered[Math.max(0, idx - 1)]
      if (prev) setState('selectedId', prev)
    }

    function requestExit(): void {
      setState('exitRequested', true)
    }

    return {
      state,
      apply,
      select,
      selectNext,
      selectPrev,
      requestExit,
    }
  },
})

export { RunStateProvider, useRunState }
