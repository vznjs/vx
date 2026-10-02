// `repoFacts` reads the plain repository off the disk and asks git for
// anything else. Either way it must say what `git rev-parse --show-prefix
// --git-common-dir --show-object-format` says, in each layout a workspace
// sits in.

import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { repoFacts } from '../src/cache/git-inputs.js'

let tmp: string

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-repo-facts-')))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

/** What git says, in `repoFacts`' shape. */
function asked(dir: string): unknown {
  const [prefix = '', commonDir = '', format = ''] = git(
    dir,
    'rev-parse',
    '--show-prefix',
    '--git-common-dir',
    '--show-object-format',
  )
    .split('\n')
    .map((l) => l.trim())
  return { prefix, commonDir, objectFormat: format === 'sha256' ? 'sha256' : 'sha1' }
}

/** `repoFacts` for `dir`, and whether it spawned to answer. */
function facts(dir: string): { facts: unknown; spawned: boolean } {
  const spy = spyOn(Bun, 'spawnSync')
  try {
    return { facts: repoFacts(dir), spawned: spy.mock.calls.length > 0 }
  } finally {
    spy.mockRestore()
  }
}

describe('repoFacts', () => {
  it('reads a plain repository off the disk, at its root and below it', async () => {
    git(tmp, 'init', '-q', 'repo')
    const root = path.join(tmp, 'repo')
    const below = path.join(root, 'packages', 'app')
    await mkdir(below, { recursive: true })
    const want = [asked(root), asked(below)]
    expect([facts(root), facts(below)]).toEqual([
      { facts: want[0], spawned: false },
      { facts: want[1], spawned: false },
    ])
    // CONTROL: the two places differ, so equality is not vacuous.
    expect(want[0]).not.toEqual(want[1])
  })

  it('reads a sha256 repository as sha256', () => {
    git(tmp, 'init', '-q', '--object-format=sha256', 'repo')
    const root = path.join(tmp, 'repo')
    expect(facts(root)).toEqual({ facts: asked(root), spawned: false })
    expect((asked(root) as { objectFormat: string }).objectFormat).toBe('sha256')
  })

  it('reads a root reached through a symlink as git does, from the real path', async () => {
    git(tmp, 'init', '-q', 'repo')
    const below = path.join(tmp, 'repo', 'a')
    await mkdir(below)
    const link = path.join(tmp, 'link')
    await symlink(below, link)
    expect(facts(link)).toEqual({ facts: asked(link), spawned: false })
  })

  it('asks git about a linked worktree, whose .git is a file', async () => {
    git(tmp, 'init', '-q', 'repo')
    const root = path.join(tmp, 'repo')
    git(
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    )
    git(root, 'worktree', 'add', '-q', path.join(tmp, 'wt'))
    const wt = path.join(tmp, 'wt')
    expect(facts(wt)).toEqual({ facts: asked(wt), spawned: true })
  })

  it('asks git when GIT_DIR moves the repository', () => {
    git(tmp, 'init', '-q', 'repo')
    const root = path.join(tmp, 'repo')
    process.env['GIT_DIR'] = path.join(root, '.git')
    try {
      expect(facts(root).spawned).toBe(true)
    } finally {
      delete process.env['GIT_DIR']
    }
  })
})
