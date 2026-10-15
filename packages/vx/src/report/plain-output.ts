import type { TaskNode } from '../graph/index.js'
import type { Logger } from './logger.js'

// A prefix that may yet complete as a CSI or OSC sequence. An escape cut
// at a chunk's end is held for the next chunk: stripped alone, its
// remainder (`1m`) reached the log as text.
// eslint-disable-next-line no-control-regex -- ESC is the point
const PARTIAL_ESCAPE = /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/

/**
 * `sink` with terminal escapes stripped from task output. Tasks run with
 * `FORCE_COLOR` (exec/env.ts), so their bytes carry colour wherever vx's
 * own output is plain: a pipe, CI, `NO_COLOR`.
 */
export function plainOutput(sink: Logger): Logger {
  const held = new Map<string, string>()
  const strip = (key: string, chunk: string): string => {
    const prior = held.get(key)
    const text = prior === undefined ? chunk : prior + chunk
    if (prior !== undefined) held.delete(key)
    const esc = text.lastIndexOf('\x1b')
    if (esc === -1) return text
    if (PARTIAL_ESCAPE.test(text.slice(esc))) {
      held.set(key, text.slice(esc))
      return Bun.stripANSI(text.slice(0, esc))
    }
    return Bun.stripANSI(text)
  }
  const flush = (node: TaskNode, key: string, write: (n: TaskNode, c: string) => void): void => {
    const rest = held.get(key)
    if (rest === undefined) return
    held.delete(key)
    const text = Bun.stripANSI(rest)
    if (text !== '') write(node, text)
  }
  // Delegated one by one, never spread: an embedder's logger may be a class
  // whose methods live on its prototype and read `this`.
  return {
    status: (line) => sink.status(line),
    ...(sink.runStart && { runStart: (info) => sink.runStart!(info) }),
    ...(sink.taskStart && { taskStart: (node) => sink.taskStart!(node) }),
    ...(sink.runEnd && { runEnd: () => sink.runEnd!() }),
    taskStdout(node, chunk) {
      const text = strip(`${node.id}\0out`, chunk)
      if (text !== '' || chunk === '') sink.taskStdout(node, text)
    },
    taskStderr(node, chunk) {
      const text = strip(`${node.id}\0err`, chunk)
      if (text !== '' || chunk === '') sink.taskStderr(node, text)
    },
    taskComplete(node, outcome) {
      flush(node, `${node.id}\0out`, (n, c) => sink.taskStdout(n, c))
      flush(node, `${node.id}\0err`, (n, c) => sink.taskStderr(n, c))
      sink.taskComplete(node, outcome)
    },
  }
}
