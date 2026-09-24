import { definePlugin, type TaskNode, type VxPlugin } from '@vzn/vx'

// At most two tasks that start containers run on this machine at once.
export function twoContainers(): VxPlugin {
  const docker = (task: TaskNode) => task.config.exec?.command.startsWith('docker ') === true
  return definePlugin(import.meta, {
    admit(task, ctx) {
      if (!docker(task)) return true
      return ctx.running.filter(docker).length < 2
    },
  })
}
