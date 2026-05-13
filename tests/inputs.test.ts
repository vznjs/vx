// Unit tests for `src/cache/inputs.ts` — glob resolution + project
// boundary enforcement + the `cleanOutputs` data-deletion contract.
//
// Output cleaning is the highest-stakes function in the codebase
// (it deletes files). These tests pin every boundary rule so a
// regression here can't quietly start eating user files.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanOutputs, resolveInputs, resolveOutputs } from '../src/cache/inputs.js'

async function write(p: string, content = 'x'): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

describe('cleanOutputs — strict output-ownership contract', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-clean-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('removes files matching declared output globs', async () => {
    await write(path.join(projectDir, 'dist', 'a.js'))
    await write(path.join(projectDir, 'dist', 'b.js'))

    await cleanOutputs({
      projectDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })

    expect(existsSync(path.join(projectDir, 'dist', 'a.js'))).toBe(false)
    expect(existsSync(path.join(projectDir, 'dist', 'b.js'))).toBe(false)
  })

  it('does NOT touch files outside declared output globs (the contract)', async () => {
    // Sources are not declared as output; cleanOutputs must leave them.
    await write(path.join(projectDir, 'src', 'index.ts'), 'source')
    await write(path.join(projectDir, 'dist', 'index.js'), 'built')

    await cleanOutputs({
      projectDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })

    expect(await readFile(path.join(projectDir, 'src', 'index.ts'), 'utf8')).toBe('source')
    expect(existsSync(path.join(projectDir, 'dist', 'index.js'))).toBe(false)
  })

  it('does NOT cross project boundaries even when outputs glob would reach', async () => {
    // Nested project living under this project. If cleanOutputs ever
    // crossed the boundary, the nested project's own `dist/` would
    // be silently nuked. This guard is data-loss class — pin it.
    const nestedDir = path.join(projectDir, 'inner')
    await mkdir(nestedDir, { recursive: true })
    await write(path.join(nestedDir, 'dist', 'inner.js'), 'inner-build')
    await write(path.join(projectDir, 'dist', 'outer.js'), 'outer-build')

    await cleanOutputs({
      projectDir,
      outputs: ['**/*.js'], // would otherwise match inner.js
      nestedProjectDirs: [nestedDir],
    })

    expect(existsSync(path.join(projectDir, 'dist', 'outer.js'))).toBe(false)
    // Nested project's file survives — boundary held.
    expect(await readFile(path.join(nestedDir, 'dist', 'inner.js'), 'utf8')).toBe('inner-build')
  })

  it('is a no-op when outputs array is empty (lint-style tasks)', async () => {
    await write(path.join(projectDir, 'a.js'), 'one')
    await cleanOutputs({ projectDir, outputs: [], nestedProjectDirs: [] })
    expect(await readFile(path.join(projectDir, 'a.js'), 'utf8')).toBe('one')
  })

  it('tolerates ENOENT mid-iteration (overlapping globs both match a file)', async () => {
    // Two glob patterns each match the same path; the first rm wins;
    // the second sees ENOENT. `rm({ force: true })` swallows it.
    await write(path.join(projectDir, 'dist', 'x.js'))
    await cleanOutputs({
      projectDir,
      outputs: ['dist/**', '**/x.js'],
      nestedProjectDirs: [],
    })
    expect(existsSync(path.join(projectDir, 'dist', 'x.js'))).toBe(false)
  })

  it('treats undeclared dist contents as fair game (declared output globs own them)', async () => {
    // If you declare `dist/**` as output but the prior build dropped
    // `dist/old.js` that the current run won't rewrite, cleanOutputs
    // wipes it. That's the documented "output ownership" contract.
    await write(path.join(projectDir, 'dist', 'old.js'), 'stale')

    await cleanOutputs({
      projectDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })

    expect(existsSync(path.join(projectDir, 'dist', 'old.js'))).toBe(false)
  })
})

describe('resolveOutputs', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-out-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns the sorted absolute path list for matched files', async () => {
    await write(path.join(projectDir, 'dist', 'b.js'))
    await write(path.join(projectDir, 'dist', 'a.js'))
    const out = await resolveOutputs({
      projectDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(out).toEqual([
      path.join(projectDir, 'dist', 'a.js'),
      path.join(projectDir, 'dist', 'b.js'),
    ])
  })

  it('does not filter outputs through gitignore (typical dist/ is ignored)', async () => {
    // `dist/` is normally in .gitignore; outputs should still be captured.
    await write(path.join(root, '.gitignore'), 'dist\n')
    await write(path.join(projectDir, 'dist', 'index.js'))

    const out = await resolveOutputs({
      projectDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(out).toEqual([path.join(projectDir, 'dist', 'index.js')])
  })

  it('excludes nested-project files even when the output glob would reach', async () => {
    const nestedDir = path.join(projectDir, 'inner')
    await write(path.join(nestedDir, 'dist', 'inner.js'))
    await write(path.join(projectDir, 'dist', 'outer.js'))

    const out = await resolveOutputs({
      projectDir,
      outputs: ['**/*.js'],
      nestedProjectDirs: [nestedDir],
    })

    expect(out).toEqual([path.join(projectDir, 'dist', 'outer.js')])
  })

  it('returns [] when outputs glob list is empty', async () => {
    const out = await resolveOutputs({
      projectDir,
      outputs: [],
      nestedProjectDirs: [],
    })
    expect(out).toEqual([])
  })
})

describe('resolveInputs', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-in-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('declared outputs are excluded from input resolution (no self-invalidation)', async () => {
    await write(path.join(projectDir, 'src', 'index.ts'), 'src')
    await write(path.join(projectDir, 'dist', 'index.js'), 'built')

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(got.files).toEqual([path.join(projectDir, 'src', 'index.ts')])
  })

  it('always-ignored paths (node_modules, .git, .vx) never enter the input set', async () => {
    await write(path.join(projectDir, 'node_modules', 'dep', 'index.js'))
    await write(path.join(projectDir, '.git', 'HEAD'))
    await write(path.join(projectDir, '.vx', 'cache', 'log'))
    await write(path.join(projectDir, 'src', 'index.ts'))

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files).toEqual([path.join(projectDir, 'src', 'index.ts')])
  })

  it('returns [] for files when inputs.files is empty (no file inputs at all)', async () => {
    await write(path.join(projectDir, 'a.txt'), 'a')
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files).toEqual([])
  })

  it('inputs.env: unset names contribute "" (distinguishable from never-listed)', async () => {
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: { SET_ONE: 'val' },
      inputs: { files: [], env: ['SET_ONE', 'UNSET_TWO'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.envValues).toEqual([
      ['SET_ONE', 'val'],
      ['UNSET_TWO', ''],
    ])
  })

  it('inputs.env names are sorted (caller-order-independent for cache stability)', async () => {
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: { A: '1', B: '2', C: '3' },
      inputs: { files: [], env: ['C', 'A', 'B'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.envValues.map(([n]) => n)).toEqual(['A', 'B', 'C'])
  })

  it('negation in inputs.files strips matched files from the result', async () => {
    await write(path.join(projectDir, 'src', 'keep.ts'))
    await write(path.join(projectDir, 'src', 'skip.test.ts'))
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**', '!**/*.test.ts'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files).toEqual([path.join(projectDir, 'src', 'keep.ts')])
  })

  it('gitignore at the workspace root filters input files', async () => {
    // Pattern is anchored to the workspace root via path.relative, so
    // we name the file by its full workspace-relative path.
    await write(path.join(root, '.gitignore'), 'pkg/src/skip.ts\n')
    await write(path.join(projectDir, 'src', 'keep.ts'))
    await write(path.join(projectDir, 'src', 'skip.ts'))
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((p) => path.relative(projectDir, p))).toContain(
      path.join('src', 'keep.ts'),
    )
    expect(got.files.map((p) => path.relative(projectDir, p))).not.toContain(
      path.join('src', 'skip.ts'),
    )
  })

  it('basename-pattern gitignore at the project root filters matching files', async () => {
    // Basename-only patterns (no slash) match anywhere — same as git.
    // Anchored patterns (`src/skip.ts`) in a project-level gitignore
    // would today be evaluated against the workspace-relative path,
    // not the project-relative one. That's a known limitation; here
    // we just verify the basename case which IS portable.
    await write(path.join(projectDir, '.gitignore'), 'skip.ts\n')
    await write(path.join(projectDir, 'src', 'keep.ts'))
    await write(path.join(projectDir, 'src', 'skip.ts'))
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((p) => path.relative(projectDir, p))).toContain(
      path.join('src', 'keep.ts'),
    )
    expect(got.files.map((p) => path.relative(projectDir, p))).not.toContain(
      path.join('src', 'skip.ts'),
    )
  })

  it('nested-project file paths never enter the parent project inputs', async () => {
    const nestedDir = path.join(projectDir, 'inner')
    await write(path.join(nestedDir, 'src', 'inner.ts'))
    await write(path.join(projectDir, 'src', 'outer.ts'))
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [nestedDir],
    })
    expect(got.files).toEqual([path.join(projectDir, 'src', 'outer.ts')])
  })
})

// v14: file enumeration defers to `git ls-files --cached --others
// --exclude-standard` when the project is inside a git repo, matching
// what Turbo and Nx do. Nested .gitignore files, .git/info/exclude,
// and global excludes are all honored because git applies them.
describe('resolveInputs — git ls-files path (v14)', () => {
  let root: string
  let projectDir: string

  async function git(cwd: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr)
      throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-in-git-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
    await git(root, 'init', '-q')
    await git(root, 'config', 'user.email', 'test@vx.local')
    await git(root, 'config', 'user.name', 'vx test')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('nested .gitignore patterns are correctly anchored (the v13 footgun)', async () => {
    // Pre-v14, a project-level pattern like `src/skip.ts` was anchored
    // to the workspace root, not the project — so it never matched.
    // v14 defers to git, which gets this right.
    await write(path.join(projectDir, '.gitignore'), 'src/skip.ts\n')
    await write(path.join(projectDir, 'src', 'keep.ts'))
    await write(path.join(projectDir, 'src', 'skip.ts'))
    // Need at least one commit for ls-files to behave normally.
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'init')

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    const rels = got.files.map((p) => path.relative(projectDir, p))
    expect(rels).toContain(path.join('src', 'keep.ts'))
    expect(rels).not.toContain(path.join('src', 'skip.ts'))
  })

  it('untracked-but-not-ignored files participate in inputs (no commit required)', async () => {
    // A freshly-added file that hasn't been `git add`ed yet should
    // still enter the hash — that's the `--others --exclude-standard`
    // behavior, and matches user intuition ("I added a file, the
    // cache should reflect it").
    await write(path.join(projectDir, 'src', 'fresh.ts'))
    // Don't `git add`. Don't commit.

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((p) => path.relative(projectDir, p))).toEqual([
      path.join('src', 'fresh.ts'),
    ])
  })

  it('gitignored files are excluded (workspace-root .gitignore)', async () => {
    await write(path.join(root, '.gitignore'), 'pkg/secret.txt\n')
    await write(path.join(projectDir, 'src', 'index.ts'))
    await write(path.join(projectDir, 'secret.txt'), 'shh')

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    const rels = got.files.map((p) => path.relative(projectDir, p))
    expect(rels).toContain(path.join('src', 'index.ts'))
    expect(rels).not.toContain('secret.txt')
  })

  it('global excludes (.git/info/exclude) are honored', async () => {
    // Repo-local equivalent of a global gitignore. The v13 ignore-lib
    // path didn't know about this file at all.
    await write(path.join(root, '.git', 'info', 'exclude'), 'pkg/local-only.tmp\n')
    await write(path.join(projectDir, 'src', 'index.ts'))
    await write(path.join(projectDir, 'local-only.tmp'), 'noise')

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    const rels = got.files.map((p) => path.relative(projectDir, p))
    expect(rels).not.toContain('local-only.tmp')
  })

  it('deleted-but-tracked files are skipped (existsSync guard)', async () => {
    await write(path.join(projectDir, 'src', 'index.ts'))
    await write(path.join(projectDir, 'src', 'deleteme.ts'))
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'init')
    // Delete the file via the FS only. git ls-files --cached still
    // reports it; we must skip silently or the hasher would throw.
    await rm(path.join(projectDir, 'src', 'deleteme.ts'))

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((p) => path.relative(projectDir, p))).toEqual([
      path.join('src', 'index.ts'),
    ])
  })

  it('declared outputs still excluded under the git path', async () => {
    // Even though git would list dist/index.js (untracked, gitignored
    // OR not), declared outputs must never enter inputs. Same guard
    // as the FS-walker path.
    await write(path.join(projectDir, 'src', 'index.ts'))
    await write(path.join(projectDir, 'dist', 'index.js'))

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    const rels = got.files.map((p) => path.relative(projectDir, p))
    expect(rels).toContain(path.join('src', 'index.ts'))
    expect(rels).not.toContain(path.join('dist', 'index.js'))
  })

  it('nested-project boundary still excludes inner-project files under the git path', async () => {
    const inner = path.join(projectDir, 'inner')
    await write(path.join(inner, 'src', 'inner.ts'))
    await write(path.join(projectDir, 'src', 'outer.ts'))

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [inner],
    })
    const rels = got.files.map((p) => path.relative(projectDir, p))
    expect(rels).toContain(path.join('src', 'outer.ts'))
    expect(rels).not.toContain(path.join('inner', 'src', 'inner.ts'))
  })

  it('negation in inputs.files still strips matched files under the git path', async () => {
    await write(path.join(projectDir, 'src', 'keep.ts'))
    await write(path.join(projectDir, 'src', 'skip.test.ts'))
    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**', '!**/*.test.ts'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files.map((p) => path.relative(projectDir, p))).toEqual([
      path.join('src', 'keep.ts'),
    ])
  })

  it('node_modules under a project is always excluded (defense in depth)', async () => {
    // git would already exclude node_modules if it's in .gitignore;
    // we also have ALWAYS_IGNORE as a belt-and-suspenders guard.
    await write(path.join(projectDir, 'node_modules', 'dep', 'index.js'))
    await write(path.join(projectDir, 'src', 'index.ts'))
    // Force git to track node_modules to verify our own filter wins.
    await git(root, 'add', '-f', 'pkg/node_modules/dep/index.js')
    await write(path.join(projectDir, 'src', 'index.ts'))

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    const rels = got.files.map((p) => path.relative(projectDir, p))
    expect(rels).toContain(path.join('src', 'index.ts'))
    expect(rels).not.toContain(path.join('node_modules', 'dep', 'index.js'))
  })
})
