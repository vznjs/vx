import { definePlugin, type VxPlugin } from '@vzn/vx'

// The shape of a lockfile claim. This one folds the whole file back into
// every key, which is what core did without it, and answers "every project"
// for --affected. pnpm() from @vzn/vx-lockfile folds each project's own
// dependency closure instead, and names the projects a change reaches.
export function wholeLockfile(): VxPlugin {
  return definePlugin(import.meta, {
    fingerprint: { files: ['pnpm-lock.yaml'], affected: () => undefined },
    async key(_task, ctx) {
      const text = await Bun.file(`${ctx.workspaceRoot}/pnpm-lock.yaml`).text()
      return { 'pnpm-lock': Bun.hash(text).toString(16) }
    },
  })
}
