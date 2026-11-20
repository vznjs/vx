// An output swapped for a link between the save's plan (its lstat) and the
// copy is not the file its row describes: the copy followed the link and
// stored the target's bytes as a regular file, so every hit replayed
// another output's bytes there. Each store and size refuses the save.
import { indexDb } from '../src/cache/index.js'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { Cache, DEFAULT_STORE } from '../src/cache/cache.js'
import * as saving from '../src/cache/save.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
let proj: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-save-swapped-link-'))
  proj = path.join(root, 'p')
  mkdirSync(path.join(proj, 'dist'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const entry = { taskId: 'p#build', command: 'c', durationMs: 1, stdout: '' }

for (const [store, label] of [
  [DEFAULT_STORE, 'tree'],
  [TAR_STORE, 'tar'],
] as const) {
  for (const size of [16, 4 * 1024 * 1024]) {
    it(`the ${label} store refuses a ${size}-byte output swapped for a link after the plan`, async () => {
      const a = path.join(proj, 'dist', 'a.bin')
      const b = path.join(proj, 'dist', 'b.bin')
      writeFileSync(a, new Uint8Array(size).fill(0x61))
      writeFileSync(b, new Uint8Array(size).fill(0x62))
      const cache = new Cache(
        path.join(root, 'cache'),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        store,
      )
      const plan = saving.planOutputs
      const spy = spyOn(saving, 'planOutputs').mockImplementation(async (...args) => {
        const p = await plan(...args)
        unlinkSync(a)
        symlinkSync('b.bin', a)
        return p
      })
      try {
        const saved = await cache
          .save({ hash: 'k1', projectDir: proj, outputFiles: [a, b], entry })
          .then(
            () => 'saved',
            (e: Error) => e.message,
          )
        expect([saved, indexDb(cache).query('SELECT path FROM output_files').all()]).toEqual([
          'outputs/dist/a.bin changed while it was saved: it is not the file the task left',
          [],
        ])
      } finally {
        spy.mockRestore()
        cache.close()
      }
    })
  }
}
