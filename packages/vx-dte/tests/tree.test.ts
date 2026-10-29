// The run's snapshot of its tracked files (src/tree.ts).

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { snapshot } from '../src/tree.ts'

// Mid-merge, `git stash create` refuses the unmerged index, and the run
// took HEAD for its tree: workers ran HEAD's files under keys of the
// working tree's, and saved them there, a stale hit for the next run.
// Staged from the working tree into a copy of the index, the unmerged
// file is snapshot as it is on disk.
it('snapshots a mid-merge tree as it is on disk, not HEAD in its place', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-tree-'))
  try {
    const git = (...a: string[]) =>
      Bun.spawnSync(
        [
          'git',
          '-c',
          'user.email=t@vx.local',
          '-c',
          'user.name=t',
          '-c',
          'commit.gpgsign=false',
          ...a,
        ],
        { cwd: repo, stdout: 'pipe', stderr: 'ignore' },
      )
    git('init', '-q', '-b', 'main')
    await writeFile(path.join(repo, 'f'), 'a\n')
    git('add', 'f')
    git('commit', '-qm', 'a')
    git('checkout', '-qb', 'x')
    await writeFile(path.join(repo, 'f'), 'b\n')
    git('commit', '-qam', 'b')
    git('checkout', '-q', 'main')
    await writeFile(path.join(repo, 'f'), 'c\n')
    git('commit', '-qam', 'c')
    git('merge', 'x')
    await writeFile(path.join(repo, 'f'), 'resolved\n')
    const { commit, tree } = await snapshot(repo)
    expect(commit).not.toBe(git('rev-parse', 'HEAD').stdout.toString().trim())
    expect(git('cat-file', 'blob', `${tree}:f`).stdout.toString()).toBe('resolved\n')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

it('takes HEAD when nothing changed, and no commit as none', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-tree-'))
  try {
    const git = (...a: string[]) =>
      Bun.spawnSync(
        [
          'git',
          '-c',
          'user.email=t@vx.local',
          '-c',
          'user.name=t',
          '-c',
          'commit.gpgsign=false',
          ...a,
        ],
        { cwd: repo, stdout: 'pipe', stderr: 'ignore' },
      )
    git('init', '-q')
    expect(await snapshot(repo)).toEqual({ commit: '', tree: '' })
    await writeFile(path.join(repo, 'f'), 'a\n')
    git('add', 'f')
    git('commit', '-qm', 'a')
    const head = git('rev-parse', 'HEAD').stdout.toString().trim()
    expect((await snapshot(repo)).commit).toBe(head)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
