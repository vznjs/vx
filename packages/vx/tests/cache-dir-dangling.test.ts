// A cache dir at a link to nothing was "a file, not a directory — move it
// away": there is no file there to find. It now names the link's target.
import { afterAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openCacheDir } from '../src/cache/cache-dir.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-cache-dangling-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('a cache dir at a link to nothing names the link', () => {
  const at = path.join(dir, 'cache')
  symlinkSync('nowhere', at)
  expect(() => openCacheDir(at)).toThrow(`${at} is a link to nowhere, which is not there`)
})

// A loop of links crashed every run with a raw ELOOP stack.
it('a cache dir at a loop of links names the loop', () => {
  const a = path.join(dir, 'loop-a')
  symlinkSync('loop-b', a)
  symlinkSync('loop-a', path.join(dir, 'loop-b'))
  expect(() => openCacheDir(a)).toThrow(
    `${a} is a link to loop-b, which loops back through links and never ends`,
  )
})
