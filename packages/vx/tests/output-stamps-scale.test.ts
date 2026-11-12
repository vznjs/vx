// A batch read overlays the stamps taken and not yet flushed on its rows.
// It found each row's stamp by scanning the hash's whole stamp list, rows ×
// stamps: one 40,000-file output spent ~7 s of an 8.5 s run there, after
// every save and restore. Its rows are many and its stamps as many.

import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { OutputIndex } from '../src/memo/index.js'
import { createTables } from '../src/index-db/index.js'
import { cpuClock } from './helpers/cpu-clock.js'

const N = 20_000
const root = mkdtempSync(path.join(tmpdir(), 'vx-stamps-scale-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('the pending-stamp overlay of a 20,000-file output is linear', () => {
  const proj = path.join(root, 'proj')
  mkdirSync(path.join(proj, 'dist'), { recursive: true })
  const rows: Array<[string, number, number, number]> = []
  for (let i = 0; i < N; i++) {
    const rel = `dist/f${i}.js`
    const abs = path.join(proj, rel)
    writeFileSync(abs, 'x')
    const st = statSync(abs)
    rows.push([rel, st.size, st.mode, st.mtimeMs])
  }
  const db = new Database(':memory:')
  createTables(db)
  const index = new OutputIndex(db)
  index.replaceFileRows('h1', rows)
  index.recordOutputStamps('h1', proj, root)

  let best = Infinity
  let read: ReturnType<OutputIndex['loadOutputFilesBatch']> | undefined
  for (let i = 0; i < 3; i++) {
    const cpu = cpuClock()
    read = index.loadOutputFilesBatch(['h1'])
    best = Math.min(best, cpu())
  }
  // Functional pin beside the bound: every row carries its own file's stamp.
  const got = read!.get('h1')!
  expect(got.length).toBe(N)
  for (const r of got) {
    const st = statSync(path.join(proj, r.path))
    expect([r.ino, r.ctimeMs]).toEqual([st.ino, Math.floor(st.ctimeMs)])
  }
  // CPU, not wall (lessons.md): linear took 10 ms here, the scan 1.3 s.
  expect(best).toBeLessThan(250)
  db.close()
}, 60_000)
