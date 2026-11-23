// Repository layouts git supports and the key or `--affected` could
// misread: a sparse index (directory entries), an index with no checksum,
// links checked out as plain files, a bare repository's worktree, and a
// workspace that is itself a submodule. Each pins that an edit misses and
// replays the new bytes, and that the commit is named by `--affected`.

import { mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { git } from './helpers/workspace.js'
import { vxSync } from './helpers/vx.js'

const TIMEOUT = 60_000
const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args).text

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-git-layouts-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** A committed workspace whose `a#build` concatenates `a/src/*`, built once. */
async function workspace(root: string, files: Record<string, string>): Promise<void> {
  await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
  await writeLocalWorkspace(root)
  await Bun.write(path.join(root, 'a/package.json'), '{"name":"a"}')
  await Bun.write(
    path.join(root, 'a/vx.config.mjs'),
    `export default { tasks: { build: {
       exec: { command: 'cat src/* > out.txt' },
       inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
     } } }`,
  )
  for (const [rel, text] of Object.entries(files)) await Bun.write(path.join(root, rel), text)
  await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'initial')
  expect(vx(root, 'lock')).not.toMatch(/✗/)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'lock')
}

/** Builds, hits, then an edit misses with the new bytes and its commit is affected. */
async function editMisses(root: string, file: string, text: string, want: string): Promise<void> {
  vx(root, 'run', 'a#build')
  expect(vx(root, 'run', 'a#build')).toMatch(/a#build[^\n]*up-to-date/)
  await Bun.write(path.join(root, file), text)
  expect(vx(root, 'run', 'a#build')).not.toMatch(/up-to-date/)
  expect(await readFile(path.join(root, 'a/out.txt'), 'utf8')).toBe(want)
  git(root, 'commit', '-q', '-am', 'edit')
  expect(vx(root, 'run', 'a#build')).toMatch(/a#build[^\n]*up-to-date/)
  expect(vx(root, 'show', '--affected=HEAD~1')).toMatch(/^  a +a +1 task$/m)
}

describe('git layouts', () => {
  it(
    'a sparse index, its folded directory outside the cone',
    async () => {
      const root = path.join(tmp, 'w')
      await workspace(root, {
        'a/src/x.txt': 'v1',
        'b/package.json': '{"name":"b"}',
        'b/q.txt': 'q',
      })
      git(root, 'sparse-checkout', 'init', '--cone', '--sparse-index')
      git(root, 'sparse-checkout', 'set', 'a', '.vx')
      expect(git(root, 'ls-files', '--sparse')).toMatch(/^b\/$/m)
      await editMisses(root, 'a/src/x.txt', 'v2', 'v2')
    },
    TIMEOUT,
  )

  it(
    'an index written with no checksum (index.skipHash)',
    async () => {
      const root = path.join(tmp, 'w')
      await workspace(root, { 'a/src/x.txt': 'v1' })
      git(root, 'config', 'index.skipHash', 'true')
      git(root, 'update-index', '--really-refresh')
      await Bun.write(path.join(root, 'a/src/y.txt'), 'y')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'y')
      await editMisses(root, 'a/src/x.txt', 'v2', 'v2y')
    },
    TIMEOUT,
  )

  it(
    'a link checked out as a plain file (core.symlinks=false)',
    async () => {
      const root = path.join(tmp, 'w')
      await workspace(root, { 'a/src/x.txt': 'v1', 'a/t1.txt': 'one' })
      await symlink('../t1.txt', path.join(root, 'a/src/l.txt'))
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'link')
      git(root, 'config', 'core.symlinks', 'false')
      await unlink(path.join(root, 'a/src/l.txt'))
      git(root, 'checkout', '--', 'a/src/l.txt')
      expect(git(root, 'status', '--porcelain', '--', 'a')).toBe('')
      await editMisses(root, 'a/src/l.txt', '../t2.txt', '../t2.txtv1')
    },
    TIMEOUT,
  )

  it(
    "a bare repository's linked worktree",
    async () => {
      const src = path.join(tmp, 'src')
      await workspace(src, { 'a/src/x.txt': 'v1' })
      const bare = path.join(tmp, 'repo.git')
      git(tmp, 'clone', '-q', '--bare', src, bare)
      const root = path.join(bare, 'main')
      git(bare, 'worktree', 'add', '-q', root, 'main')
      await editMisses(root, 'a/src/x.txt', 'v2', 'v2')
    },
    TIMEOUT,
  )

  it(
    'a workspace that is a submodule of another repository',
    async () => {
      const src = path.join(tmp, 'src')
      await workspace(src, { 'a/src/x.txt': 'v1' })
      const outer = path.join(tmp, 'outer')
      await Bun.write(path.join(outer, 'r.txt'), 'r')
      git(outer, 'init', '-q')
      git(outer, 'add', '-A')
      git(outer, 'commit', '-q', '-m', 'outer')
      git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'ws')
      const root = path.join(outer, 'ws')
      await editMisses(root, 'a/src/x.txt', 'v2', 'v2')
    },
    TIMEOUT,
  )
})
