// What a task is, for its history: a task whose command changed under the
// same name is a new task, and its timings start over (2026-10-23: "task
// can disappear and appear as a completely new one with the same name").
// Only what decides what the command costs: the command and the values it
// is given (`env.define`). Inputs, outputs, cache, sandbox grants, timeout,
// description and dependencies change no cost, so editing them keeps the
// history.

import { xxh3hex } from '../util/index.js'
import type { TaskNode } from './task-graph.js'

const memo = new WeakMap<TaskNode, string | undefined>()

/** The task's definition hash; undefined for one with no command (a group). */
export function taskDefinition(node: TaskNode): string | undefined {
  if (memo.has(node)) return memo.get(node)
  const exec = node.config.exec
  const def =
    exec?.command === undefined
      ? undefined
      : xxh3hex(
          `${node.id}\0${exec.command}\0${JSON.stringify(
            Object.entries(exec.env?.define ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )}`,
        )
  memo.set(node, def)
  return def
}

/** Each task's definition (`taskDefinition`) by id, groups left out: what a history reader matches rows to. */
export function taskDefinitions(nodes: Iterable<TaskNode>): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of nodes) {
    const def = taskDefinition(n)
    if (def !== undefined) out.set(n.id, def)
  }
  return out
}
