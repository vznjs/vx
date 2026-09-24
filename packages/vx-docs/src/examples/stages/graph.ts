import { definePlugin, type VxPlugin } from '@vzn/vx'

// Every project's `e2e` suite waits for that project's `build`.
export function e2eAfterBuild(): VxPlugin {
  return definePlugin(import.meta, {
    graph(nodes) {
      for (const node of nodes.values()) {
        const build = `${node.projectName}#build`
        if (node.taskName !== 'e2e' || !nodes.has(build)) continue
        if (!node.deps.includes(build)) node.deps.push(build)
      }
    },
  })
}
