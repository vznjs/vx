import type { TaskNode } from '../graph/task-graph.js'
import type { TaskOutcome } from '../graph/scheduler.js'
import { detectColors, type ColorSupport } from './colors.js'
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

/**
 * A Logger that silently drops every call. Pass this to `run()` when
 * another consumer (the TUI) owns the terminal — the default logger
 * writes framed-block output to stdout, which would otherwise bleed
 * through the TUI's alt-screen render and corrupt the UI.
 */
export function noopLogger(): Logger {
  return {
    status: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
  }
}

export function defaultLogger(colors: ColorSupport = detectColors()): Logger {
  // Per-task buffers, split by stream. Splitting lets the framed-output
  // renderer put stdout in the body and stderr under an `├─ Error`
  // section. The price: chunks that interleaved at runtime get
  // re-ordered (all stdout before all stderr). Observers still see
  // the original interleaving via the structural event stream.
  const stdoutBuffers = new Map<string, string>()
  const stderrBuffers = new Map<string, string>()
  // Tracks whether we've already emitted at least one task block so
  // we can prefix subsequent blocks with a blank line for visual
  // separation. The header (formatHeader) already ends with a blank
  // line, so the first block doesn't need one.
  let blocksEmitted = 0

  return {
    status(line) {
      process.stdout.write(`${line}\n`)
    },
    taskStdout(node, chunk) {
      stdoutBuffers.set(node.id, (stdoutBuffers.get(node.id) ?? '') + chunk)
    },
    taskStderr(node, chunk) {
      stderrBuffers.set(node.id, (stderrBuffers.get(node.id) ?? '') + chunk)
    },
    taskComplete(node, outcome) {
      const stdout = stdoutBuffers.get(node.id) ?? ''
      const stderr = stderrBuffers.get(node.id) ?? ''
      stdoutBuffers.delete(node.id)
      stderrBuffers.delete(node.id)
      // formatTaskBlock returns '' for group tasks (no exec) — skip
      // the write so a stray newline doesn't sneak into the output.
      const block = formatTaskBlock(node, outcome, { stdout, stderr }, colors)
      if (block.length === 0) return
      process.stdout.write(blocksEmitted > 0 ? `\n${block}` : block)
      blocksEmitted++
    },
  }
}
