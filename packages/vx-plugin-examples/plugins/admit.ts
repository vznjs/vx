// `admit`: whether a ready task starts now, beside what runs here. At most
// one task of the named `task` runs at a time (say, one that holds a port).
// Synchronous and cheap: it is asked at every dispatch.
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function oneAtATime(task: string): VxPlugin {
  const named = (id: string): boolean => id.endsWith(`#${task}`)
  return definePlugin(import.meta, {
    admit(node, ctx) {
      return !named(node.id) || !ctx.running.some((r) => named(r.id))
    },
  })
}
