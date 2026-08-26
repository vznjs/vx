// Integration: Cache.contentBackend() returns an FsCASBackend pointing
// at the same artifacts directory Cache.save writes to. Reading via
// the CAS backend retrieves the same bytes Cache.outputsPath references.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache, FsCASBackend, makeDigest } from '../src/cache/index.js'

describe('Cache.contentBackend() — CAS view over saved artifacts', () => {
  it('returns an FsCASBackend rooted at the same cacheDir', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-cas-'))
    const cache = new Cache(cacheDir)
    try {
      const backend = cache.contentBackend()
      // Round-trip a known artifact via the CAS interface.
      const bytes = new TextEncoder().encode('a-fake-tar.zst-body')
      const digest = makeDigest('cafebabe', bytes.byteLength)
      expect(await backend.has(digest)).toBe(false)
      await backend.put(digest, bytes)
      expect(await backend.has(digest)).toBe(true)
      const out = await backend.get(digest)
      expect(out).not.toBeNull()
      expect(Array.from(out!)).toEqual(Array.from(bytes))
      await backend.remove(digest)
      expect(await backend.has(digest)).toBe(false)
    } finally {
      cache.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('put() is atomic: a concurrent reader never sees a partial blob', async () => {
    // Content-addressing INVITES two writers of the same blob, and this is
    // a public seam (`Cache.contentBackend()`), so an embedder can race it.
    // A plain write would let a reader observe a half-written file under a
    // name that promises complete bytes; temp + rename cannot.
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-cas-atomic-'))
    try {
      const backend = new FsCASBackend(dir)
      const bytes = new Uint8Array(512 * 1024).fill(7)
      const digest = makeDigest('a'.repeat(64), bytes.byteLength)
      let partial = 0
      const reader = (async () => {
        for (let i = 0; i < 200; i++) {
          const got = await backend.get(digest)
          if (got !== null && got.byteLength !== bytes.byteLength) partial++
          await Bun.sleep(0)
        }
      })()
      await Promise.all([backend.put(digest, bytes), backend.put(digest, bytes), reader])
      expect(partial).toBe(0)
      expect((await backend.get(digest))?.byteLength).toBe(bytes.byteLength)
      // …and no scratch file survived.
      expect([...new Bun.Glob('*.tmp-*').scanSync({ cwd: dir })]).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
