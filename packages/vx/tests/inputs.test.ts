// Unit tests for `src/cache/inputs.ts` — glob resolution + project
// boundary enforcement + the `cleanOutputs` data-deletion contract.
//
// Output cleaning is the highest-stakes function in the codebase
// (it deletes files). These tests pin every boundary rule so a
// regression here can't quietly start eating user files.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'

// Fixture hooks git-init real repos; under load (full suite after a
// warm day of runs) the default 5s hook timeout flakes. File-scoped.
setDefaultTimeout(30_000)
import {
  cleanOutputs,
  GitFilesCache,
  populateGitFilesCache,
  resolveInputs,
  resolveOutputs,
} from '../src/cache/inputs.js'

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

  function gitInit(cwd: string): void {
    const run = (...args: string[]): void => {
      const p = Bun.spawnSync({
        cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (p.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
      }
    }
    run('init', '-q')
    run('config', 'user.email', 'test@vx.local')
    run('config', 'user.name', 'vx test')
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-in-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
    // vx requires git for input enumeration — give every fixture a
    // quiet repo so the call to `git ls-files` succeeds.
    gitInit(root)
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

  it('vx-lock.json never enters the input set (project + workspace globs)', async () => {
    await write(path.join(projectDir, 'src', 'index.ts'), 'src')
    await write(path.join(projectDir, 'vx-lock.json'), '{}')
    await write(path.join(root, 'vx-lock.json'), '{}')

    const got = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'], workspaceFiles: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    expect(got.files).not.toContain(path.join(projectDir, 'vx-lock.json'))
    expect(got.files).not.toContain(path.join(root, 'vx-lock.json'))
    expect(got.files).toContain(path.join(projectDir, 'src', 'index.ts'))
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

  // (.gitignore-filtering tests live in the "git ls-files path" block
  // below — git applies the cascade for us, so basename and anchored
  // patterns and workspace-root .gitignore all "just work" there.)

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

  it('a bun --compile temp file (.<hash>.bun-build) is always excluded', async () => {
    // `bun build --compile` writes a transient `.<hash>-<n>.bun-build` in cwd.
    // A broad `**/*` compile task must never try to hash it — a CONCURRENT
    // compile is mid-write, so reading it races to EACCES/ENOENT. Force git to
    // track one (leading dot included) and assert ALWAYS_IGNORE still drops it.
    await write(path.join(projectDir, '.18bf7d9ff3ffeffe-00000001.bun-build'))
    await write(path.join(projectDir, 'src', 'index.ts'))
    await git(root, 'add', '-f', 'pkg/.18bf7d9ff3ffeffe-00000001.bun-build')

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
    expect(rels).not.toContain('.18bf7d9ff3ffeffe-00000001.bun-build')
  })
})

describe('resolveInputs — gitFilesCache memoization', () => {
  let workspaceRoot: string
  let projectDir: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-gitmemo-'))
    projectDir = path.join(workspaceRoot, 'pkg')
    await mkdir(projectDir, { recursive: true })
    // Init real git so resolveFiles takes the git-ls-files path.
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: workspaceRoot, stdout: 'ignore' })
    Bun.spawnSync({
      cmd: [
        'git',
        // Disable signing — otherwise the commit inherits a global
        // commit.gpgsign + 1Password/GPG agent and HANGS waiting for
        // approval (30s hook timeout). Test repos never sign.
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgSign=false',
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ],
      cwd: workspaceRoot,
      stdout: 'ignore',
    })
    await writeFile(path.join(projectDir, 'src.ts'), 'const x = 1')
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('populates an empty Map after the first call', async () => {
    const memo = new GitFilesCache()
    await resolveInputs({
      projectDir,
      workspaceRoot,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
      gitFilesCache: memo,
    })
    expect(memo.has(projectDir)).toBe(true)
  })

  it('reuses the cached entry on the second call (no second git spawn)', async () => {
    const memo = new GitFilesCache()
    const first = await resolveInputs({
      projectDir,
      workspaceRoot,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
      gitFilesCache: memo,
    })
    // Manually replace the memo's entry with a sentinel; if the
    // second call uses the memo (skip git spawn), the resolved file
    // set reflects the sentinel — proving cache use.
    memo.set(projectDir, ['from-memo.ts'])
    const second = await resolveInputs({
      projectDir,
      workspaceRoot,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
      gitFilesCache: memo,
    })
    // First call saw the real `src.ts`; second saw only the memo'd entry.
    void first
    const relsSecond = second.files.map((p) => path.relative(projectDir, p))
    expect(relsSecond).toEqual([]) // 'from-memo.ts' doesn't exist on disk → filtered out
  })
})

describe('populateGitFilesCache — single workspace-wide git spawn', () => {
  let workspaceRoot: string

  async function gitCmd(cwd: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(proc.stderr)}`)
    }
  }

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-populate-'))
    await gitCmd(workspaceRoot, 'init', '-q')
    await gitCmd(workspaceRoot, 'config', 'user.email', 'test@vx.local')
    await gitCmd(workspaceRoot, 'config', 'user.name', 'vx test')
    // Three projects, each with a tracked file.
    for (const name of ['a', 'b', 'c']) {
      const dir = path.join(workspaceRoot, 'packages', name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'src.ts'), `export const ${name} = ${name === 'a' ? 1 : 2};\n`)
    }
    await gitCmd(workspaceRoot, 'add', '-A')
    await gitCmd(workspaceRoot, 'commit', '-m', 'init')
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('spawns git 5x concurrently for N projects, never once per project', async () => {
    // The bulk populate uses async Bun.spawn (ls-files + status + a trivial
    // rev-parse + an index-only `ls-files -v` + a three-key `config` read, all
    // concurrent — only the first two scan anything, so the rest never gate
    // wall-clock); the per-project fallback uses
    // spawnSync. Count both so a regression to per-project spawning is caught
    // either way. The guard is CONCURRENCY, not the literal count: the point is
    // O(1) bulk spawns, never O(N) per-project.
    const origSpawnSync = Bun.spawnSync
    const origSpawn = Bun.spawn
    let spawnCount = 0
    const countGit = (args: unknown[]): void => {
      const opt = args[0] as { cmd?: readonly string[] } | undefined
      if (opt && Array.isArray(opt.cmd) && opt.cmd[0] === 'git') spawnCount++
    }
    const bunMut = Bun as unknown as {
      spawnSync: typeof Bun.spawnSync
      spawn: typeof Bun.spawn
    }
    bunMut.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
      countGit(args)
      return origSpawnSync(...args)
    }) as typeof Bun.spawnSync
    bunMut.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      countGit(args)
      return origSpawn(...args)
    }) as typeof Bun.spawn
    try {
      const cache = new GitFilesCache()
      const projectDirs = ['a', 'b', 'c'].map((n) => path.join(workspaceRoot, 'packages', n))
      await populateGitFilesCache(workspaceRoot, projectDirs, cache)
      // One index-only `ls-files -s -v` (tracked list + index OIDs +
      // skip-worktree flags), one `status --porcelain -uall` (dirty set +
      // untracked files — the ONLY worktree walk), one `rev-parse`
      // (repo→workspace path + git-dir), one `config --get-regexp` (the
      // clean-filter gate) — all concurrent, never per-project. `check-attr`
      // is NOT among them: this fixture declares no attributes, and paying
      // for it here would mean paying for it in every plain repo.
      expect(spawnCount).toBe(4)
      // Every project got a non-null entry partitioned from the bulk
      // listing — `src.ts` shows up project-relative.
      for (const dir of projectDirs) {
        expect(cache.get(dir)).toEqual(['src.ts'])
      }
    } finally {
      bunMut.spawnSync = origSpawnSync
      bunMut.spawn = origSpawn
    }
  })

  it('throws a clear UserError when not in a git repo', async () => {
    const nonGit = await mkdtemp(path.join(os.tmpdir(), 'vx-nogit-'))
    try {
      const cache = new GitFilesCache()
      const projectDirs = ['x', 'y'].map((n) => path.join(nonGit, n))
      for (const dir of projectDirs) {
        await mkdir(dir, { recursive: true })
      }
      expect(() => populateGitFilesCache(nonGit, projectDirs, cache)).toThrow(/vx requires git/)
    } finally {
      await rm(nonGit, { recursive: true, force: true })
    }
  })
})

// ─── Glob walk: pathological filesystem layouts ──────────────────────
//
// These pin behaviour for filesystems with broken or cyclic symlinks
// under a project root. The contract: input resolution must NEVER
// crash or hang, regardless of what's on disk. Adapted from Turbo's
// turborepo-globwalk symlink-handling tests.

describe('resolveInputs — symlink edge cases', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-syminput-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(path.join(projectDir, 'src'), { recursive: true })
    await writeFile(path.join(projectDir, 'src', 'a.txt'), 'a')
    // vx requires git for input enumeration.
    const run = (...args: string[]): void => {
      Bun.spawnSync({
        cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
    }
    run('init', '-q')
    run('config', 'user.email', 'test@vx.local')
    run('config', 'user.name', 'vx test')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('does not crash when a broken symlink lives under the project dir', async () => {
    await symlink(
      path.join(projectDir, 'does-not-exist-target'),
      path.join(projectDir, 'src', 'dangling.txt'),
    )
    const resolved = await resolveInputs({
      projectDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    // The walk shouldn't hang or throw. Broken symlinks may or may
    // not appear in the file list — we just pin "doesn't crash".
    expect(Array.isArray(resolved.files)).toBe(true)
  })

  it('does not infinite-loop on a symlink cycle under the project dir', async () => {
    // Create a directory symlink cycle: <projectDir>/loop -> <projectDir>
    // A naive recursive walker that follows symlinks loops forever.
    await symlink(projectDir, path.join(projectDir, 'loop'))
    const resolved = await Promise.race([
      resolveInputs({
        projectDir,
        workspaceRoot: root,
        envSource: {},
        inputs: { files: ['src/**'] },
        ownOutputs: [],
        nestedProjectDirs: [],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('symlink cycle caused hang')), 5_000),
      ),
    ])
    expect(Array.isArray(resolved.files)).toBe(true)
  })
})

describe('resolveInputs — runtime values', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-runtime-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function args(inputs: Partial<import('../src/config.js').CacheInputs>) {
    return {
      projectDir,
      workspaceRoot: root,
      envSource: {} as NodeJS.ProcessEnv,
      inputs: { files: [], ...inputs } as import('../src/config.js').CacheInputs,
      ownOutputs: [],
      nestedProjectDirs: [],
    }
  }

  it('folds trimmed stdout of a runtime command', async () => {
    const r = await resolveInputs(args({ runtime: ['echo hello'] }))
    expect(r.runtimeValues).toEqual([['echo hello', 'hello']])
  })

  it('combines stdout and stderr, trimmed', async () => {
    const r = await resolveInputs(args({ runtime: ['sh -c "echo out; echo err 1>&2"'] }))
    expect(r.runtimeValues[0]![1]).toContain('out')
    expect(r.runtimeValues[0]![1]).toContain('err')
  })

  it('sorts runtime pairs by command for deterministic folding', async () => {
    const r = await resolveInputs(args({ runtime: ['echo b', 'echo a'] }))
    expect(r.runtimeValues.map(([c]) => c)).toEqual(['echo a', 'echo b'])
  })

  // `pwd` resolves the macOS /var → /private/var symlink, so compare
  // against the realpath of the expected cwd, not the mkdtemp path.
  it('resolves workspaceRuntime at the workspace root', async () => {
    const r = await resolveInputs(args({ workspaceRuntime: ['pwd'] }))
    expect(r.workspaceRuntimeValues[0]![1]).toBe(await realpath(root))
  })

  it('resolves runtime in the project dir', async () => {
    const r = await resolveInputs(args({ runtime: ['pwd'] }))
    expect(r.runtimeValues[0]![1]).toBe(await realpath(projectDir))
  })

  it('throws UserError naming the command on non-zero exit', async () => {
    await expect(
      resolveInputs(args({ runtime: ['sh -c "echo boom 1>&2; exit 3"'] })),
    ).rejects.toThrow(/runtime command exited 3: sh -c "echo boom 1>&2; exit 3"/)
  })

  it('empty fields produce empty arrays', async () => {
    const r = await resolveInputs(args({}))
    expect(r.runtimeValues).toEqual([])
    expect(r.workspaceRuntimeValues).toEqual([])
  })

  it('dedups by (projectDir, command) via the runtimeCache memo (runs once)', async () => {
    const runtimeCache = new Map<string, Promise<string>>()
    // A command with a side effect: append to a counter file, echo its length.
    const counter = path.join(root, 'count')
    const cmd = `sh -c 'printf x >> ${counter}; wc -c < ${counter}'`
    await resolveInputs({ ...args({ runtime: [cmd] }), runtimeCache })
    await resolveInputs({ ...args({ runtime: [cmd] }), runtimeCache })
    const bytes = await readFile(counter, 'utf8')
    expect(bytes.length).toBe(1) // ran exactly once despite two resolveInputs calls
  })

  it('global dedup for workspaceRuntime: two projects, one spawn', async () => {
    const workspaceRuntimeCache = new Map<string, Promise<string>>()
    const counter = path.join(root, 'wscount')
    const cmd = `sh -c 'printf x >> ${counter}; echo ok'`
    const projectB = path.join(root, 'pkgB')
    await mkdir(projectB, { recursive: true })
    await resolveInputs({ ...args({ workspaceRuntime: [cmd] }), workspaceRuntimeCache })
    await resolveInputs({
      ...args({ workspaceRuntime: [cmd] }),
      projectDir: projectB,
      workspaceRuntimeCache,
    })
    const bytes = await readFile(counter, 'utf8')
    expect(bytes.length).toBe(1)
  })
})
