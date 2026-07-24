// Today's flat-dir artifact storage behind the BlobBackend seam: bytes at
// `<dir>/<key>`, wire metadata as `<hash>.duration` / `<hash>.digest` sidecar
// FILES beside the artifact — the pre-seam on-disk layout, byte-identical, so
// existing local deployments keep their warm store.

import path from 'node:path'
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import type { BlobBackend, BlobListEntry, BlobStat } from './backend.js'

export class LocalDirBackend implements BlobBackend {
  constructor(private readonly dir: string) {}

  localPathFor(key: string): string {
    return path.join(this.dir, key)
  }

  async head(key: string): Promise<BlobStat | null> {
    try {
      const st = await stat(this.localPathFor(key))
      return { size: st.size, storedAt: Math.round(st.mtimeMs), meta: {} }
    } catch {
      return null
    }
  }

  async put(key: string, file: string, _size: number, meta: Record<string, string>): Promise<void> {
    const dest = this.localPathFor(key)
    await mkdir(path.dirname(dest), { recursive: true })
    // Atomic same-dir rename — the store colocates the spool with a local
    // destination, so a concurrent GET never sees a torn artifact.
    await rename(file, dest)
    const base = dest.replace(/\.tar\.zst$/, '')
    const duration = meta['durationMs']
    if (duration !== undefined) await Bun.write(`${base}.duration`, duration)
    const digest = meta['digest']
    if (digest !== undefined) await Bun.write(`${base}.digest`, digest)
  }

  presignGet(): null {
    return null
  }

  async list(prefix: string): Promise<BlobListEntry[]> {
    const dirPath = path.join(this.dir, prefix)
    let names: string[]
    try {
      names = await readdir(dirPath)
    } catch {
      return [] // scope dir doesn't exist yet — nothing stored there
    }
    const out: BlobListEntry[] = []
    for (const n of names) {
      if (!n.endsWith('.tar.zst')) continue
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(path.join(dirPath, n))
      } catch {
        continue // raced with a prune — skip
      }
      const entry: BlobListEntry = {
        key: `${prefix}/${n}`,
        size: st.size,
        storedAt: Math.round(st.mtimeMs),
      }
      const durationFile = Bun.file(
        path.join(dirPath, `${n.slice(0, -'.tar.zst'.length)}.duration`),
      )
      if (await durationFile.exists()) {
        const d = Number((await durationFile.text()).trim())
        if (Number.isFinite(d) && d >= 0) entry.durationMs = d
      }
      out.push(entry)
    }
    return out
  }
}
