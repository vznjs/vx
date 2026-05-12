import type { TaskNode } from '../graph/task-graph.js'
import type { TaskOutcome } from '../graph/scheduler.js'

export interface Logger {
  status(line: string): void
  taskStdout(node: TaskNode, chunk: string): void
  taskStderr(node: TaskNode, chunk: string): void
}

export function formatOutcome(o: TaskOutcome): string {
  const tag =
    o.status === 'cache-hit'
      ? '◉  cache'
      : o.status === 'cache-hit-remote'
        ? '↓  remote'
        : o.status === 'success'
          ? '✓'
          : o.status === 'failed'
            ? '✗'
            : '·  skip'
  return `${tag} ${o.node.id}  (${o.durationMs}ms)`
}

export function defaultLogger(): Logger {
  return {
    status(line) {
      process.stdout.write(`${line}\n`)
    },
    taskStdout(node, chunk) {
      process.stdout.write(prefix(node.id, chunk))
    },
    taskStderr(node, chunk) {
      process.stderr.write(prefix(node.id, chunk))
    },
  }
}

function prefix(id: string, chunk: string): string {
  const pad = `${id} │ `
  return (
    chunk
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => `${pad}${line}`)
      .join('\n') + (chunk.endsWith('\n') ? '\n' : '')
  )
}
