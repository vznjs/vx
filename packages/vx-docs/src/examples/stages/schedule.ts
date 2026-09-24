import { definePlugin, type VxPlugin } from '@vzn/vx'

// Among ready tasks, start the e2e suites first, then the unit tests. The
// rest keep core's order.
export function suitesFirst(): VxPlugin {
  const weights: Record<string, number> = { e2e: 2, test: 1 }
  return definePlugin(import.meta, {
    schedule(nodes) {
      const out = new Map<string, number>()
      for (const node of nodes.values()) {
        const weight = weights[node.taskName]
        if (weight !== undefined) out.set(node.id, weight)
      }
      return out
    },
  })
}
