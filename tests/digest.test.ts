import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  type CASBackend,
  digestEqual,
  digestString,
  type Digest,
  FsCASBackend,
  makeDigest,
  MemoryCASBackend,
  parseDigest,
} from '../src/cache/index.js'

describe('Digest', () => {
  it('makeDigest accepts hex hashes and non-negative size', () => {
    const d = makeDigest('deadbeef', 1024)
    expect(d.hash).toBe('deadbeef')
    expect(d.sizeBytes).toBe(1024)
  })

  it('makeDigest rejects non-hex hashes', () => {
    expect(() => makeDigest('not-hex', 100)).toThrow()
    expect(() => makeDigest('', 100)).toThrow()
  })

  it('makeDigest rejects negative or non-integer sizes', () => {
    expect(() => makeDigest('abc', -1)).toThrow()
    expect(() => makeDigest('abc', 1.5)).toThrow()
    expect(() => makeDigest('abc', Number.NaN)).toThrow()
  })

  it('digestEqual is field-wise', () => {
    expect(digestEqual(makeDigest('a', 1), makeDigest('a', 1))).toBe(true)
    expect(digestEqual(makeDigest('a', 1), makeDigest('b', 1))).toBe(false)
    expect(digestEqual(makeDigest('a', 1), makeDigest('a', 2))).toBe(false)
  })

  it('digestString / parseDigest round-trip', () => {
    const d = makeDigest('cafebabe', 4096)
    expect(digestString(d)).toBe('cafebabe/4096')
    const parsed = parseDigest('cafebabe/4096')
    expect(digestEqual(d, parsed)).toBe(true)
  })

  it('parseDigest rejects malformed input', () => {
    expect(() => parseDigest('no-slash')).toThrow()
  })
})

describe('CASBackend reference impls', () => {
  const cases: Array<{ name: string; make: () => CASBackend; cleanup?: () => void }> = [
    { name: 'MemoryCASBackend', make: () => new MemoryCASBackend() },
  ]

  let tmpDir: string
  tmpDir = mkdtempSync(path.join(tmpdir(), 'vx-cas-'))
  cases.push({
    name: 'FsCASBackend',
    make: () => new FsCASBackend(tmpDir),
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  })

  for (const c of cases) {
    describe(c.name, () => {
      it('round-trips bytes through put/get', async () => {
        const backend = c.make()
        const bytes = new Uint8Array([1, 2, 3, 4, 5])
        const digest: Digest = makeDigest('deadbeef01', bytes.byteLength)
        expect(await backend.has(digest)).toBe(false)
        expect(await backend.get(digest)).toBeNull()
        await backend.put(digest, bytes)
        expect(await backend.has(digest)).toBe(true)
        const out = await backend.get(digest)
        expect(out).not.toBeNull()
        expect(Array.from(out!)).toEqual(Array.from(bytes))
      })

      it('rejects put with sizeBytes mismatch', async () => {
        const backend = c.make()
        const digest = makeDigest('cafe01', 100)
        const bytes = new Uint8Array([1, 2, 3])
        await expect(backend.put(digest, bytes)).rejects.toThrow(/sizeBytes mismatch/)
      })

      it('remove evicts the entry', async () => {
        const backend = c.make()
        const bytes = new Uint8Array([9, 9, 9])
        const digest = makeDigest('be01', bytes.byteLength)
        await backend.put(digest, bytes)
        expect(await backend.has(digest)).toBe(true)
        await backend.remove(digest)
        expect(await backend.has(digest)).toBe(false)
        expect(await backend.get(digest)).toBeNull()
      })

      it('remove of missing entry is a no-op', async () => {
        const backend = c.make()
        await backend.remove(makeDigest('ab5e0001', 0))
      })

      if (c.cleanup) c.cleanup()
    })
  }
})
