// `graph`: the run's edges. Every task named `task` waits for the one
// before it in id order, so they run one after another across projects.
// Core checks the edited graph again (a missing dep, a cycle).
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function chain(task: string): VxPlugin {
  return definePlugin(import.meta, {
    graph(nodes) {
      const ids = [...nodes.keys()].filter((id) => id.endsWith(`#${task}`)).sort()
      for (const [i, id] of ids.entries()) {
        const prev = ids[i - 1]
        const node = nodes.get(id)!
        if (prev !== undefined && !node.deps.includes(prev)) node.deps.push(prev)
      }
    },
  })
}
