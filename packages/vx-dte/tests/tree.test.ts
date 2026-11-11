// The run's snapshot of its tracked files (src/tree.ts).

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { snapshot, unfilter, untrackedWorkspace } from '../src/tree.ts'

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

// `git add -u` passes over an entry flagged assume-unchanged or
// skip-worktree (a sparse checkout sets it), so the snapshot kept HEAD's
// blob while core's key hashed the file on disk: a worker built HEAD's
// bytes and saved them under the edited file's key, a stale hit.
it('snapshots a flagged file as it is on disk, and leaves the flags be', async () => {
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
    for (const f of ['a', 's', 'gone']) await writeFile(path.join(repo, f), 'old\n')
    git('add', '.')
    git('commit', '-qm', 'a')
    git('update-index', '--assume-unchanged', 'a')
    git('update-index', '--skip-worktree', 's', 'gone')
    await writeFile(path.join(repo, 'a'), 'new a\n')
    await writeFile(path.join(repo, 's'), 'new s\n')
    // A sparse checkout leaves its skip-worktree files off disk: they are
    // the index's, not deleted.
    await rm(path.join(repo, 'gone'))
    const { tree } = await snapshot(repo)
    const blob = (f: string) => git('cat-file', 'blob', `${tree}:${f}`).stdout.toString()
    expect([blob('a'), blob('s'), blob('gone')]).toEqual(['new a\n', 'new s\n', 'old\n'])
    expect(git('ls-files', '-v').stdout.toString()).toBe('h a\nS gone\nS s\n')
    // A sparse checkout's patterns keep `add` off a file outside them, and
    // its index reads unflag that file in memory only.
    await mkdir(path.join(repo, 'in'))
    await mkdir(path.join(repo, 'out'))
    for (const f of ['in/f', 'out/f', 'out/gone']) await writeFile(path.join(repo, f), 'old\n')
    git('add', '.')
    git('commit', '-qm', 'b')
    git('sparse-checkout', 'set', 'in')
    await mkdir(path.join(repo, 'out'))
    await writeFile(path.join(repo, 'out/f'), 'new\n')
    const sparse = (await snapshot(repo)).tree
    const at = (f: string) => git('cat-file', 'blob', `${sparse}:${f}`).stdout.toString()
    expect([at('out/f'), at('out/gone')]).toEqual(['new\n', 'old\n'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// A worker reads the workspace config from the run's tree: one untracked
// is not there, and every worker failed `unknown command: dte`, started
// again three times, before a task said why.
it('names an untracked workspace config, the one core loads', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-tree-'))
  try {
    const git = (...a: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], {
        cwd: repo,
        stdout: 'pipe',
        stderr: 'ignore',
      })
    git('init', '-q')
    const ws = path.join(repo, 'ws')
    await mkdir(path.join(ws, '.vx'), { recursive: true })
    await writeFile(path.join(ws, '.vx/workspace.mjs'), 'export default {}\n')
    await writeFile(path.join(ws, 'f'), 'f\n')
    git('add', 'ws/f')
    git('commit', '-qm', 'a')
    expect(await untrackedWorkspace(ws, (await snapshot(ws)).tree)).toBe('.vx/workspace.mjs')
    git('add', '-A')
    expect(await untrackedWorkspace(ws, (await snapshot(ws)).tree)).toBeUndefined()
    // A .ts beside it is the one core loads.
    await writeFile(path.join(ws, '.vx/workspace.ts'), 'export default {}\n')
    expect(await untrackedWorkspace(ws, (await snapshot(ws)).tree)).toBe('.vx/workspace.ts')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// A hook in a linked worktree exports its gitdir as GIT_DIR and no
// GIT_WORK_TREE, and git took the cwd, a workspace in a subdirectory, for
// the checkout's top: the snapshot's tree held no `.vx/workspace.mjs` at
// the workspace's place, and the run was refused, the config "untracked".
it('snapshots a linked worktree’s subdirectory workspace under its hook’s GIT_DIR', async () => {
  const { repo, git } = await repository()
  const wt = `${repo}-wt`
  const saved = process.env['GIT_DIR']
  try {
    await mkdir(path.join(repo, 'ws/.vx'), { recursive: true })
    await writeFile(path.join(repo, 'ws/.vx/workspace.mjs'), 'export default {}\n')
    git('add', '-A')
    git('commit', '-qm', 'a')
    git('worktree', 'add', '-q', '--detach', wt)
    const ws = path.join(wt, 'ws')
    const head = git('-C', wt, 'rev-parse', 'HEAD^{tree}')
    process.env['GIT_DIR'] = path.join(repo, '.git/worktrees', path.basename(wt))
    const { tree } = await snapshot(ws)
    expect(tree).toBe(head)
    expect(await untrackedWorkspace(ws, tree)).toBeUndefined()
  } finally {
    if (saved === undefined) delete process.env['GIT_DIR']
    else process.env['GIT_DIR'] = saved
    await rm(wt, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

/** A fresh repository, and git run in it with an identity: its stdout, trimmed. */
async function repository(): Promise<{ repo: string; git: (...a: string[]) => string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-tree-'))
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
      .stdout.toString()
      .trim()
  git('init', '-q')
  return { repo, git }
}

// Under core.fileMode=false (WSL's DrvFs) `add -u` staged no `chmod +x`,
// which core keys from an lstat: workers checked the file out 644 and
// saved what it built under the key of its 755 (2026-11-08).
it('snapshots an executable bit core.fileMode=false hides from git', async () => {
  const { repo, git } = await repository()
  try {
    await writeFile(path.join(repo, 's.sh'), '#!/bin/sh\n')
    git('add', 's.sh')
    git('commit', '-qm', 'a')
    git('config', 'core.fileMode', 'false')
    await chmod(path.join(repo, 's.sh'), 0o755)
    const { tree } = await snapshot(repo)
    expect(git('ls-tree', tree, 's.sh')).toStartWith('100755 ')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// A `.gitattributes` committed after the file: the run's disk kept LF,
// which its key read, and a worktree checked it out CRLF, whose output
// was saved under that key, a stale hit (2026-11-08).
it('writes back as its blob a file a git filter checked out otherwise', async () => {
  const { repo, git } = await repository()
  try {
    await writeFile(path.join(repo, 't.txt'), 'a\nb\n')
    await writeFile(path.join(repo, 'u.txt'), 'a\nb\n')
    git('add', '.')
    git('commit', '-qm', 'a')
    expect(await unfilter(repo)).toEqual([])
    await writeFile(path.join(repo, '.gitattributes'), 't.txt text eol=crlf\n')
    git('add', '.gitattributes')
    git('commit', '-qm', 'crlf')
    await rm(path.join(repo, 't.txt'))
    git('checkout', 't.txt')
    expect(await readFile(path.join(repo, 't.txt'), 'utf8')).toBe('a\r\nb\r\n')
    expect(await unfilter(repo)).toEqual(['t.txt'])
    expect(await readFile(path.join(repo, 't.txt'), 'utf8')).toBe('a\nb\n')
    // Its tree is the commit's, as the run's.
    expect((await snapshot(repo)).tree).toBe(git('rev-parse', 'HEAD^{tree}'))
    // core.autocrlf needs no attribute.
    git('config', 'core.autocrlf', 'true')
    await rm(path.join(repo, 'u.txt'))
    git('checkout', 'u.txt')
    expect(await readFile(path.join(repo, 'u.txt'), 'utf8')).toBe('a\r\nb\r\n')
    expect(await unfilter(repo)).toEqual(['u.txt'])
    expect(await readFile(path.join(repo, 'u.txt'), 'utf8')).toBe('a\nb\n')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
