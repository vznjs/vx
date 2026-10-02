// A gitlink whose directory has no `.git`: `rm -rf vendor/lib/.git` to
// vendor a submodule's files, without `git rm --cached`. The index keeps the
// gitlink and `git status` says nothing, and the directory's files were
// never listed, so an edit there was a green hit on the old output (A-61).
// They are listed by a walk and hash by content.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { GitFilesCache, populateGitFilesCache } from '../src/cache/inputs.js'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      ...args,
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-gitlink-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it(
  'a gitlink whose directory lost its .git is listed by a walk, and an edit there misses',
  async () => {
    await write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    git(root, 'init', '-q')
    const a = path.join(root, 'packages/a')
    await write(path.join(a, 'package.json'), JSON.stringify({ name: 'a' }))
    await write(
      path.join(a, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cat vendor/lib/x.txt > dist/out.txt' },
            cache: { inputs: { files: ['**/*'] }, outputs: { files: ['dist/**'] } },
          },
        },
      }`,
    )
    await write(path.join(root, '.gitignore'), '.vx/\ndist/\n')
    const lib = path.join(a, 'vendor/lib')
    await write(path.join(lib, 'x.txt'), 'one')
    git(lib, 'init', '-q')
    git(lib, 'add', '-A')
    git(lib, 'commit', '-qm', 'init')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'init')
    await rm(path.join(lib, '.git'), { recursive: true, force: true })

    const memo = new GitFilesCache()
    await populateGitFilesCache(root, [a], memo)
    expect(memo.get(a)).toEqual(['package.json', 'vendor/lib/x.txt', 'vx.config.mjs'])
    expect(memo.oidsFor(a)?.has(path.join(lib, 'x.txt'))).toBe(false)

    await writeLocalWorkspace(root)
    const run = (): string => {
      const p = Bun.spawnSync({
        cmd: ['bun', CLI, 'run', 'build', '--all'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
      })
      return p.stdout.toString() + p.stderr.toString()
    }
    expect(run()).toMatch(/1 miss/)
    expect(run()).toMatch(/1 up-to-date/)
    await write(path.join(lib, 'x.txt'), 'two')
    expect(run()).toMatch(/1 miss/)
    expect(await readFile(path.join(a, 'dist/out.txt'), 'utf8')).toBe('two')
  },
  TIMEOUT,
)
