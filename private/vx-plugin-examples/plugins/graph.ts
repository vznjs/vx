// `graph`: the run's edges. Every task named `task` waits for the one
// before it, so they run one after another across projects: in dependency
// order, then id order, so an added edge never closes a cycle. Core checks
// the edited graph again (a missing dep, a cycle).
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function chain(task: string): VxPlugin {
  return definePlugin(import.meta, {
    graph(nodes) {
      const named = (id: string): boolean => id.endsWith(`#${task}`)
      const ids: string[] = []
      const seen = new Set<string>()
      const visit = (id: string): void => {
        if (seen.has(id)) return
        seen.add(id)
        for (const dep of nodes.get(id)?.deps ?? []) visit(dep)
        if (named(id)) ids.push(id)
      }
      for (const id of [...nodes.keys()].filter(named).sort()) visit(id)
      for (const [i, id] of ids.entries()) {
        const prev = ids[i - 1]
        const node = nodes.get(id)!
        if (prev !== undefined && !node.deps.includes(prev)) node.deps.push(prev)
      }
    },
  })
}
