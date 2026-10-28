// A cycle is named by its first changed path. `mkdir -p src/x/y` and a file
// written in it fire the new directory first, and the cycle read
// `changed app src/x (+1 more)`: the directory, not the file the user made.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { fsClockNow } from '../src/cli/watch-fs.js'
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
    expect(judge.judge()).toBe('app src/x/y/deep.txt (+1 more)')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
