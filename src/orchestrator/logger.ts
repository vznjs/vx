import type { TaskNode } from '../graph/task-graph.js'
import type { TaskOutcome } from '../graph/scheduler.js'
import { formatTaskBlock } from './framed-output.js'

export interface Logger {
  /** Header / footer / status text. Written verbatim, one trailing \n added. */
  status(line: string): void
  /** Streamed stdout chunk for a task. Buffered until `taskComplete`. */
  taskStdout(node: TaskNode, chunk: string): void
  /** Streamed stderr chunk for a task. Buffered until `taskComplete`. */
  taskStderr(node: TaskNode, chunk: string): void
  /**
   * Flush a task's buffered output as one framed block. Called once
   * per task on completion (success, failure, cache hit, or skip).
   */
  taskComplete(node: TaskNode, outcome: TaskOutcome): void
}

export function defaultLogger(): Logger {
  // Per-task buffer. We don't separate stdout/stderr in the rendered
  // block — the user sees them in arrival order, same as Turbo.
  const buffers = new Map<string, string>()

  const append = (node: TaskNode, chunk: string): void => {
    buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
  }

  return {
    status(line) {
      process.stdout.write(`${line}\n`)
    },
    taskStdout(node, chunk) {
      append(node, chunk)
    },
    taskStderr(node, chunk) {
      append(node, chunk)
    },
    taskComplete(node, outcome) {
      const body = buffers.get(node.id) ?? ''
      buffers.delete(node.id)
      // formatTaskBlock returns '' for group tasks (no exec) — skip
      // the write so a stray newline doesn't sneak into the output.
      const block = formatTaskBlock(node, outcome, body)
      if (block.length > 0) process.stdout.write(block)
    },
  }
}
