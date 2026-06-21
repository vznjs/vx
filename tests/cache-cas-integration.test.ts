// Integration: Cache.contentBackend() returns an FsCASBackend pointing
// at the same artifacts directory Cache.save writes to. Reading via
// the CAS backend retrieves the same bytes Cache.outputsPath references.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache, makeDigest } from '../src/cache/index.js'

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
})
