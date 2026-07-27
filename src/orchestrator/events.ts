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
  /** The run's canonical start (epoch ms) — the SAME value the end-of-run
   *  summary reports as `startedAt`. A telemetry sink needs it during the run
   *  (e.g. to derive per-task started_at consistently with the batch summary
   *  for idempotent incremental ingest). */
  startedAtMs?: number
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
      //
      // A throwing subscriber must NEVER break the run — the whole point
      // of the bus is that a surface (the devframe dev server, a future
      // TUI) is isolated from execution. We swallow per-subscriber so one
      // bad surface can't crash the user's build (mirrors the deleted
      // Observer's makeSafeObserver contract). The terminal renderer is
      // trusted and output-tested, so a real renderer bug still surfaces
      // as wrong output, not a silent hang.
      for (const subscriber of subscribers) {
        try {
          subscriber(event)
        } catch {
          // isolate: a surface fault can't propagate into the orchestrator
        }
      }
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

/**
 * A bus subscriber that projects each event to its `WireEvent` and hands
 * it to `send` — the shared run→consumer forwarding path (the `vx dev`
 * hub frames each as NDJSON; the `vx serve` protocol wraps each in an
 * envelope). Group-task start/complete events are dropped (no command,
 * pure scheduling noise). `run()` emits run:end twice (normal + finally)
 * plus trailing summary status lines; we forward the run once and then go
 * quiet, so a consumer sees exactly one terminal frame per run. `send`
 * must be fire-and-forget and tolerant of its own failures (a dead
 * consumer can never break the run); the bus already isolates throws.
 */
export function wireForwarder(send: (event: WireEvent) => void): RunEventSubscriber {
  // run() emits run:end TWICE (normal + finally), with the summary footer
  // (run:status lines) emitted in BETWEEN. Drop the duplicate run:end, but
  // keep forwarding everything else — including those post-run:end status
  // lines, so a consumer that renders them (the serve client) gets the
  // footer. A consumer that ignores run:status (the dev hub) is unaffected.
  let endForwarded = false
  // Which tasks the consumer has been told about. A skipped task never
  // reaches the scheduler's onStart, so its completion arrives with no
  // preceding task:start — and `createWireRenderer` resolves a completion's
  // node from the start it recorded, so it would drop the task entirely
  // while the forwarded footer still counted it. Synthesize the start here,
  // where the live TaskNode is in hand, so the projection stays full
  // fidelity (real requested/surfaced/command) instead of a stand-in.
  const started = new Set<string>()
  return (event) => {
    if (event.kind === 'run:end') {
      if (endForwarded) return
      endForwarded = true
    } else if (
      (event.kind === 'task:start' || event.kind === 'task:complete') &&
      isGroupTask(event.node)
    ) {
      return
    } else if (event.kind === 'task:start') {
      started.add(event.node.id)
    } else if (event.kind === 'task:complete' && !started.has(event.node.id)) {
      started.add(event.node.id)
      send({ kind: 'task:start', task: projectNode(event.node) })
    }
    send(toWireEvent(event))
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
 * The serializable form of a RunEvent — JSON / structured-clone safe, the
 * wire contract a non-local consumer (devframe, `vx serve` client) reads.
 * `task:start` carries the full `TaskView` so a consumer can rebuild a
 * node-shaped object incrementally (no upfront table needed); later
 * task events reference the id, which the consumer already holds.
 */
export type WireEvent =
  | { kind: 'run:start'; info: RunStartInfo }
  | { kind: 'task:start'; task: TaskView }
  | { kind: 'task:stdout'; taskId: string; chunk: string }
  | { kind: 'task:stderr'; taskId: string; chunk: string }
  | { kind: 'task:complete'; outcome: OutcomeView }
  | { kind: 'run:status'; line: string }
  | { kind: 'run:end' }

/** Map an in-process event to its serializable wire form. */
export function toWireEvent(event: RunEvent): WireEvent {
  switch (event.kind) {
    case 'run:start':
      return { kind: 'run:start', info: event.info }
    case 'task:start':
      return { kind: 'task:start', task: projectNode(event.node) }
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
