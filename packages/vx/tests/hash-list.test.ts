// The index's batched reads take their hashes as one JSON array, not a `?`
// apiece: one statement whatever the count, and no ceiling on it. Bun's
// SQLite refuses more than 250,000 variables (probed 2026-10-03), and the
// output-file and output-dir reads were not chunked, so a batch past it threw.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

const HASH = '0123456789abcdef'
const fakes = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `f${i.toString(16).padStart(15, '0')}`)

describe('a batched index read', () => {
  let root: string
  let projectDir: string
  let cache: Cache
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-hash-list-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(path.join(projectDir, 'dist'), { recursive: true })
    const out = path.join(projectDir, 'dist', 'out.txt')
    await writeFile(out, 'bytes')
    cache = new Cache(path.join(root, 'cache'))
    await cache.save({
      hash: HASH,
      projectDir,
      outputFiles: [out],
      entry: { taskId: 'pkg#build', command: 'build', durationMs: 1, stdout: 'hi' },
    })
  })
  afterEach(async () => {
    cache.close()
    await rm(root, { recursive: true, force: true })
  })

  it("answers past SQLite's variable ceiling", async () => {
    const many = [...fakes(250_001), HASH]
    expect(
      [...cache.loadOutputFilesBatch(many)].map(([h, rows]) => [h, rows.map((r) => r.path)]),
    ).toEqual([[HASH, ['dist/out.txt']]])
    // A directory this new is inside the snapshot's racy window: no rows.
    expect(cache.loadOutputDirsBatch(many).size).toBe(0)
    expect([...(await cache.getMany(many)).keys()]).toEqual([HASH])
  })

  it('answers one hash, several and none as the per-hash get does', async () => {
    const one = await cache.get(HASH)
    for (const batch of [[HASH], [HASH, ...fakes(3)], fakes(3)]) {
      const got = await cache.getMany(batch)
      expect([...got.keys()]).toEqual(batch.includes(HASH) ? [HASH] : [])
      if (batch.includes(HASH)) expect(got.get(HASH)).toEqual(one!)
    }
  })
})
