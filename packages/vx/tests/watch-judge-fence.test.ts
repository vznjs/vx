// A git-ignored path is an edit under a project with an uncached task
// (item 947), but not one inside a project nested under it: the root's
// task does not own that file, and the root arm's label carried it in
// (X-43).

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { makeFence } from '../src/cli/watch-filter.js'
import { fsClockNow } from '../src/cli/watch-fs.js'
import { ChangeJudge } from '../src/cli/watch-judge.js'

it('an ignored file in a nested project is no edit of the uncached root above it (X-43)', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-judge-fence-')))
  try {
    const nested = path.join(root, 'packages', 'a')
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(root, '.gitignore'), '*.local\n')
    const git = Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    expect(git.exitCode).toBe(0)
    const judge = new ChangeJudge({
      workspaceRoot: root,
      armedAt: fsClockNow(root),
      held: () => false,
      uncached: () => new Set([root]),
      fenced: makeFence([root, nested]),
    })
    const inNested = path.join(nested, 'x.local')
    const inRoot = path.join(root, 'y.local')
    await writeFile(inNested, 'n\n')
    judge.pending.set(inNested, 'packages/a/x.local')
    const nestedLabel = judge.judge()
    await writeFile(inRoot, 'r\n')
    judge.pending.set(inRoot, 'y.local')
    expect([nestedLabel, judge.judge()]).toEqual([undefined, 'y.local'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
