import { definePlugin, type VxPlugin } from '@vzn/vx'

// On CI, where the runner's cores are shared, run at most `max` tasks at once.
export function ciConcurrency(max: number): VxPlugin {
  return definePlugin(import.meta, {
    config(workspace) {
      if (process.env['CI'] === undefined) return
      workspace.concurrency = Math.min(workspace.concurrency ?? max, max)
    },
  })
}
