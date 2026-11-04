// `commands`: a CLI verb. `vx cache-dir` prints where this workspace's cache
// lives. The verb's return value is the exit code.
import { definePlugin, ui, type VxPlugin } from '@vzn/vx'

export function cacheDirVerb(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      'cache-dir': {
        description: "print this workspace's cache directory",
        run(argv, ctx) {
          if (argv.length > 0) {
            ui.say('error', `vx cache-dir: takes no arguments, got ${argv.join(' ')}`)
            return 2
          }
          ui.data('out', `${ctx.cacheDir}\n`)
          return 0
        },
      },
    },
  })
}
