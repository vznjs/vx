import { definePlugin, type VxPlugin } from '@vzn/vx'

// Start one task as soon as it is ready. Core starts first the ready task
// that the most other tasks wait on; a task nothing waits on, such as a
// docs build, starts last, even when it is the longest in the run.
export function startFirst(taskId: string): VxPlugin {
  return definePlugin(import.meta, {
    schedule(nodes) {
      if (!nodes.has(taskId)) return undefined
      // Any weight of 1 or more sorts above every task without one.
      return new Map([[taskId, 1]])
    },
  })
}
