// The run event stream — the substrate every output surface subscribes
// to. The orchestrator no longer calls a Logger directly; it emits
// RunEvents through a bus, and the terminal renderer (or a custom
// embedder logger) is just the default, always-on, in-process
// subscriber. Off-thread surfaces (web devtool, TUI, MCP) attach as
// additional subscribers later, so a slow/wedged renderer can never
// stall task exec. See docs/design/event-stream-2026-06.md.

import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { isGroupTask } from '../graph/index.js'
import type { Logger } from './logger.js'
import type { RunContext } from './summary.js'

/** Payload of the `run:start` event — mirrors the Logger.runStart hook. */
export interface RunStartInfo {
  total: number
  concurrency?: number
  requestedCount?: number
  /** Run banner context so a live footer can match the final summary. */
  context?: RunContext
}

/**
 * The in-process event vocabulary. Carries LIVE `TaskNode` / `TaskOutcome`
 * refs — zero-copy, because the default terminal subscriber runs on the
 * same thread and reads those objects directly. Crossing a thread or RPC
 * needs the serializable WireEvent form (see `projectNode` / `toWireEvent`
 * below); that mapping is the boundary's job, not the producer's.
 */
export type RunEvent =
  | { kind: 'run:start'; info: RunStartInfo }
  | { kind: 'task:start'; node: TaskNode }
  | { kind: 'task:stdout'; node: TaskNode; chunk: string }
  | { kind: 'task:stderr'; node: TaskNode; chunk: string }
  | { kind: 'task:complete'; node: TaskNode; outcome: TaskOutcome }
  | { kind: 'run:status'; line: string }
  | { kind: 'run:end' }

export type RunEventSubscriber = (event: RunEvent) => void

export interface EventBus {
  emit(event: RunEvent): void
  /** Register a subscriber; returns a disposer that removes it. */
  subscribe(subscriber: RunEventSubscriber): () => void
}

export function createEventBus(): EventBus {
  const subscribers: RunEventSubscriber[] = []
  return {
    emit(event) {
      // Synchronous, in-subscription-order fan-out. Ordering is part of
      // the terminal renderer's contract (a stdout chunk must reach it
      // before the task's completion block; block-separator bookkeeping
      // depends on it), so emit must never reorder or defer.
      for (const subscriber of subscribers) subscriber(event)
    },
    subscribe(subscriber) {
      subscribers.push(subscriber)
      return () => {
        const i = subscribers.indexOf(subscriber)
        if (i >= 0) subscribers.splice(i, 1)
      }
    },
  }
}

/**
 * A `Logger`-shaped facade that turns every call into a RunEvent. The
 * orchestrator holds one of these as its `log`, so every existing
 * `log.X(...)` call site emits through the bus unchanged — the concrete
 * renderer subscribes via `terminalSubscriber`.
 */
export function busLogger(bus: EventBus): Logger {
  return {
    status: (line) => bus.emit({ kind: 'run:status', line }),
    taskStdout: (node, chunk) => bus.emit({ kind: 'task:stdout', node, chunk }),
    taskStderr: (node, chunk) => bus.emit({ kind: 'task:stderr', node, chunk }),
    taskComplete: (node, outcome) => bus.emit({ kind: 'task:complete', node, outcome }),
    runStart: (info) => bus.emit({ kind: 'run:start', info }),
    taskStart: (node) => bus.emit({ kind: 'task:start', node }),
    runEnd: () => bus.emit({ kind: 'run:end' }),
  }
}

/**
 * Translate events back into `Logger` calls on a concrete renderer (the
 * default terminal logger, or a custom embedder logger). This IS the
 * in-process terminal surface: synchronous, full-fidelity, always-on.
 * Output is byte-identical to calling the renderer directly because the
 * bus fan-out is synchronous and order-preserving.
 */
export function terminalSubscriber(sink: Logger): RunEventSubscriber {
  return (event) => {
    switch (event.kind) {
      case 'run:start':
        sink.runStart?.(event.info)
        return
      case 'task:start':
        sink.taskStart?.(event.node)
        return
      case 'task:stdout':
        sink.taskStdout(event.node, event.chunk)
        return
      case 'task:stderr':
        sink.taskStderr(event.node, event.chunk)
        return
      case 'task:complete':
        sink.taskComplete(event.node, event.outcome)
        return
      case 'run:status':
        sink.status(event.line)
        return
      case 'run:end':
        sink.runEnd?.()
        return
    }
  }
}

// --- Serializable projections (the off-thread / devframe wire form) ----
//
// The in-process bus carries live refs; crossing a worker postMessage or
// an RPC needs a JSON/structured-clone-safe form. Two concrete blockers
// make the raw objects un-sendable:
//   1. `TaskOutcome.wallclockStartNs/EndNs` are bigint — JSON.stringify
//      THROWS on a bigint.
//   2. `TaskOutcome.node` back-references the whole TaskNode graph (its
//      config + dep nodes), so every event would drag the graph across
//      the boundary.
// The projection fixes both: ids instead of the node graph, decimal
// strings instead of bigint. Consumers on the far side rebuild their
// view-model from the one-time task table in `run:start`.

/** Display projection of a TaskNode — exactly the fields renderers read. */
export interface TaskView {
  id: string
  project: string
  task: string
  isGroup: boolean
  requested: boolean
  surfaced: boolean
  persistent: boolean
  command?: string
}

/** Serializable projection of a TaskOutcome (no node ref, ns as strings). */
export interface OutcomeView {
  taskId: string
  status: TaskOutcome['status']
  exitCode: number
  durationMs: number
  hash?: string
  cpuMs?: number
  peakRssBytes?: number
  restored?: boolean
  sandboxViolations?: number
  sandboxViolationLines?: string[]
  /** bigint hrtime ns encoded as a decimal string (JSON/RPC-safe). */
  wallclockStartNs?: string
  wallclockEndNs?: string
}

export function projectNode(node: TaskNode): TaskView {
  const view: TaskView = {
    id: node.id,
    project: node.projectName,
    task: node.taskName,
    isGroup: isGroupTask(node),
    requested: node.requested,
    surfaced: node.surfaced === true,
    persistent: node.config.exec?.persistent !== undefined,
  }
  if (node.config.exec?.command !== undefined) view.command = node.config.exec.command
  return view
}

export function projectOutcome(outcome: TaskOutcome): OutcomeView {
  const view: OutcomeView = {
    taskId: outcome.node.id,
    status: outcome.status,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
  }
  if (outcome.hash !== undefined) view.hash = outcome.hash
  if (outcome.cpuMs !== undefined) view.cpuMs = outcome.cpuMs
  if (outcome.peakRssBytes !== undefined) view.peakRssBytes = outcome.peakRssBytes
  if (outcome.restored !== undefined) view.restored = outcome.restored
  if (outcome.sandboxViolations !== undefined) view.sandboxViolations = outcome.sandboxViolations
  if (outcome.sandboxViolationLines !== undefined)
    view.sandboxViolationLines = outcome.sandboxViolationLines
  if (outcome.wallclockStartNs !== undefined)
    view.wallclockStartNs = outcome.wallclockStartNs.toString()
  if (outcome.wallclockEndNs !== undefined) view.wallclockEndNs = outcome.wallclockEndNs.toString()
  return view
}

/**
 * The serializable form of a RunEvent — ids + views, JSON / structured-
 * clone safe. The off-thread boundary maps each in-process event through
 * `toWireEvent` before it crosses; `run:start` additionally carries the
 * one-time task table so consumers can key everything by id.
 */
export type WireEvent =
  | { kind: 'run:start'; info: RunStartInfo; tasks: TaskView[] }
  | { kind: 'task:start'; taskId: string }
  | { kind: 'task:stdout'; taskId: string; chunk: string }
  | { kind: 'task:stderr'; taskId: string; chunk: string }
  | { kind: 'task:complete'; outcome: OutcomeView }
  | { kind: 'run:status'; line: string }
  | { kind: 'run:end' }

/**
 * Map an in-process event to its serializable wire form. `run:start`
 * needs the graph's nodes to build the task table (the event alone
 * doesn't carry them), so it's assembled by the boundary that has the
 * nodes map and passes them in; every other event projects from its own
 * payload.
 */
export function toWireEvent(event: RunEvent, tasks: TaskView[] = []): WireEvent {
  switch (event.kind) {
    case 'run:start':
      return { kind: 'run:start', info: event.info, tasks }
    case 'task:start':
      return { kind: 'task:start', taskId: event.node.id }
    case 'task:stdout':
      return { kind: 'task:stdout', taskId: event.node.id, chunk: event.chunk }
    case 'task:stderr':
      return { kind: 'task:stderr', taskId: event.node.id, chunk: event.chunk }
    case 'task:complete':
      return { kind: 'task:complete', outcome: projectOutcome(event.outcome) }
    case 'run:status':
      return { kind: 'run:status', line: event.line }
    case 'run:end':
      return { kind: 'run:end' }
  }
}
