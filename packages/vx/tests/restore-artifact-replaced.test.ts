// An artifact replaced under its own key while a restore reads it — another
// save or remote ingest of the same key renames a fresh copy over it, and a
// copy packed at another time differs in size — is still a hit. Bun caches a
// file's size at its first stat and reads no further: the restore stat the
// old copy, read the new one cut to the old length, called it corrupt and
// DROPPED the good artifact the rename had just landed.

import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { Cache } from '../src/cache/index.js'

const HASH = '0123456789abcdef'
let root = ''

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function saveInto(cache: Cache, proj: string, body: string): Promise<void> {
  await Bun.write(path.join(proj, 'out.txt'), body)
  await cache.save({
    hash: HASH,
    entry: { taskId: 'p#t', command: 'echo', durationMs: 1, stdout: '' },
    projectDir: proj,
    outputFiles: [path.join(proj, 'out.txt')],
  })
}

const random = (n: number): string => crypto.getRandomValues(new Uint8Array(n)).toBase64()

for (const [kind, before, after] of [
  ['small', 3, 10],
  ['streamed', 4 * 1024 * 1024, 5 * 1024 * 1024],
] as const) {
  it(`a ${kind} artifact renamed over mid-restore restores the new copy`, async () => {
    root = mkdtempSync(path.join(tmpdir(), 'vx-replaced-'))
    const cache = new Cache(path.join(root, 'cache'), { read: true, write: true })
    const other = new Cache(path.join(root, 'other'), { read: true, write: true })
    try {
      await saveInto(cache, path.join(root, 'a'), random(before))
      const grown = random(after)
      await saveInto(other, path.join(root, 'b'), grown)
      const artifact = cache.outputsPath(HASH)
      const staged = `${artifact}.staged`
      copyFileSync(other.outputsPath(HASH), staged)
      other.close()

      const original = Bun.file
      let swapped = false
      const spy = spyOn(Bun, 'file').mockImplementation(((p: string, opts?: BlobPropertyBag) => {
        const f = original(p, opts)
        if (p === artifact && !swapped) {
          swapped = true
          void f.size
          renameSync(staged, artifact)
        }
        return f
      }) as typeof Bun.file)
      const out = path.join(root, 'restored')
      try {
        await cache.restoreOutputs(HASH, out)
      } finally {
        spy.mockRestore()
      }
      expect(readFileSync(path.join(out, 'out.txt'), 'utf8')).toBe(grown)
      expect(await cache.has(HASH)).toBe('local')
    } finally {
      cache.close()
    }
  })
}
