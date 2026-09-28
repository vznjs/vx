// `schedule`: which ready task runs first. Tasks named here outrank the rest;
// earlier in the list, higher.
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function prioritize(ids: readonly string[]): VxPlugin {
  return definePlugin(import.meta, {
    schedule(nodes) {
      const weights = new Map<string, number>()
      for (const [i, id] of ids.entries()) if (nodes.has(id)) weights.set(id, 1e6 - i)
      return weights
    },
  })
}
