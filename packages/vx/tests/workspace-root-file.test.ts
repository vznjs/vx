// The workspace root is the directory holding the nearest `.vx/workspace.*`
// (2026-10-13: "Workspace file is the ultimate"), from the start up
// to the git top-level and never above it ("never go out of git root"). A
// worktree's `.git` is a file and is a top-level; a submodule's points into
// the superproject's `.git/modules`, so the walk goes on to it. Outside git
// the walk reaches `/`, and a file another user owns is refused.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { findWorkspaceRoot } from '../src/workspace/workspace.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'

let shared: string

const file = async (rel: string, body = 'export default {}\n') => {
  await mkdir(path.dirname(path.join(shared, rel)), { recursive: true })
  await writeFile(path.join(shared, rel), body)
}

beforeEach(async () => {
  shared = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-root-file-')))
  // Planted above every case: never read from inside git.
  await file('.vx/workspace.ts')
  await file('repo/package.json', JSON.stringify({ name: 'repo', workspaces: ['pkgs/*'] }))
  await file('repo/pkgs/a/package.json', JSON.stringify({ name: 'a' }))
})

afterEach(async () => {
  await rm(shared, { recursive: true, force: true })
})

const found = (dir: string, uid?: number) =>
  findWorkspaceRoot(path.join(shared, dir), uid).then(
    (r) => path.relative(shared, r) || '.',
    (err: Error & { code?: string }) => err.code ?? err.message,
  )

it('the nearest .vx/workspace.* marks the root, whatever the manifests say', async () => {
  await file('repo/.git/HEAD', 'ref: refs/heads/main\n')
  await file('repo/.vx/workspace.mjs')
  expect([await found('repo/pkgs/a'), await found('repo')]).toEqual(['repo', 'repo'])
  // A member with its own file is a root of its own. (A new start: a run
  // learns each directory's answer once.)
  await file('repo/pkgs/a/src/.vx/workspace.ts')
  expect(await found('repo/pkgs/a/src')).toBe('repo/pkgs/a/src')
})

it('a clone never reads the file planted above its top-level', async () => {
  await file('repo/.git/HEAD', 'ref: refs/heads/main\n')
  expect(await found('repo/pkgs/a')).toBe('VX_E_NO_WORKSPACE')
})

it('a worktree, whose .git is a file, is its own top-level', async () => {
  await file('repo/.git', `gitdir: ${shared}/main/.git/worktrees/repo\n`)
  expect(await found('repo')).toBe('VX_E_NO_WORKSPACE')
})

it("a submodule's worktree, its gitdir under .git/modules, is its own top-level too", async () => {
  await file('repo/.git', `gitdir: ${shared}/super/.git/modules/sub/worktrees/repo\n`)
  await file('super/.git/modules/sub/worktrees/repo/commondir', '../..\n')
  expect(await found('repo')).toBe('VX_E_NO_WORKSPACE')
})

it('a submodule walks on to its superproject, and no further', async () => {
  await file('super/.git/HEAD', 'ref: refs/heads/main\n')
  await file('super/.vx/workspace.ts')
  await file('super/mods/sub/.git', 'gitdir: ../../.git/modules/mods/sub\n')
  expect(await found('super/mods/sub')).toBe('super')
})

it('an embedded repository walks on to the workspace that lists it, unless git ignores it', async () => {
  // `vx lock` lists an embedded repository's configs as the outer
  // workspace's (findProjectConfigs), so a run from inside one must find
  // that workspace: its own `.git` stopped the walk, "no .vx/workspace.ts".
  const git = (cwd: string, ...args: string[]) =>
    expect(Bun.spawnSync(['git', '-C', path.join(shared, cwd), ...args]).exitCode).toBe(0)
  git('.', 'init', '-q', 'outer')
  await file('outer/.vx/workspace.ts')
  await mkdir(path.join(shared, 'outer/vendor/lib/src'), { recursive: true })
  await mkdir(path.join(shared, 'outer/vendor/kept/src'), { recursive: true })
  git('outer/vendor', 'init', '-q', 'lib')
  git('outer/vendor', 'init', '-q', 'kept')
  await file('outer/.gitignore', '/vendor/kept/\n')
  // A worktree inside the checkout is another checkout, its own top-level.
  await file('outer/wt/.git', `gitdir: ${shared}/outer/.git/worktrees/wt\n`)
  expect([
    await found('outer/vendor/lib/src'),
    await found('outer/vendor/kept/src'),
    await found('outer/wt'),
  ]).toEqual(['outer', 'VX_E_NO_WORKSPACE', 'VX_E_NO_WORKSPACE'])
})

// The directory reached `git check-ignore` as a pathspec: `:kept` is
// pathspec magic, so git asked about `kept`, and an ignored repository
// walked on into the workspace that ignores it.
it('an ignored embedded repository named like pathspec magic stops the walk', async () => {
  const git = (cwd: string, ...args: string[]) =>
    expect(Bun.spawnSync(['git', '-C', path.join(shared, cwd), ...args]).exitCode).toBe(0)
  git('.', 'init', '-q', 'outer')
  await file('outer/.vx/workspace.ts')
  await mkdir(path.join(shared, 'outer/:kept/src'), { recursive: true })
  git('outer', 'init', '-q', ':kept')
  await file('outer/.gitignore', '/:kept/\n')
  expect(await found('outer/:kept/src')).toBe('VX_E_NO_WORKSPACE')
})

it('a submodule whose own .git is a directory walks on to its superproject too', async () => {
  // `git submodule add` of a path that is a clone already keeps its `.git`
  // directory: the walk stopped there, and a run inside it found no root
  // while one at the superproject ran its projects.
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: [
        'git',
        '-c',
        'user.email=t@vx.local',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      cwd: path.join(shared, cwd),
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  }
  await file('super/.vx/workspace.ts')
  await file('super/mods/sub/package.json', JSON.stringify({ name: 'sub' }))
  git('super/mods/sub', 'init', '-q')
  git('super/mods/sub', 'add', '-A')
  git('super/mods/sub', 'commit', '-q', '-m', 'sub')
  git('super', 'init', '-q')
  git('super', 'add', '-A')
  git('super', 'commit', '-q', '-m', 'super')
  expect(await found('super/mods/sub')).toBe('super')
  // CONTROL: a repository the superproject does not track is its own top-level.
  await file('super/other/package.json', JSON.stringify({ name: 'other' }))
  git('super/other', 'init', '-q')
  expect(await found('super/other')).toBe('VX_E_NO_WORKSPACE')
})

it('outside git the walk reaches the file above', async () => {
  expect(await found('repo/pkgs/a')).toBe('.')
})

it('a package.json alone is no root', async () => {
  await rm(path.join(shared, '.vx/workspace.ts'))
  expect(await found('repo/pkgs/a')).toBe('VX_E_NO_WORKSPACE')
})

it.skipIf(skipAsRoot('workspace root file owner'))(
  'outside git, a file another user owns above the start is refused; one in the start is yours',
  async () => {
    const other = process.getuid!() + 1
    expect([await found('repo', other), await found('.', other)]).toEqual([
      'VX_E_NO_WORKSPACE',
      '.',
    ])
  },
)

it.skipIf(skipAsRoot('workspace root file link owner'))(
  'outside git, a link another user planted to a root-owned file is refused',
  async () => {
    await rm(path.join(shared, '.vx/workspace.ts'))
    // Root owns it; the link and its `.vx` are this (the planting) user's.
    await symlink('/etc/hosts', path.join(shared, '.vx/workspace.ts'))
    expect(await found('repo', process.getuid!() + 1)).toBe('VX_E_NO_WORKSPACE')
  },
)
