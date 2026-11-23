// A cycle is named by its least changed path. `mkdir -p src/x/y` and a file
// written in it fire the new directory first, and the cycle read
// `changed app src/x (+1 more)`: the directory, not the file the user made.
// The count then said one more than the files written: it counted the
// directory made for them.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { fsClockNow } from '../src/memo/index.js'
import { ChangeJudge } from '../src/cli/watch-judge.js'

it('a changed file names the cycle before a directory that came with it', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-judge-label-')))
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    const judge = new ChangeJudge({
      workspaceRoot: root,
      armedAt: fsClockNow(root),
      held: () => false,
      uncached: () => new Set(),
    })
    await Bun.sleep(20)
    const dir = path.join(root, 'src', 'x')
    await mkdir(path.join(dir, 'y'), { recursive: true })
    const file = path.join(dir, 'y', 'deep.txt')
    await writeFile(file, 'D\n')
    judge.pending.set(dir, 'app src/x')
    judge.pending.set(file, 'app src/x/y/deep.txt')
    // The directories made for it are not more changes.
    expect(judge.judge()).toBe('app src/x/y/deep.txt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('files written in a new directory are counted without it', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-judge-label-')))
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    const judge = new ChangeJudge({
      workspaceRoot: root,
      armedAt: fsClockNow(root),
      held: () => false,
      uncached: () => new Set(),
    })
    await Bun.sleep(20)
    const dir = path.join(root, 'src', 'many')
    await mkdir(dir, { recursive: true })
    judge.pending.set(dir, 'app src/many')
    for (const n of [0, 1, 2]) {
      const file = path.join(dir, `m${n}.txt`)
      await writeFile(file, `${n}\n`)
      judge.pending.set(file, `app src/many/m${n}.txt`)
    }
    expect(judge.judge()).toBe('app src/many/m0.txt (+2 more)')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
