import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

// A row-less lookup stats its artifact path for the first 64 asks, then
// the artifact directory is listed once (a cold run asked 3,270 times
// before its first task). Past the listing a row-less file artifact still
// adopts: one listed, and one this process wrote after the listing.

const ctx = { taskId: 'pkg#build', command: 'tsc' }

async function saveFile(cache: Cache, root: string, hash: string): Promise<void> {
  const projectDir = path.join(root, hash)
  await mkdir(path.join(projectDir, 'dist'), { recursive: true })
  const out = path.join(projectDir, 'dist', 'out.bin')
  // Incompressible and past INLINE_MAX: the artifact is a file.
  await writeFile(out, crypto.getRandomValues(new Uint8Array(48 * 1024)))
  await cache.save({
    hash,
    projectDir,
    outputFiles: [out],
    entry: { taskId: 'pkg#build', command: 'tsc', durationMs: 1, stdout: '' },
  })
  cache.dbHandle().query('DELETE FROM entries WHERE hash = ?').run(hash)
}

describe('row-less lookups past the stat limit', () => {
  it('adopt a listed artifact and one written after the listing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-adopt-listing-'))
    try {
      const dir = path.join(root, 'cache')
      const listed = 'aaaaaaaaaaaaaaaa'
      const saver = new Cache(dir)
      await saveFile(saver, root, listed)
      saver.close()

      const cache = new Cache(dir)
      try {
        for (let i = 0; i < 100; i++) {
          expect(await cache.get(i.toString(16).padStart(16, 'f'), ctx)).toBeNull()
        }
        expect((await cache.get(listed, ctx))?.hash).toBe(listed)
        const later = 'bbbbbbbbbbbbbbbb'
        await saveFile(cache, root, later)
        expect((await cache.get(later, ctx))?.hash).toBe(later)
      } finally {
        cache.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
