import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { affectedProjects, defaultAffectedBase } from '../src/workspace/affected.js'
import type { ProjectMeta } from '../src/workspace/workspace.js'

async function git(cwd: string, ...args: string[]): Promise<void> {
  // -c commit.gpgsign=false defends against environments (CI sandboxes,
  // signing proxies) that globally enforce commit signing and would
  // reject our throwaway fixture commits.
  const proc = Bun.spawn({
    cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Drain BOTH streams and report both: git sends its most useful failure
  // messages to stdout, not stderr — `git commit` with nothing staged exits 1
  // saying "nothing to commit" on stdout and writes NOTHING to stderr, so a
  // stderr-only error reads as a blank `exited 1: ` and explains nothing.
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) {
    const detail = [stderr.trim(), stdout.trim()].filter((s) => s.length > 0).join(' | ')
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) exited ${exit}: ${detail}`)
  }
}

describe('affectedProjects', () => {
  let root: string
  let projects: ProjectMeta[]

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-'))
    await mkdir(path.join(root, 'packages/a'), { recursive: true })
    await mkdir(path.join(root, 'packages/b'), { recursive: true })
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-initial')
    await writeFile(path.join(root, 'packages/b/file.txt'), 'b-initial')
    projects = [
      {
        name: 'a',
        dir: path.join(root, 'packages/a'),
        configPath: null,
        packageJson: { name: 'a' },
      },
      {
        name: 'b',
        dir: path.join(root, 'packages/b'),
        configPath: null,
        packageJson: { name: 'b' },
      },
    ]

    await git(root, 'init', '-q')
    await git(root, 'config', 'user.email', 'test@vx.local')
    await git(root, 'config', 'user.name', 'vx test')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'initial')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns empty when nothing changed since HEAD', async () => {
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual([])
  })

  it('selects only projects whose files changed since HEAD (working tree)', async () => {
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-changed')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual(['a'])
  })

  it('selects multiple projects when changes span them', async () => {
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-changed')
    await writeFile(path.join(root, 'packages/b/file.txt'), 'b-changed')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out].sort()).toEqual(['a', 'b'])
  })

  it('returns commits-since-base when comparing against an earlier ref', async () => {
    // Commit a change to a, then ask for changes since the first commit.
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-rev2')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'rev2')

    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
    expect([...out]).toEqual(['a'])
  })

  it('throws UserError when the ref does not resolve', async () => {
    expect(
      affectedProjects({ workspaceRoot: root, since: 'no-such-branch', projects }),
    ).rejects.toThrow(/did not resolve/)
  })

  it('reports a git failure as a git failure, not as a missing ref', async () => {
    // `git rev-parse --verify --quiet` exits 1 for an absent ref but 128 when
    // git cannot operate here at all. Blaming the ref for the second sends the
    // user hunting for a branch name while the real fault is the repository.
    const bare = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-norepo-'))
    try {
      const err = await affectedProjects({
        workspaceRoot: bare,
        since: 'main',
        projects: [],
      }).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err?.message).toMatch(/not a git repository/i)
      expect(err?.message).not.toMatch(/did not resolve/)
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('ignores changes outside any project directory', async () => {
    await writeFile(path.join(root, 'README.md'), 'top-level edit')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual([])
  })

  it('a vx-lock.json change never marks a project affected, even the root project', async () => {
    // The root is a project here, so a root-level file edit WOULD map to
    // it — proving the exclusion is the lock filter, not "root isn't a
    // project". A README edit at root still marks it; vx-lock.json never.
    const withRoot: ProjectMeta[] = [
      ...projects,
      { name: 'root', dir: root, configPath: null, packageJson: { name: 'root' } },
    ]
    // Commit both root files so `git diff` (tracked changes only) can see
    // edits to them.
    await writeFile(path.join(root, 'vx-lock.json'), '{"v":1}')
    await writeFile(path.join(root, 'README.md'), 'v1')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'add lock + readme')

    // Editing only the lock → nothing affected.
    await writeFile(path.join(root, 'vx-lock.json'), '{"v":2}')
    expect([
      ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: withRoot })),
    ]).toEqual([])

    // Control: editing another root file DOES mark root (proving the
    // exclusion is the lock filter, not that root files are ignored).
    await writeFile(path.join(root, 'README.md'), 'v2')
    expect([
      ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: withRoot })),
    ]).toEqual(['root'])
  })

  it('staged-only changes are selected (working-tree diff includes the index)', async () => {
    // `git diff --name-only <since>` compares <since> to working tree,
    // which includes staged + unstaged. A `git add`-then-no-commit
    // workflow should still surface the change.
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-staged')
    await git(root, 'add', '.')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual(['a'])
  })

  it('respects the nested-project boundary (file in inner project does not select parent)', async () => {
    // If two projects are stacked (a parent and a nested child), a
    // change inside the child should select the child (which has the
    // longer dir path), not the parent. The implementation sorts
    // projects by dir-length descending to honor this.
    await mkdir(path.join(root, 'packages/a/inner'), { recursive: true })
    await writeFile(path.join(root, 'packages/a/inner/file.txt'), 'inner-initial')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'add inner')
    const nestedProjects: ProjectMeta[] = [
      ...projects,
      {
        name: 'inner',
        dir: path.join(root, 'packages/a/inner'),
        configPath: null,
        packageJson: { name: 'inner' },
      },
    ]
    await writeFile(path.join(root, 'packages/a/inner/file.txt'), 'inner-changed')
    const out = await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD',
      projects: nestedProjects,
    })
    expect([...out]).toEqual(['inner'])
  })

  it('selects via committed-only history (no working-tree changes)', async () => {
    // Compare to HEAD~1; the change is committed; working tree clean.
    await writeFile(path.join(root, 'packages/b/file.txt'), 'b-committed')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'commit-b')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
    expect([...out]).toEqual(['b'])
  })

  it('selects the project that owned a deleted file', async () => {
    // File deleted in project a since HEAD: a should still be flagged
    // as affected — the deletion is a real change to a's input set.
    await rm(path.join(root, 'packages/a/file.txt'))
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual(['a'])
  })

  it('selects BOTH source and destination project on cross-project rename', async () => {
    // `git mv packages/a/file.txt packages/b/file-from-a.txt`
    // surfaces as two paths in the diff: one under a (deleted) and
    // one under b (added). Both projects are affected — a lost an
    // input, b gained one. Pinning this behavior catches the bug
    // where rename detection collapses to the destination only.
    await git(root, 'mv', 'packages/a/file.txt', 'packages/b/file-from-a.txt')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out].sort()).toEqual(['a', 'b'])
  })

  it('selects the project on a same-project rename (input set changed)', async () => {
    await git(root, 'mv', 'packages/a/file.txt', 'packages/a/renamed.txt')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual(['a'])
  })

  it('selects the project on a working-tree delete (uncommitted)', async () => {
    // Same as committed-delete but the deletion lives only in the
    // working tree. Should still flag — diff-from-HEAD sees the
    // working tree state.
    await rm(path.join(root, 'packages/b/file.txt'))
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual(['b'])
  })

  it('selects a project whose changed file has a non-ASCII name', async () => {
    // Without `-z`, git C-quotes and octal-escapes such paths, so the parsed
    // string resolves to no project — while the cache-input enumeration (which
    // DOES use -z) sees the real name and re-keys the task. The two surfaces
    // must agree about what changed.
    await writeFile(path.join(root, 'packages/a/café.ts'), 'v1')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual(['a'])
  })

  it('selects a project whose changed file name contains a quote or backslash', async () => {
    await writeFile(path.join(root, 'packages/b/we"ird\\name.ts'), 'v1')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual(['b'])
  })

  it('selects a project whose only change is an untracked file', async () => {
    // `git diff` never reports untracked-but-not-ignored files, yet input
    // enumeration (`git ls-files --others --exclude-standard`) does — so a new
    // source file changes the cache key while --affected saw nothing.
    await writeFile(path.join(root, 'packages/a/new-source.ts'), 'export const x = 1')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual(['a'])
  })

  it('ignores untracked files that git excludes', async () => {
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'gitignore')
    await mkdir(path.join(root, 'packages/a/ignored'), { recursive: true })
    await writeFile(path.join(root, 'packages/a/ignored/blob.bin'), 'junk')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual([])
  })

  it('handles many commits in the base..HEAD range without recursion limits', async () => {
    // Defensive test against git invocations that buffer / recurse
    // unbounded. Make ~50 commits in project b, ask affected since
    // the initial commit. We expect b alone, no crash.
    //
    // State the fixture's own precondition first. This test has twice failed
    // in CI in a way that pointed AWAY from the cause — once as an unresolved
    // `HEAD~50` (fixed by the commit-count assertion below), once as a bare
    // ENOENT on the write in the loop, which reads like a bug in the code
    // under test rather than a fixture that was not there. Neither has ever
    // reproduced locally on a clean tree, so the next occurrence needs to
    // describe itself.
    const fixture = existsSync(path.join(root, 'packages/b'))
      ? 'present'
      : `MISSING — root ${existsSync(root) ? `holds [${readdirSync(root).join(', ')}]` : 'is gone'}`
    expect(fixture).toBe('present')
    for (let i = 0; i < 50; i++) {
      await writeFile(path.join(root, 'packages/b/file.txt'), `b-v${i}`)
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', `b-${i}`)
    }
    // Assert the fixture BEFORE the behaviour under test. `HEAD~50` only
    // resolves if all 50 commits landed, and if one silently didn't, the
    // failure surfaces here as "50 commits, got N" rather than downstream as
    // a mystifying "ref HEAD~50 did not resolve" from the code under test.
    const count = Bun.spawnSync({ cmd: ['git', 'rev-list', '--count', 'HEAD'], cwd: root })
    expect(new TextDecoder().decode(count.stdout).trim()).toBe('51')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD~50', projects })
    expect([...out]).toEqual(['b'])
  })
})

describe('defaultAffectedBase', () => {
  it('falls back to HEAD~1 when origin/HEAD is not set', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-default-'))
    try {
      await git(root, 'init', '-q')
      await git(root, 'config', 'user.email', 'test@vx.local')
      await git(root, 'config', 'user.name', 'vx test')
      await writeFile(path.join(root, 'a'), 'x')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'one')
      expect(await defaultAffectedBase(root)).toBe('HEAD~1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns the remote's HEAD branch (origin/main) when origin/HEAD is set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-symref-'))
    try {
      await git(root, 'init', '-q')
      await git(root, 'config', 'user.email', 'test@vx.local')
      await git(root, 'config', 'user.name', 'vx test')
      await writeFile(path.join(root, 'a'), 'x')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'one')
      // Point origin/HEAD at origin/main (the target need not exist for
      // symbolic-ref); the resolver should short-return it over HEAD~1.
      await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
      expect(await defaultAffectedBase(root)).toBe('origin/main')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
