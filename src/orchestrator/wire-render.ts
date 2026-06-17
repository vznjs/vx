// The inverse of `wireForwarder`: turn a stream of `WireEvent`s back into
// `Logger` calls on a concrete renderer. A `vx serve` client feeds the
// service's event stream through this into a normal `defaultLogger`, so a
// DELEGATED run renders identically to a local one — the terminal
// renderer stays completely untouched (it just receives reconstructed
// node-shaped objects instead of live graph nodes). This file is the
// whole adapter; it can be rewritten or removed without touching the
// renderer or the producer side.

import type { TaskNode, TaskOutcome } from '../graph/index.js'
import type { Logger } from './logger.js'
import type { OutcomeView, TaskView, WireEvent } from './events.js'

/**
 * Rebuild a node-shaped object from a `TaskView`. The formatters only ever
 * read `id` / `projectName` / `taskName` / `requested` / `surfaced` and
 * `config.exec` (presence ⇒ not a group; `.command`; `.persistent`), so a
 * structural stand-in is indistinguishable from a real `TaskNode` to them.
 */
function reconstructNode(view: TaskView): TaskNode {
  const exec = view.isGroup
    ? undefined
    : {
        command: view.command ?? '',
        ...(view.persistent ? { persistent: { readyWhen: '' } } : {}),
      }
  return {
    id: view.id,
    projectName: view.project,
    taskName: view.task,
    requested: view.requested,
    surfaced: view.surfaced,
    config: exec === undefined ? {} : { exec },
  } as unknown as TaskNode
}

function reconstructOutcome(view: OutcomeView, node: TaskNode): TaskOutcome {
  return {
    node,
    status: view.status,
    exitCode: view.exitCode,
    durationMs: view.durationMs,
    ...(view.restored !== undefined ? { restored: view.restored } : {}),
    ...(view.sandboxViolations !== undefined ? { sandboxViolations: view.sandboxViolations } : {}),
    ...(view.sandboxViolationLines !== undefined
      ? { sandboxViolationLines: view.sandboxViolationLines }
      : {}),
  } as TaskOutcome
}

/**
 * Build a `WireEvent` consumer that drives `sink` (typically a
 * `defaultLogger`). Stateful: it accumulates the reconstructed nodes from
 * `task:start` so later `task:*` events can resolve their node by id.
 */
export function createWireRenderer(sink: Logger): (event: WireEvent) => void {
  const nodes = new Map<string, TaskNode>()
  return (event) => {
    switch (event.kind) {
      case 'run:start':
        sink.runStart?.(event.info)
        return
      case 'task:start': {
        const node = reconstructNode(event.task)
        nodes.set(node.id, node)
        sink.taskStart?.(node)
        return
      }
      case 'task:stdout': {
        const node = nodes.get(event.taskId)
        if (node) sink.taskStdout(node, event.chunk)
        return
      }
      case 'task:stderr': {
        const node = nodes.get(event.taskId)
        if (node) sink.taskStderr(node, event.chunk)
        return
      }
      case 'task:complete': {
        const node = nodes.get(event.outcome.taskId)
        if (node) sink.taskComplete(node, reconstructOutcome(event.outcome, node))
        return
      }
      case 'run:status':
        sink.status(event.line)
        return
      case 'run:end':
        sink.runEnd?.()
        return
    }
  }
}
