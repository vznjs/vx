import { definePlugin, type VxPlugin } from '@vzn/vx'

// A task whose command starts with `bun` is keyed on the Bun version too,
// so upgrading Bun reruns it instead of replaying the old result.
export function bunVersion(): VxPlugin {
  return definePlugin(import.meta, {
    key(task) {
      const command = task.config.exec?.command ?? ''
      return command.startsWith('bun ') ? { bun: Bun.version } : undefined
    },
  })
}
