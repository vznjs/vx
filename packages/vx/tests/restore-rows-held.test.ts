// A batched probe's rows serve its hits' restores (X-162): the restore's
// missing-output check and the stamps after it read the rows the probe
// loaded, not the index — two queries per restore on a warm run that
// restores every output. Rows that change after the probe are not served.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { OutputIndex } from '../src/cache/output-index.js'
import { isInline } from './helpers/stored-artifact.js'

const HASH = '0123456789abcdef'
let root = ''

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function saveFiles(
  cache: Cache,
  proj: string,
  files: Record<string, string | Uint8Array>,
): Promise<void> {
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(proj, rel), body)
  await cache.save({
    hash: HASH,
    entry: { taskId: 'p#t', command: 'echo', durationMs: 1, stdout: '' },
    projectDir: proj,
    outputFiles: Object.keys(files).map((rel) => path.join(proj, rel)),
  })
}

it('a probed hit restores and stamps without reading its rows again (X-162)', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-rows-held-'))
  const proj = path.join(root, 'proj')
  const cacheDir = path.join(root, 'cache')
  const seed = new Cache(cacheDir, { read: true, write: true })
  mkdirSync(proj)
  await saveFiles(seed, proj, { 'a.txt': 'a' })
  seed.close()

  const read = spyOn(OutputIndex.prototype, 'loadOutputFilesBatch')
  const cache = new Cache(cacheDir, { read: true, write: true })
  try {
    expect((await cache.getMany([HASH])).get(HASH)?.outputFiles).toEqual(['a.txt'])
    read.mockClear()
    const out = path.join(root, 'out')
    await cache.restoreOutputs(HASH, out)
    cache.recordOutputStamps(HASH, out, root)
    // Read before the restore of the spy, which clears what it recorded.
    expect(read.mock.calls).toEqual([])
    expect(readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('a')
  } finally {
    read.mockRestore()
    cache.close()
  }
})

it('rows replaced after the probe are the ones the restore checks (X-162)', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-rows-held-'))
  const proj = path.join(root, 'proj')
  mkdirSync(proj)
  const cache = new Cache(path.join(root, 'cache'), { read: true, write: true })
  try {
    await saveFiles(cache, proj, { 'a.txt': 'a', 'b.txt': 'b' })
    expect((await cache.getMany([HASH])).get(HASH)?.outputFiles).toEqual(['a.txt', 'b.txt'])
    // Saved again under the same key with one file: the probe's two rows
    // would call the new artifact short of `b.txt` and drop it.
    rmSync(path.join(proj, 'b.txt'))
    await saveFiles(cache, proj, { 'a.txt': 'A' })
    const out = path.join(root, 'out')
    await cache.restoreOutputs(HASH, out)
    expect(readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('A')
    expect(await cache.has(HASH)).toBe('local')
  } finally {
    cache.close()
  }
})

it('an inline artifact re-saved by another writer after the probe restores with its own rows', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-rows-held-'))
  const proj = path.join(root, 'proj')
  const cacheDir = path.join(root, 'cache')
  mkdirSync(proj)
  const cache = new Cache(cacheDir, { read: true, write: true })
  const other = new Cache(cacheDir, { read: true, write: true })
  try {
    await saveFiles(cache, proj, { 'a.txt': 'a' })
    expect((await cache.getMany([HASH])).get(HASH)?.outputFiles).toEqual(['a.txt'])
    // A later millisecond: the re-save's `at` is not the probe's.
    await Bun.sleep(2)
    rmSync(path.join(proj, 'a.txt'))
    await saveFiles(other, proj, { 'b.txt': 'b' })
    const out = path.join(root, 'out')
    await cache.restoreOutputs(HASH, out)
    expect(readFileSync(path.join(out, 'b.txt'), 'utf8')).toBe('b')
  } finally {
    other.close()
    cache.close()
  }
})

// A tree entry the probe held rows for restores with no statement at all:
// the blob read and its transaction were ~70 ms of a 1,600-restore run's
// main thread (2026-11-07). A tree found is the live artifact: an inline
// save moves it aside in the commit that adds its blob.
it('a probed tree hit restores without a statement', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-rows-held-'))
  const proj = path.join(root, 'proj')
  mkdirSync(proj)
  const cache = new Cache(path.join(root, 'cache'), { read: true, write: true })
  const blob = Buffer.from(crypto.getRandomValues(new Uint8Array(48 * 1024)))
  const spies = (['prepare', 'query', 'transaction'] as const).map((m) =>
    spyOn(Database.prototype, m),
  )
  try {
    await saveFiles(cache, proj, { 'big.bin': blob })
    expect(isInline(cache, HASH)).toBe(false)
    expect((await cache.getMany([HASH])).get(HASH)?.outputFiles).toEqual(['big.bin'])
    for (const s of spies) s.mockClear()
    const out = path.join(root, 'out')
    await cache.restoreOutputs(HASH, out)
    expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 0, 0])
    expect(readFileSync(path.join(out, 'big.bin')).equals(blob)).toBe(true)
  } finally {
    for (const s of spies) s.mockRestore()
    cache.close()
  }
})

it('a probed inline hit restores with its blob read alone, in no transaction', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-rows-held-'))
  const proj = path.join(root, 'proj')
  mkdirSync(proj)
  const cache = new Cache(path.join(root, 'cache'), { read: true, write: true })
  const tx = spyOn(Database.prototype, 'transaction')
  try {
    await saveFiles(cache, proj, { 'a.txt': 'a' })
    expect(isInline(cache, HASH)).toBe(true)
    expect((await cache.getMany([HASH])).get(HASH)?.outputFiles).toEqual(['a.txt'])
    tx.mockClear()
    const out = path.join(root, 'out')
    await cache.restoreOutputs(HASH, out)
    expect(tx.mock.calls.length).toBe(0)
    expect(readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('a')
  } finally {
    tx.mockRestore()
    cache.close()
  }
})

it("a tree the probe saw, moved aside by another writer's inline save, restores the inline bytes", async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-rows-held-'))
  const proj = path.join(root, 'proj')
  const cacheDir = path.join(root, 'cache')
  mkdirSync(proj)
  const cache = new Cache(cacheDir, { read: true, write: true })
  const other = new Cache(cacheDir, { read: true, write: true })
  try {
    const blob = Buffer.from(crypto.getRandomValues(new Uint8Array(48 * 1024)))
    await saveFiles(cache, proj, { 'big.bin': blob })
    expect(isInline(cache, HASH)).toBe(false)
    expect((await cache.getMany([HASH])).get(HASH)?.outputFiles).toEqual(['big.bin'])
    rmSync(path.join(proj, 'big.bin'))
    await saveFiles(other, proj, { 'small.txt': 'small' })
    expect(isInline(other, HASH)).toBe(true)
    const out = path.join(root, 'out')
    await cache.restoreOutputs(HASH, out)
    expect(readFileSync(path.join(out, 'small.txt'), 'utf8')).toBe('small')
  } finally {
    other.close()
    cache.close()
  }
})
