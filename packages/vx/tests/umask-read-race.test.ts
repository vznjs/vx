// A restore reads the umask when it starts, and parallel restores run in one
// process. Bun's `process.umask()` reads it by setting 0 and putting it back,
// so a directory another restore made on a pool thread in that window landed
// 0777: a DTE run's restored `bin/` was 0777 where the worker left 0755.

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { readUmask } from '../src/util/index.js'

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('reading the umask never widens a directory made meanwhile', async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vx-umask-race-'))
  const before = process.umask(0o022)
  try {
    let reading = true
    const reader = (async () => {
      while (reading) {
        for (let i = 0; i < 200; i++) readUmask()
        await new Promise((r) => setImmediate(r))
      }
    })()
    const made = Array.from({ length: 2000 }, (_, i) => path.join(dir, `d${i}`))
    await Promise.all(made.map((d) => mkdir(d)))
    reading = false
    await reader
    const wide = made.filter((d) => (statSync(d).mode & 0o777) !== 0o755)
    expect(wide.map((d) => (statSync(d).mode & 0o777).toString(8))).toEqual([])
  } finally {
    process.umask(before)
  }
})
