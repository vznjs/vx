// `cache`: where artifacts live. A directory stands in for a remote store;
// `LayeredCache` puts it behind the local cache, so a remote error is a
// miss and a warning, never a failed run.
import { link, mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { definePlugin, LayeredCache, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

class DirRemote implements RemoteCacheLayer {
  constructor(readonly endpoint: string) {}
  async has(hash: string): Promise<boolean> {
    return Bun.file(path.join(this.endpoint, hash)).exists()
  }
  async get(hash: string) {
    const file = Bun.file(path.join(this.endpoint, hash))
    return (await file.exists()) ? { body: file, durationMs: undefined } : null
  }
  async put(hash: string, body: Blob): Promise<void> {
    await mkdir(this.endpoint, { recursive: true })
    // Written aside, then linked: on a shared directory a rename can swap
    // the file under a reader, while a link never replaces an existing one.
    // EEXIST is success: the same hash means the same bytes.
    const tmp = path.join(this.endpoint, `.${hash}.${process.pid}`)
    await Bun.write(tmp, body)
    try {
      await link(tmp, path.join(this.endpoint, hash))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    } finally {
      await unlink(tmp)
    }
  }
}

export function dirCache(dir: string): VxPlugin {
  return definePlugin(import.meta, {
    cache(ctx) {
      return new LayeredCache(ctx.localCache, new DirRemote(dir), {
        policy: ctx.policy,
        onRemoteError: (err) => ctx.warn(`dir-cache: ${err.message}`),
      })
    },
  })
}
