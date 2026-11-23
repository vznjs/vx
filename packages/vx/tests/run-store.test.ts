// A run's own entries (failed tasks' outputs, logs) go to each remote the
// run writes with a plain `put`: core asks no `has` first (2026-10-15),
// since an entry is immutable and the remote keeps what it holds.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { packRunOutputs, putRunEntry } from '../src/cache/run-store.js'
import { tarEntriesSync } from '../src/cache/tar-stream.js'

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
      new Blob([new Uint8Array([1])]),
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
      new Blob([new Uint8Array([1])]),
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
      new Blob([new Uint8Array([1])]),
    )
    expect([kept, said]).toEqual([true, ['upload of log failed: 503 from cache.example']])
  })
})

describe('packRunOutputs', () => {
  it('spools outputs past 8 MiB to a tar a release removes, skipping a file gone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-run-pack-'))
    try {
      await mkdir(path.join(root, 'dist'))
      const big = new Uint8Array(9 * 1024 * 1024 + 7).fill(66)
      await writeFile(path.join(root, 'dist/big'), big)
      await writeFile(path.join(root, 'dist/s'), 'small')
      const out = await packRunOutputs(root, ['dist/big', 'dist/gone', 'dist/s'])
      expect(out).not.toBeNull()
      const entries = [...tarEntriesSync(await out!.body.bytes())]
      expect(entries.map((e) => [e.name, e.size])).toEqual([
        ['dist/big', big.byteLength],
        ['dist/s', 5],
      ])
      expect(entries[0]!.body().every((b) => b === 66)).toBe(true)
      const spool = (out!.body as ReturnType<typeof Bun.file>).name!
      expect(spool.startsWith(path.join(root, '.vx/tmp/'))).toBe(true)
      await out!.release()
      expect(await Bun.file(spool).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
