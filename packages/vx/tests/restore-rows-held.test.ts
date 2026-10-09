// A batched probe's rows serve its hits' restores (X-162): the restore's
// missing-output check and the stamps after it read the rows the probe
// loaded, not the index — two queries per restore on a warm run that
// restores every output. Rows that change after the probe are not served.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { OutputIndex } from '../src/cache/output-index.js'

const HASH = '0123456789abcdef'
let root = ''

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function saveFiles(cache: Cache, proj: string, files: Record<string, string>): Promise<void> {
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
