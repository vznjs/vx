// TUI state shape + reducer. Pure data — no renderer involvement.
// See docs/design/tui-design.md §4. New event kinds extend the
// `event` action; new key actions extend `KeyAction`. Tests live in
// `tests/tui-store.test.ts`.

import type { ObserverEvent, HistoryTable } from '../../orchestrator/observer.js'
import type { TaskNode } from '../../graph/task-graph.js'
import { isGroupTask } from '../../graph/task-graph.js'
import { newSparklineBuf, pushSample, type SparklineBuf } from '../primitives/sparkline.js'

export type TaskRowStatus =
  | 'waiting'
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
  status: TaskRowStatus
  startNs?: bigint
  endNs?: bigint
  exitCode?: number
  hash?: string
  /** Slot the scheduler picked for this task. */
  slot?: number
  /** Cache probe outcome — populated before exec runs. */
  cacheStatus?: 'hit-local' | 'hit-remote' | 'miss' | 'no-cache'
  /** Group (no exec) vs persistent (long-running) vs cached (regular). */
  kind: 'group' | 'persistent' | 'cached'
  /** Topological deps, copied from the TaskNode for selector use. */
  deps: readonly string[]
  /** Reverse-BFS count — populated at runStart. */
  dependentsCount: number
  logLines: string[]
  elidedCount: number
  pendingLine: string
}

export interface WorkerSlot {
  taskId: string | null
}

export interface RemoteCounters {
  gets: number
  puts: number
  heads: number
  bytesDown: number
  bytesUp: number
  /** Bounded to 1024 most-recent entries. */
  latencies: number[]
}

export interface State {
  runId: string
  startedAtMs: number
  totalNodes: number
  concurrency: number
  remoteCacheEnabled: boolean
  /** Insertion order is topo order (the orchestrator's `Map.keys()`). */
  tasks: Map<string, TaskRow>
  /** Slot allocation mirror; index = slot, value = currently-running task id or null. */
  workerSlots: WorkerSlot[]
  history: HistoryTable
  remote: RemoteCounters
  // Live 1-Hz sparklines (60 samples).
  throughputBuf: SparklineBuf
  remoteOpsBuf: SparklineBuf
  parallelPctBuf: SparklineBuf
  /**
   * Counter of `taskComplete` events received since the last `tick`.
   * The tick drains it into `throughputBuf` and resets to 0.
   */
  completedSinceTick: number
  /**
   * Counter of `remoteCache` events received since the last `tick`.
   * The tick drains it into `remoteOpsBuf` and resets to 0.
   */
  remoteOpsSinceTick: number
  // UI state.
  activeView: 1 | 2 | 3 | 4 | 5
  focusPanel: 'tasks' | 'log'
  selectedTaskId?: string
  pinnedTaskId?: string
  filters: Record<number, string>
  showHelp: boolean
  taskDetailOpen: boolean
  done: boolean
  dirty: boolean
}

export type KeyAction =
  | { kind: 'viewChange'; view: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'selectTask'; taskId: string }
  | { kind: 'toggleHelp' }
  | { kind: 'openTaskDetail' }
  | { kind: 'closeOverlay' }
  | { kind: 'setFilter'; value: string }

export type Action =
  | { type: 'event'; event: ObserverEvent }
  | { type: 'tick'; nowNs: bigint }
  | { type: 'key'; key: KeyAction }

export function initialState(): State {
  return {
    runId: '',
    startedAtMs: 0,
    totalNodes: 0,
    concurrency: 0,
    remoteCacheEnabled: false,
    tasks: new Map(),
    workerSlots: [],
    history: new Map(),
    remote: { gets: 0, puts: 0, heads: 0, bytesDown: 0, bytesUp: 0, latencies: [] },
    throughputBuf: newSparklineBuf(60),
    remoteOpsBuf: newSparklineBuf(60),
    parallelPctBuf: newSparklineBuf(60),
    completedSinceTick: 0,
    remoteOpsSinceTick: 0,
    activeView: 1,
    focusPanel: 'tasks',
    filters: {},
    showHelp: false,
    taskDetailOpen: false,
    done: false,
    dirty: false,
  }
}

const LATENCY_CAP = 1024
const LOG_CAP = 10_000
const LOG_DROP = 1_000

function classifyNode(node: TaskNode): 'group' | 'persistent' | 'cached' {
  if (isGroupTask(node)) return 'group'
  if (node.config.exec?.persistent !== undefined) return 'persistent'
  return 'cached'
}

function rowFromNode(node: TaskNode, dependentsCount: number): TaskRow {
  return {
    id: node.id,
    projectName: node.projectName,
    taskName: node.taskName,
    status: 'waiting',
    kind: classifyNode(node),
    deps: node.deps,
    dependentsCount,
    logLines: [],
    elidedCount: 0,
    pendingLine: '',
  }
}

/** Reverse-BFS over the task graph; one count per node. O(V+E). */
function computeDependentsCounts(nodes: readonly TaskNode[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const n of nodes) counts.set(n.id, 0)
  // Build reverse adjacency once.
  const reverse = new Map<string, string[]>()
  for (const n of nodes) {
    for (const d of n.deps) {
      let entry = reverse.get(d)
      if (!entry) {
        entry = []
        reverse.set(d, entry)
      }
      entry.push(n.id)
    }
  }
  // For each node, BFS over reverse to count transitive dependents.
  for (const n of nodes) {
    const seen = new Set<string>()
    const queue = [n.id]
    while (queue.length > 0) {
      const cur = queue.shift()!
      const next = reverse.get(cur)
      if (!next) continue
      for (const id of next) {
        if (!seen.has(id)) {
          seen.add(id)
          queue.push(id)
        }
      }
    }
    counts.set(n.id, seen.size)
  }
  return counts
}

function appendLogChunk(row: TaskRow, chunk: string): void {
  const combined = row.pendingLine + chunk
  const parts = combined.split('\n')
  // Last element is the partial trailing line (no terminator yet).
  row.pendingLine = parts.pop() ?? ''
  for (const line of parts) row.logLines.push(line)
  if (row.logLines.length > LOG_CAP) {
    row.elidedCount += LOG_DROP
    row.logLines.splice(0, LOG_DROP)
    row.logLines[0] = `…${row.elidedCount} more lines elided…`
  }
}

function freeSlotByTask(state: State, taskId: string): void {
  for (const slot of state.workerSlots) {
    if (slot.taskId === taskId) {
      slot.taskId = null
    }
  }
}

function parallelPct(state: State): number {
  if (state.concurrency === 0) return 0
  const busy = state.workerSlots.filter((s) => s.taskId !== null).length
  return Math.floor((busy / state.concurrency) * 100)
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'event': {
      const e = action.event
      switch (e.kind) {
        case 'runStart': {
          const tasks = new Map<string, TaskRow>()
          const dependents = computeDependentsCounts(e.nodes)
          for (const node of e.nodes) {
            tasks.set(node.id, rowFromNode(node, dependents.get(node.id) ?? 0))
          }
          return {
            ...state,
            runId: e.runId,
            startedAtMs: e.startedAtMs,
            totalNodes: e.nodes.length,
            concurrency: e.concurrency,
            remoteCacheEnabled: e.remoteCacheEnabled,
            tasks,
            workerSlots: Array.from({ length: e.concurrency }, () => ({ taskId: null })),
            history: e.historyTable,
            dirty: true,
          }
        }
        case 'taskStart': {
          const row = state.tasks.get(e.nodeId)
          if (!row) return state
          row.status = 'running'
          row.startNs = e.startNs
          row.slot = e.slot
          // Mark slot as busy.
          const slot = state.workerSlots[e.slot]
          if (slot) slot.taskId = e.nodeId
          state.dirty = true
          return state
        }
        case 'taskStdout':
        case 'taskStderr': {
          const row = state.tasks.get(e.nodeId)
          if (!row) return state
          appendLogChunk(row, e.chunk)
          state.dirty = true
          return state
        }
        case 'cacheProbe': {
          const row = state.tasks.get(e.nodeId)
          if (!row) return state
          row.cacheStatus = e.status
          state.dirty = true
          return state
        }
        case 'taskComplete': {
          const row = state.tasks.get(e.outcome.node.id)
          if (!row) return state
          row.status = e.outcome.status
          row.exitCode = e.outcome.exitCode
          if (e.outcome.hash !== undefined) row.hash = e.outcome.hash
          if (e.outcome.wallclockEndNs !== undefined) row.endNs = e.outcome.wallclockEndNs
          // Flush any partial line into the log.
          if (row.pendingLine.length > 0) {
            row.logLines.push(row.pendingLine)
            row.pendingLine = ''
          }
          freeSlotByTask(state, row.id)
          state.completedSinceTick++
          state.dirty = true
          return state
        }
        case 'remoteCache': {
          if (e.op === 'GET') state.remote.gets++
          else if (e.op === 'PUT') state.remote.puts++
          else state.remote.heads++
          if (e.bytes !== undefined) {
            if (e.op === 'GET') state.remote.bytesDown += e.bytes
            if (e.op === 'PUT') state.remote.bytesUp += e.bytes
          }
          state.remote.latencies.push(e.latencyMs)
          if (state.remote.latencies.length > LATENCY_CAP) {
            state.remote.latencies.splice(0, state.remote.latencies.length - LATENCY_CAP)
          }
          state.remoteOpsSinceTick++
          state.dirty = true
          return state
        }
        case 'runEnd': {
          state.done = true
          state.dirty = true
          return state
        }
        default:
          return state
      }
    }
    case 'tick': {
      // Drain the per-tick counters; each sample is "events that
      // happened in the last second."
      pushSample(state.parallelPctBuf, parallelPct(state))
      pushSample(state.throughputBuf, state.completedSinceTick)
      pushSample(state.remoteOpsBuf, state.remoteOpsSinceTick)
      state.completedSinceTick = 0
      state.remoteOpsSinceTick = 0
      state.dirty = true
      return state
    }
    case 'key': {
      const k = action.key
      switch (k.kind) {
        case 'viewChange':
          return { ...state, activeView: k.view, dirty: true }
        case 'selectTask':
          return { ...state, selectedTaskId: k.taskId, dirty: true }
        case 'toggleHelp':
          return { ...state, showHelp: !state.showHelp, dirty: true }
        case 'openTaskDetail':
          return { ...state, taskDetailOpen: true, dirty: true }
        case 'closeOverlay':
          return { ...state, taskDetailOpen: false, showHelp: false, dirty: true }
        case 'setFilter':
          return {
            ...state,
            filters: { ...state.filters, [state.activeView]: k.value },
            dirty: true,
          }
        default:
          return state
      }
    }
    default:
      return state
  }
}
