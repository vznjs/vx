// `commands`: a CLI verb. `vx cache-dir` prints where this workspace's cache
// lives. The verb's return value is the exit code.
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function cacheDirVerb(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      'cache-dir': {
        description: "print this workspace's cache directory",
        run(argv, ctx) {
          if (argv.length > 0) {
            console.error(`vx cache-dir: takes no arguments, got ${argv.join(' ')}`)
            return 2
          }
          console.log(ctx.cacheDir)
          return 0
        },
      },
    },
  })
}
