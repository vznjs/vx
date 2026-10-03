// A file created and removed before the judgement (vim's `4913` write
// probe, a tool's lock file) started a cycle with nothing changed: a
// path never seen and now gone counted as a deletion. With the files that
// existed at the arm known, a gone path that was not among them was
// never part of the tree a key read, and a real deletion still is one.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { ChangeJudge } from '../src/cli/watch-judge.js'
import { gitFiles } from '../src/cli/watch-filter.js'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

const judgeIn = (root: string, existedAtArm?: ReadonlySet<string>) =>
  new ChangeJudge({
    workspaceRoot: root,
    armedAt: 0,
    held: () => false,
    uncached: () => new Set(),
    ...(existedAtArm !== undefined ? { existedAtArm } : {}),
  })

it('a file born and gone after the arm starts no cycle', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-transient-'))
  const judge = judgeIn(dir, new Set([path.join(dir, 'a.txt')]))
  judge.pending.set(path.join(dir, '4913'), 'app 4913')
  expect(judge.judge()).toBeUndefined()
})

// Controls: a file that existed at the arm and is gone is a deletion; with
// no inventory (no git), a gone path is one as before.
it('a file that existed at the arm and is gone still starts one', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-transient-'))
  const judge = judgeIn(dir, new Set([path.join(dir, 'a.txt')]))
  judge.pending.set(path.join(dir, 'a.txt'), 'app a.txt')
  expect(judge.judge()).toBe('app a.txt')
})

it('with no inventory a gone path is a deletion', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-transient-'))
  const judge = judgeIn(dir)
  judge.pending.set(path.join(dir, '4913'), 'app 4913')
  expect(judge.judge()).toBe('app 4913')
})

it('a file born after the arm and still there starts one', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-transient-'))
  await writeFile(path.join(dir, 'new.txt'), 'x\n')
  const judge = judgeIn(dir, new Set())
  judge.pending.set(path.join(dir, 'new.txt'), 'app new.txt')
  expect(judge.judge()).toBe('app new.txt')
})

// Git lists files, never directories: a project moved away whole (its
// directory one event) read as never there and the cycle that drops it
// never ran. The inventory holds every directory above a listed file.
it('a directory that held listed files and is gone starts one', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-transient-'))
  await mkdir(path.join(dir, 'packages', 'b'), { recursive: true })
  await writeFile(path.join(dir, 'packages', 'b', 'x.txt'), 'x\n')
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  const listed = gitFiles(dir)
  expect(listed?.has(path.join(dir, 'packages', 'b', 'x.txt'))).toBe(true)
  await rm(path.join(dir, 'packages', 'b'), { recursive: true })
  const judge = judgeIn(dir, listed)
  judge.pending.set(path.join(dir, 'packages', 'b'), 'packages/b')
  judge.pending.set(path.join(dir, 'packages'), 'packages')
  expect(judge.judge()).toBe('packages/b')
})
