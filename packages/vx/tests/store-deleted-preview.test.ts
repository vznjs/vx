// A `--dry` plan reads the shared store without a hold of its own, so a
// `vx cache clean` in another checkout (or `--global` in another workspace)
// can delete the store between the plan's look for store.db and its attach.
// The plan died on SQLite's error (VX_E_INTERNAL "disk I/O error", or
// "unable to open"); it now reads the store it found gone as empty, as it
// reads one that was never there. `node:fs` is mocked so the delete lands
// in that window every time.

import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, mock } from 'bun:test'

const real = { ...fs }
/** store.db whose next existence check deletes its directory after answering. */
let deleteAfterLook: string | undefined

await mock.module('node:fs', () => ({
  ...real,
  existsSync: (p: fs.PathLike) => {
    const found = real.existsSync(p)
    if (deleteAfterLook !== undefined && String(p) === deleteAfterLook) {
      deleteAfterLook = undefined
      real.rmSync(path.dirname(String(p)), { recursive: true, force: true })
    }
    return found
  },
}))

const { Cache } = await import('../src/cache/cache.js')

let tmp = ''
beforeEach(() => {
  tmp = real.mkdtempSync(path.join(os.tmpdir(), 'vx-store-deleted-'))
})
afterEach(() => {
  deleteAfterLook = undefined
  real.rmSync(tmp, { recursive: true, force: true })
})

it('a dry plan whose store is deleted as it opens it reads the store as empty', () => {
  const cacheDir = path.join(tmp, 'ws', '.vx', 'cache')
  const storeDir = path.join(tmp, 'home', '.vx', 'id', 'cache')
  real.mkdirSync(path.join(tmp, 'ws'))
  real.mkdirSync(path.join(tmp, 'home'))
  new Cache(cacheDir, undefined, path.join(tmp, 'ws'), undefined, 'open', storeDir).close()
  expect(real.existsSync(path.join(storeDir, 'store.db'))).toBe(true)

  deleteAfterLook = path.join(storeDir, 'store.db')
  const plan = new Cache(
    cacheDir,
    { read: true, write: false },
    path.join(tmp, 'ws'),
    undefined,
    'preview',
    storeDir,
  )
  try {
    expect(deleteAfterLook).toBeUndefined()
    expect(real.existsSync(storeDir)).toBe(false)
  } finally {
    plan.close()
  }
  // Read only: the plan made no store again.
  expect(real.existsSync(storeDir)).toBe(false)
})
