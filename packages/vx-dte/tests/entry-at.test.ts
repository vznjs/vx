// A failed sandboxed task's violations each carry what the worker's disk
// holds at the path. A read of `cfg.json/x`, under a file, threw ENOTDIR
// there (Bun's `throwIfNoEntry` passes over ENOENT alone) and failed the
// task's report; core's own violations had the same throw until 2026-11-27.
import { afterAll, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { entryAt } from '../src/worker.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-dte-entry-at-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('a path under a file is missing', () => {
  writeFileSync(path.join(dir, 'cfg.json'), '{}')
  mkdirSync(path.join(dir, 'd'))
  expect(['cfg.json/x', 'none', 'cfg.json', 'd'].map((p) => entryAt(path.join(dir, p)))).toEqual([
    'missing',
    'missing',
    'file',
    'dir',
  ])
})
