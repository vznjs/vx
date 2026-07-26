// Today's flat-dir artifact storage behind the BlobBackend seam: bytes at
// `<dir>/<key>`, wire metadata as `<hash>.duration` / `<hash>.digest` sidecar
// FILES beside the artifact — the pre-seam on-disk layout, byte-identical, so
// existing local deployments keep their warm store.

import path from 'node:path'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import type { BlobBackend, BlobListEntry, BlobStat } from './backend.js'

/** The sidecar files this backend writes beside an artifact (S3 carries the
 *  same metadata inline as object user metadata). */
const SIDECAR_EXTS = ['.duration', '.digest']

async function unlinkIfPresent(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

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

  async delete(key: string): Promise<void> {
    const dest = this.localPathFor(key)
    const base = dest.replace(/\.tar\.zst$/, '')
    // The sidecars go with the artifact or they leak forever: `list` reports
    // only `.tar.zst`, so nothing would ever find them again.
    await Promise.all([dest, ...SIDECAR_EXTS.map((e) => `${base}${e}`)].map(unlinkIfPresent))
  }

  presignGet(): null {
    return null
  }

  async list(prefix: string): Promise<BlobListEntry[]> {
    const dirPath = path.join(this.dir, prefix)
    let names: string[]
    try {
      // Recursive: a scope prefix names a leaf dir (nothing nested to find),
      // but the reaper lists a whole tenancy prefix — matching S3, where a
      // prefix listing is depth-blind.
      names = await readdir(dirPath, { recursive: true })
    } catch {
      return [] // scope dir doesn't exist yet — nothing stored there
    }
    const out: BlobListEntry[] = []
    for (const raw of names) {
      if (!raw.endsWith('.tar.zst')) continue
      const n = raw.split(path.sep).join('/')
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(path.join(dirPath, raw))
      } catch {
        continue // raced with a prune — skip
      }
      const entry: BlobListEntry = {
        key: `${prefix}/${n}`,
        size: st.size,
        storedAt: Math.round(st.mtimeMs),
      }
      const durationFile = Bun.file(
        path.join(dirPath, `${raw.slice(0, -'.tar.zst'.length)}.duration`),
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
