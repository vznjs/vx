// An output that grows or shrinks between the save's plan (its stat) and
// the copy is not the file its row describes: both stores refuse the save.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, DEFAULT_STORE } from '../src/cache/cache.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
let proj: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-save-moved-size-'))
  proj = path.join(root, 'p')
  mkdirSync(path.join(proj, 'dist'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const entry = { taskId: 'p#build', command: 'c', durationMs: 1, stdout: '' }

for (const [store, label] of [
  [DEFAULT_STORE, 'tree'],
  [TAR_STORE, 'tar'],
] as const) {
  it(`the ${label} store refuses an output that grew after the plan, and indexes nothing`, async () => {
    const out = path.join(proj, 'dist', 'a.bin')
    writeFileSync(out, crypto.getRandomValues(new Uint8Array(64 * 1024)))
    const cache = new Cache(
      path.join(root, 'cache'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    )
    const c = cache as unknown as { planWithin: (a: unknown) => Promise<unknown> }
    const plan = c.planWithin.bind(cache)
    c.planWithin = async (a) => {
      const p = await plan(a)
      appendFileSync(out, 'late write')
      return p
    }
    try {
      const saved = await cache
        .save({ hash: 'k1', projectDir: proj, outputFiles: [out], entry })
        .then(
          () => 'saved',
          (e: Error) => e.message,
        )
      expect([saved, cache.dbHandle().query('SELECT path FROM output_files').all()]).toEqual([
        'outputs/dist/a.bin: 65546 bytes, 65536 declared',
        [],
      ])
    } finally {
      cache.close()
    }
  })
}
