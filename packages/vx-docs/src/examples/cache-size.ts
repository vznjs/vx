import { definePlugin, UserError, type VxPlugin } from '@vzn/vx'

// `vx cache-size [--json]`: how many files the cache directory holds, and
// how many bytes. The exit code of `run` is the exit code of `vx`.
export function cacheSize(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      'cache-size': {
        description: 'print the size of the cache directory',
        async run(argv, ctx) {
          const unknown = argv.find((arg) => arg !== '--json')
          if (unknown !== undefined) throw new UserError(`vx cache-size: unknown flag ${unknown}`)
          let files = 0
          let bytes = 0
          for await (const file of new Bun.Glob('**/*').scan({ cwd: ctx.cacheDir, dot: true })) {
            files += 1
            bytes += Bun.file(`${ctx.cacheDir}/${file}`).size
          }
          console.log(
            argv.includes('--json')
              ? JSON.stringify({ files, bytes })
              : `${files} files, ${bytes} bytes`,
          )
          return 0
        },
      },
    },
  })
}
