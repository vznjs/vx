// `fsClockNow` is the moment a window asks "written after this?" of, so a
// file written before the call must read as before it. Its first stamp in a
// directory came off a file just made, whose times nothing had read: Linux
// (6.13+) stamped it from its coarse clock, the same tick as a file renamed
// into place a moment earlier. `vx watch` started right after `vx lock`
// took the lock for an edit made during its first run, and ran a cycle
// nobody asked for ("changed root .vx/projects.lock.json").

import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { fsClockNow } from '../src/memo/index.js'

const base = mkdtempSync(path.join(os.tmpdir(), 'vx-fs-clock-now-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('fsClockNow', () => {
  it('dates a write made before its first call in a directory before it', () => {
    const late: string[] = []
    // Each directory is a first call. Unfixed, 49 of 50 tight pairs tied on 6.18.
    for (let i = 0; i < 200; i++) {
      const dir = path.join(base, `d${i}`)
      mkdirSync(dir)
      const lock = path.join(dir, 'lock.json')
      writeFileSync(`${lock}.tmp`, '{}')
      renameSync(`${lock}.tmp`, lock)
      const from = fsClockNow(dir)
      const st = statSync(lock)
      const written = Math.max(st.mtimeMs, st.ctimeMs)
      if (written >= from) late.push(`${written} >= ${from}`)
    }
    expect(late).toEqual([])
  })
})
