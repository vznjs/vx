// The input enumeration leaves the index alone. A porcelain `status`
// refreshes the index when it can take `index.lock`, and a user's own
// `git add` or `commit` failed on that lock while a vx run held it (2 of
// 635 across 40 runs, item 880). The row makes every tracked file
// stat-dirty with its content unchanged, the one state git writes a
// refresh for, runs the enumeration, and reads the index back byte for
// byte. The control then runs `status` bare and sees the index rewritten,
// so the state was still refresh-worthy after vx looked.
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { startGitEnumeration } from '../src/cache/index.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

const FILES = 20

let root = ''
beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vx-optlocks-')))
  for (let i = 0; i < FILES; i++) await Bun.write(path.join(root, `f${i}.txt`), `${i}\n`)
  gitInitCommit(root, 'init')
  // Older than the index, so no entry is racily clean, and not the mtime
  // the index recorded, so every entry is stat-dirty.
  const back = new Date(statSync(path.join(root, '.git', 'index')).mtimeMs - 60_000)
  for (let i = 0; i < FILES; i++) utimesSync(path.join(root, `f${i}.txt`), back, back)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const index = (): Buffer => readFileSync(path.join(root, '.git', 'index'))

describe('the input enumeration reads git without refreshing the index', () => {
  it('`status` runs with --no-optional-locks', async () => {
    const before = index()
    await startGitEnumeration(root, ['.'])
    expect(index().equals(before)).toBe(true)
    gitIn(root)('status', '--porcelain')
    expect(index().equals(before)).toBe(false)
  })
})
