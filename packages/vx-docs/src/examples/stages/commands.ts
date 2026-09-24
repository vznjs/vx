import { definePlugin, type VxPlugin } from '@vzn/vx'

// `vx where` prints the workspace root and the cache directory.
export function where(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      where: {
        description: 'print the workspace root and the cache directory',
        run(_argv, ctx) {
          console.log(`${ctx.workspaceRoot}\n${ctx.cacheDir}`)
          return 0
        },
      },
    },
  })
}
