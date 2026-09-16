// A project inside a submodule or an embedded repository. The workspace
// repository's `git ls-files` holds the nested repository as ONE entry (a
// gitlink, or `dir/` for an untracked one) and none of its files, so the
// project's partition of the workspace-wide enumeration was empty: `cache.inputs
// matched no files`, a key that never moved, and a stale hit under a green run
// after the project's source changed (reproduced 2026-09-16). Such a project
// gets no partition; its own repository's git enumerates it.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GitFilesCache, populateGitFilesCache, resolveInputs } from '../src/cache/inputs.js'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
  }
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
}

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

const CONFIG = `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/x.txt dist/out.txt' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
  },
}`

/**
 * A workspace with three projects: `packages/a` in the workspace repository,
 * `vendor/sub/b` in an embedded repository `git add` took as a gitlink (what a
 * submodule is in the index), and `vendor/nested/c` in an embedded repository
 * left untracked.
 */
async function fixture(root: string): Promise<{ a: string; b: string; c: string }> {
  await write(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'r',
      private: true,
      workspaces: ['packages/*', 'vendor/sub/*', 'vendor/nested/*'],
    }),
  )
  initRepo(root)
  const dirs = {
    a: path.join(root, 'packages/a'),
    b: path.join(root, 'vendor/sub/b'),
    c: path.join(root, 'vendor/nested/c'),
  }
  for (const [name, dir] of Object.entries(dirs)) {
    await write(path.join(dir, 'package.json'), JSON.stringify({ name }))
    await write(path.join(dir, 'vx.config.mjs'), CONFIG)
    await write(path.join(dir, 'src/x.txt'), 'one')
  }
  for (const sub of ['vendor/sub', 'vendor/nested']) {
    initRepo(path.join(root, sub))
    git(path.join(root, sub), 'add', '-A')
    git(path.join(root, sub), 'commit', '-qm', 'init')
  }
  // `git add` of an embedded repository records a gitlink, exactly what a
  // submodule is in the index; `vendor/nested` stays untracked.
  git(root, 'add', 'package.json', 'packages', 'vendor/sub')
  git(root, 'commit', '-qm', 'init')
  return dirs
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-nested-repo-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a project inside a nested repository', () => {
  it(
    'is enumerated by its own repository, whether the workspace holds it as a gitlink or untracked',
    async () => {
      const dirs = await fixture(root)
      const memo = new GitFilesCache()
      await populateGitFilesCache(root, [dirs.a, dirs.b, dirs.c], memo)
      // The workspace repository's project keeps its partition and its OIDs.
      expect(memo.get(dirs.a)).toContain('src/x.txt')
      expect(memo.oidsFor(dirs.a)?.has(path.join(dirs.a, 'src/x.txt'))).toBe(true)
      // The nested ones have no partition here: their listing would be empty.
      expect(memo.has(dirs.b)).toBe(false)
      expect(memo.has(dirs.c)).toBe(false)
      for (const dir of [dirs.b, dirs.c]) {
        const resolved = await resolveInputs({
          projectDir: dir,
          workspaceRoot: root,
          inputs: { files: ['src/**'] },
          ownOutputs: ['dist/**'],
          nestedProjectDirs: [],
          gitFilesCache: memo,
          envSource: {},
        })
        expect(resolved.files).toEqual([path.join(dir, 'src/x.txt')])
      }
    },
    TIMEOUT,
  )

  it(
    'a change to its source is a miss, not a stale hit',
    async () => {
      const dirs = await fixture(root)
      await writeLocalWorkspace(root)
      const run = (): string => {
        const p = Bun.spawnSync({
          cmd: ['bun', CLI, 'run', 'build', '--all'],
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
        })
        return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
      }
      const cold = run()
      expect(cold).not.toContain('matched no files')
      expect(cold).toMatch(/3 miss/)
      for (const dir of Object.values(dirs)) await write(path.join(dir, 'src/x.txt'), 'two')
      const warm = run()
      expect(warm).toMatch(/3 miss/)
      for (const dir of Object.values(dirs)) {
        expect(await readFile(path.join(dir, 'dist/out.txt'), 'utf8')).toBe('two')
      }
    },
    TIMEOUT,
  )
})
