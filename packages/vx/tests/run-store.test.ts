// A run's own entries (failed tasks' outputs, logs) go to each remote the
// run writes with a plain `put`: core asks no `has` first (2026-10-15),
// since an entry is immutable and the remote keeps what it holds.

import { describe, expect, it } from 'bun:test'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { putRunEntry } from '../src/cache/run-store.js'

describe('putRunEntry', () => {
  it('sends one put per writing remote and asks no has', async () => {
    const calls: string[] = []
    const remote: RemoteCacheLayer = {
      async has(h) {
        calls.push(`has ${h}`)
        return {}
      },
      async get() {
        return null
      },
      async put(h) {
        calls.push(`put ${h}`)
      },
    }
    const kept = await putRunEntry(
      [
        { remote, read: true, write: true },
        { remote, read: true, write: false },
      ],
      undefined,
      'log',
      new Uint8Array([1]),
    )
    expect(kept).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.startsWith('put ')).toBe(true)
  })

  it('keeps nothing where every put declined with false', async () => {
    const remote: RemoteCacheLayer = {
      has: async () => null,
      get: async () => null,
      put: async () => false,
    }
    const kept = await putRunEntry(
      [{ remote, read: true, write: true }],
      undefined,
      'log',
      new Uint8Array([1]),
    )
    expect(kept).toBe(false)
  })

  it("says a remote's failed put, and the others still keep it", async () => {
    const said: string[] = []
    const failing: RemoteCacheLayer = {
      has: async () => null,
      get: async () => null,
      put: async () => {
        throw new Error('503 from cache.example')
      },
    }
    const ok: RemoteCacheLayer = {
      has: async () => null,
      get: async () => null,
      put: async () => {},
    }
    const kept = await putRunEntry(
      [
        { remote: failing, read: true, write: true, onError: (e) => said.push(e.message) },
        { remote: ok, read: true, write: true },
      ],
      undefined,
      'log',
      new Uint8Array([1]),
    )
    expect([kept, said]).toEqual([true, ['503 from cache.example']])
  })
})
