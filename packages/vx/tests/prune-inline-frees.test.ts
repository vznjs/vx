// Small artifacts live inside the index (`embeddings`). A prune deleted
// their rows and reported the bytes freed, but SQLite kept the pages on its
// free list and the file never shrank: on a full disk the verb meant to
// free space freed nothing for them.

import { statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-prune-inline-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a prune of inline entries frees the bytes it says it freed', async () => {
  const dir = path.join(root, 'c')
  const proj = path.join(root, 'p')
  await mkdir(path.join(proj, 'dist'), { recursive: true })
  const cache = new Cache(dir)
  for (let i = 0; i < 200; i++) {
    const hash = i.toString(16).padStart(16, '0')
    const out = path.join(proj, 'dist', `${hash}.bin`)
    await writeFile(out, crypto.getRandomValues(new Uint8Array(20 * 1024)))
    await cache.save({
      hash,
      projectDir: proj,
      outputFiles: [out],
      entry: { taskId: `p#${i}`, command: 'x', durationMs: 1, stdout: '' },
    })
  }
  cache.close()
  const disk = (): number =>
    ['cache.db', 'cache.db-wal'].reduce(
      (n, f) => n + (statSync(path.join(dir, f), { throwIfNoEntry: false })?.size ?? 0),
      0,
    )
  const before = disk()
  const again = new Cache(dir)
  const r = await again.prune({ maxBytes: 1024 })
  again.close()
  expect(r.evicted).toBe(200)
  expect(before - disk()).toBeGreaterThanOrEqual(r.bytesFreed * 0.9)
})
