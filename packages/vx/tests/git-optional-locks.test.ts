// The input enumeration leaves the index alone. A porcelain `status`
// refreshes the index when it can take `index.lock`, and a user's own
// `git add` or `commit` failed on that lock while a vx run held it (2 of
// 635 across 40 runs, item 880). The row makes every tracked file
// stat-dirty with its content unchanged, the one state git writes a
// refresh for, runs the enumeration, and reads the index back byte for
// byte. The control then runs `status` bare and sees the index rewritten,
// so the state was still refresh-worthy after vx looked. `--affected`'s
// `git diff <base>` refreshed the index the same way: every git vx runs
// gets `GIT_OPTIONAL_LOCKS=0` from `gitEnv`.
import {
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { startGitEnumeration } from '../src/cache/index.js'
import { affectedProjects } from '../src/workspace/affected.js'
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

  it('`--affected` diffs the base without refreshing the index', async () => {
    const before = index()
    const projects = [
      { name: 'r', dir: root, packageJson: { name: 'r' } as never, configPath: null },
    ]
    expect([...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects }))]).toEqual(
      [],
    )
    expect(index().equals(before)).toBe(true)
    gitIn(root)('diff', 'HEAD')
    expect(index().equals(before)).toBe(false)
  })

  it('`--affected` still drops a stat-only change and keeps a content one', async () => {
    for (const p of ['a', 'b', 'c']) mkdirSync(path.join(root, p))
    symlinkSync('../f0.txt', path.join(root, 'a', 'link'))
    await Bun.write(path.join(root, 'b', 'x.txt'), '1\n')
    await Bun.write(path.join(root, 'c', 'x.txt'), '1\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-qm', 'more')
    const back = new Date(statSync(path.join(root, '.git', 'index')).mtimeMs - 60_000)
    lutimesSync(path.join(root, 'a', 'link'), back, back)
    utimesSync(path.join(root, 'c', 'x.txt'), back, back)
    await Bun.write(path.join(root, 'b', 'x.txt'), '2\n')
    const projects = ['a', 'b', 'c'].map((name) => ({
      name,
      dir: path.join(root, name),
      packageJson: { name } as never,
      configPath: null,
    }))
    const before = index()
    expect([...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects }))]).toEqual(
      ['b'],
    )
    expect(index().equals(before)).toBe(true)
  })
})
