import { definePlugin, LayeredCache, type VxPlugin } from '@vzn/vx'

// A shared directory, such as a network mount, as a second cache behind the
// local store. A real one writes to a temporary name and renames it.
export function sharedDir(dir: string): VxPlugin {
  const file = (hash: string) => Bun.file(`${dir}/${hash}`)
  return definePlugin(import.meta, {
    cache: (ctx) =>
      new LayeredCache(
        ctx.localCache,
        {
          has: (hash) => file(hash).exists(),
          get: async (hash) =>
            (await file(hash).exists()) ? { body: file(hash), durationMs: undefined } : null,
          put: async (hash, body) => void (await Bun.write(file(hash), body)),
        },
        { policy: ctx.policy },
      ),
  })
}
