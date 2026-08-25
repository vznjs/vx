import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  affectedProjects,
  defaultAffectedBase,
  workspaceGlobsMatch,
} from '../src/workspace/affected.js'
import {
  computeWorkspaceFingerprint,
  WORKSPACE_FINGERPRINT_FILES,
} from '../src/workspace/fingerprint.js'
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

  describe('a workspace-fingerprint change re-keys every task, so it must select every project', () => {
    // `computeWorkspaceFingerprint` folds the root lockfiles + workspace
    // definition into EVERY task's cache key. Those files sit at the workspace
    // root and belong to no project, so mapping changed paths to project
    // directories selected NOTHING for a change that invalidates the entire
    // cache — `vx run test --affected` after `pnpm update` exited 0 having run
    // no tests. `docs/cli.md` states the invariant these two surfaces owe each
    // other as a principle: "input hashing sees it, so `--affected` must too."

    it('a lockfile edit selects every project', async () => {
      await writeFile(path.join(root, 'bun.lock'), '{"lockfileVersion":1}')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'add lockfile')

      await writeFile(path.join(root, 'bun.lock'), '{"lockfileVersion":1,"packages":{}}')
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
      expect([...out].sort()).toEqual(['a', 'b'])
    })

    it('the fingerprint moving and the selection widening are the SAME condition', async () => {
      // The load-bearing assertion of this block, and the reason it drives the
      // real hash rather than a hardcoded file list: the two surfaces are
      // coupled by an invariant, not by a coincidence of two lists agreeing
      // today. A future lockfile format taught to the fingerprint alone would
      // fail here.
      const before = await computeWorkspaceFingerprint(root)
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      expect(await computeWorkspaceFingerprint(root)).not.toBe(before)

      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
      expect([...out].sort()).toEqual(['a', 'b'])
    })

    it('a vx.workspace change does NOT move the fingerprint', async () => {
      // The deliberate exclusion, pinned so nobody "fixes" it. Everything
      // vx.workspace can declare is placement/storage/observability, never
      // what a command produces — and folding it in would split a laptop
      // (local plugins) from CI (reapi declared) into disjoint cache
      // namespaces, sharing not one entry.
      const before = await computeWorkspaceFingerprint(root)
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        'export default { plugins: [], concurrency: 3 }\n',
      )
      expect(await computeWorkspaceFingerprint(root)).toBe(before)
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        'export default { plugins: [], concurrency: 99, predictive: true }\n',
      )
      expect(await computeWorkspaceFingerprint(root)).toBe(before)
      // CONTROL: the same helper DOES move on a real input change, so the
      // assertion above is about the exclusion and not a dead hash.
      await writeFile(path.join(root, 'bun.lock'), '{"lockfileVersion":9}')
      expect(await computeWorkspaceFingerprint(root)).not.toBe(before)
    })

    it('EVERY file the fingerprint hashes widens selection', async () => {
      // Driven off the exported constant rather than a copy, so adding an entry
      // to the fingerprint cannot leave `--affected` behind. Each name is
      // introduced as a NEW root file: absent → present genuinely moves the
      // fingerprint (the hash skips missing files), and the untracked half of
      // the diff is the path a fresh `bun install` actually takes.
      expect(WORKSPACE_FINGERPRINT_FILES.length).toBeGreaterThan(0)
      for (const name of WORKSPACE_FINGERPRINT_FILES) {
        await writeFile(path.join(root, name), 'x')
        const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
        expect({ name, selected: [...out].sort() }).toEqual({ name, selected: ['a', 'b'] })
        await rm(path.join(root, name))
      }
    })

    it('a DELETED lockfile widens too', async () => {
      // Removing a lockfile changes the fingerprint exactly as editing one
      // does — the hash skips files that are absent. `git diff` reports the
      // deletion, and the widening keys off the path, not off the file still
      // being there.
      await writeFile(path.join(root, 'yarn.lock'), '# yarn lockfile v1\n')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'add yarn.lock')

      await rm(path.join(root, 'yarn.lock'))
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
      expect([...out].sort()).toEqual(['a', 'b'])
    })

    it('an ordinary source change still selects only its own project', async () => {
      // The control that stops "select everything, always" from passing this
      // block. `--affected` exists to run less; a widening that fires on any
      // change would be indistinguishable from deleting the flag.
      await writeFile(path.join(root, 'packages/a/file.txt'), 'a-changed')
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
      expect([...out]).toEqual(['a'])
    })

    it('a lockfile INSIDE a project does not widen — only the root one is hashed', async () => {
      // `computeWorkspaceFingerprint` joins each name to the workspace ROOT, so
      // `packages/a/bun.lock` contributes nothing to any cache key. Matching on
      // basename (or `endsWith`) would rebuild the whole workspace for a file
      // vx never reads — a false positive that silently deletes the flag's
      // value in any repo that vendors a lockfile under a package.
      await writeFile(path.join(root, 'packages/a/bun.lock'), '{"lockfileVersion":1}')
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
      expect([...out]).toEqual(['a'])
    })

    it('a root file that is NOT part of the fingerprint does not widen', async () => {
      // README.md sits beside the lockfiles and belongs to no project, so it
      // must select nothing — the widening keys off the fingerprint list, not
      // off "the path has no project".
      await writeFile(path.join(root, 'README.md'), 'top-level edit')
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
      expect([...out]).toEqual([])
    })

    it('vx-lock.json still never widens, even though it sits at the root', async () => {
      // vx's OWN lockfile is deliberately excluded from cache inputs, so
      // re-running `vx lock` must not rebuild the workspace.
      //
      // The root is a project here ON PURPOSE. Without it the assertion is
      // VACUOUS — vx-lock.json maps to no project directory anyway, so `[]`
      // comes back whether or not any guard exists (mutation-verified: with
      // only a/b in scope, deleting the exclusion filter still passed). With
      // root in scope, deleting the filter yields ['root'] and this fails.
      //
      // What the filter, and ONLY the filter, enforces: adding 'vx-lock.json'
      // to the widening set is inert, because the filter has already removed
      // it from `changed`. That mutation survives and no test can kill it —
      // recorded rather than papered over, so nobody adds a second guard here
      // believing it does something. The exclusion lives in exactly one place.
      const withRoot: ProjectMeta[] = [
        ...projects,
        { name: 'root', dir: root, configPath: null, packageJson: { name: 'root' } },
      ]
      await writeFile(path.join(root, 'vx-lock.json'), '{"v":1}')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'add vx lock')

      await writeFile(path.join(root, 'vx-lock.json'), '{"v":2}')
      const out = await affectedProjects({
        workspaceRoot: root,
        since: 'HEAD',
        projects: withRoot,
      })
      expect([...out]).toEqual([])
    })

    it('widening returns every project, including ones with no changed files at all', async () => {
      // b is untouched and its files are byte-identical, yet its cached
      // artifacts are unreachable after the lockfile moves. Selecting only the
      // "changed" projects would leave b's stale results in place.
      await writeFile(path.join(root, 'packages/a/file.txt'), 'a-changed')
      await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}')
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
      expect([...out].sort()).toEqual(['a', 'b'])
    })

    it('selects nothing when there are no projects to select', async () => {
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: [] })
      expect([...out]).toEqual([])
      await writeFile(path.join(root, 'bun.lock'), '{}')
      expect([
        ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: [] })),
      ]).toEqual([])
    })

    it('widens on a COMMITTED lockfile change, not just a working-tree one', async () => {
      // The CI shape: the merge base is behind, the lockfile bump is already
      // committed, the working tree is clean.
      await writeFile(path.join(root, 'npm-shrinkwrap.json'), '{"lockfileVersion":3}')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'bump deps')
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
      expect([...out].sort()).toEqual(['a', 'b'])
    })
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
    // `-a` instead of a separate `git add .`: file.txt is tracked from the
    // fixture's initial commit, so staging tracked modifications is exactly
    // equivalent here and halves the subprocess count (150 spawns → 100).
    for (let i = 0; i < 50; i++) {
      await writeFile(path.join(root, 'packages/b/file.txt'), `b-v${i}`)
      // ONE retry, and only here. This loop is fixture SETUP — 50 real
      // commits, because `HEAD~50` has to resolve — and on a loaded darwin
      // runner git itself failed mid-loop with
      //   `unable to create temporary file: Invalid argument`
      //   `fatal: failed to write commit object`
      // i.e. the filesystem refused git's object write, with vx not even in
      // the picture. Retrying the SETUP cannot mask a defect in the code
      // under test (that is asserted below, after the loop), and the second
      // failure still throws with git's own message attached.
      try {
        await git(root, 'commit', '-q', '-a', '-m', `b-${i}`)
      } catch {
        await git(root, 'commit', '-q', '-a', '-m', `b-${i}`)
      }
    }
    // Assert the fixture BEFORE the behaviour under test. `HEAD~50` only
    // resolves if all 50 commits landed, and if one silently didn't, the
    // failure surfaces here as "50 commits, got N" rather than downstream as
    // a mystifying "ref HEAD~50 did not resolve" from the code under test.
    const count = Bun.spawnSync({ cmd: ['git', 'rev-list', '--count', 'HEAD'], cwd: root })
    const dec = (b: Uint8Array | null) => (b === null ? '' : new TextDecoder().decode(b).trim())
    // Report the EXIT CODE and stderr, not just stdout. On the fourth CI red of
    // this test the assertion said `Expected: "51" / Received: ""` — an EMPTY
    // stdout, which is a different failure from a wrong count and says nothing
    // about why: the count command was the one step here still using a bare
    // `spawnSync`, so unlike the `git()` helper above it discarded git's exit
    // code and its stderr. That is the gap this fixture was hardened to close
    // and the one place it had not been closed.
    expect({
      count: dec(count.stdout),
      exitCode: count.exitCode,
      stderr: dec(count.stderr),
    }).toEqual({ count: '51', exitCode: 0, stderr: '' })
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD~50', projects })
    expect([...out]).toEqual(['b'])
    // An explicit budget, because the DEFAULT one was never chosen for this
    // test. It performs 100 real git subprocess spawns; at the ~30-50ms a
    // spawn costs on a loaded shared runner that is 3-5s, so bun's 5s default
    // sits right on the line — and this is the THIRD time it has redded CI
    // (see the two prior occurrences described above, both of which pointed
    // away from the cause).
    //
    // Raising a timeout is usually the wrong instinct and this file's own
    // history says so, but the distinction the decision log draws applies
    // here: the watch flake failed by LOSING an event, so more time could
    // never help. This one fails by running long — the last CI failure
    // overshot by 63ms — and the work it does is genuinely several seconds.
    // The bound still catches a real hang, which is what it is for.
  }, 30_000)
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

// --------------------------------------------------------------------------
// workspaceFiles widening
// --------------------------------------------------------------------------
//
// A workspace-root-anchored `cache.inputs.workspaceFiles` glob reaches files
// that belong to NO project, so mapping changed paths to project dirs cannot
// see them: the path resolves to nothing and `--affected` selects nothing for
// a change that re-keyed the task. Answering needs the resolved configs, which
// selection runs before loading — so the resolver is a callback, invoked ONLY
// for paths that belong to no project. These pin that gate, because "the
// common case pays nothing" is a claim a test should hold, not a comment.

describe('workspaceGlobsMatch', () => {
  it('matches a positive glob', () => {
    expect(workspaceGlobsMatch(['shared/**'], 'shared/schema.txt')).toBe(true)
    expect(workspaceGlobsMatch(['shared/**'], 'other/schema.txt')).toBe(false)
  })

  it('honours a leading `!` as an EXCLUDE, like resolveWorkspaceFiles', () => {
    expect(workspaceGlobsMatch(['shared/**', '!shared/ignored/**'], 'shared/a.txt')).toBe(true)
    expect(workspaceGlobsMatch(['shared/**', '!shared/ignored/**'], 'shared/ignored/a.txt')).toBe(
      false,
    )
  })

  it('matches nothing when there is no positive glob', () => {
    // Mirrors the resolver: negation subtracts from what a positive glob
    // matched, so a negation-only list selects the empty set.
    expect(workspaceGlobsMatch(['!shared/**'], 'shared/a.txt')).toBe(false)
    expect(workspaceGlobsMatch([], 'shared/a.txt')).toBe(false)
  })
})

describe('affectedProjects workspaceFiles gate', () => {
  let root: string
  let projects: ProjectMeta[]

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-gate-'))
    await mkdir(path.join(root, 'packages/a'), { recursive: true })
    await mkdir(path.join(root, 'shared'), { recursive: true })
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a')
    await writeFile(path.join(root, 'shared/schema.txt'), 'v1')
    projects = [
      {
        name: 'a',
        dir: path.join(root, 'packages/a'),
        configPath: null,
        packageJson: { name: 'a' },
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

  it('does NOT consult configs when every change is inside a project', async () => {
    // The cost gate. Scoped config loading exists because evaluating configs
    // is the dominant fixed cost of a small run; the widening must not put it
    // back on the common path.
    await writeFile(path.join(root, 'packages/a/file.txt'), 'changed')
    let calls = 0
    const out = await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD',
      projects,
      workspaceGlobOwners: async () => {
        calls++
        return []
      },
    })
    expect([...out]).toEqual(['a'])
    expect(calls).toBe(0)
  })

  it('consults configs with EXACTLY the paths that belong to no project', async () => {
    await writeFile(path.join(root, 'packages/a/file.txt'), 'changed')
    await writeFile(path.join(root, 'shared/schema.txt'), 'v2')
    const seen: string[][] = []
    const out = await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD',
      projects,
      workspaceGlobOwners: async (orphans) => {
        seen.push([...orphans])
        return []
      },
    })
    // The in-project path is answered without asking; only the orphan is.
    expect(seen).toEqual([['shared/schema.txt']])
    expect([...out]).toEqual(['a'])
  })

  it('adds the projects the resolver names', async () => {
    await writeFile(path.join(root, 'shared/schema.txt'), 'v2')
    const out = await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD',
      projects,
      workspaceGlobOwners: async () => ['a'],
    })
    expect([...out]).toEqual(['a'])
  })

  it('selects nothing when the resolver names nobody', async () => {
    // The control: an orphan path alone must not widen. Otherwise every
    // root-level README edit would rebuild the workspace.
    await writeFile(path.join(root, 'shared/schema.txt'), 'v2')
    const out = await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD',
      projects,
      workspaceGlobOwners: async () => [],
    })
    expect([...out]).toEqual([])
  })

  it('omitting the resolver keeps the previous behaviour', async () => {
    // Embedders calling affectedProjects directly are unaffected.
    await writeFile(path.join(root, 'shared/schema.txt'), 'v2')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out]).toEqual([])
  })
})

// The THIRD selection channel: a project whose `vx.config.*` imports a changed
// file. Resolved-config hashing folds those values into the cache key, so
// `affected.ts`'s own rule applies — "input hashing sees it, so `--affected`
// must too". The controls matter more than the pins here: widening selection
// is free for correctness (selection is never hashed) and expensive in CI
// time, so a channel that quietly selects everything would look like a pass.
describe('affectedProjects: config import closures', () => {
  let root: string
  let projects: ProjectMeta[]

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-affimp-'))
    const w = async (rel: string, body: string) => {
      const abs = path.join(root, rel)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, body)
    }
    // Orphan tooling — owned by no project, which is how a shared preset lives.
    await w('shared/flag.mjs', `import './deep.mjs'\nexport const FLAG = 'one'\n`)
    await w('shared/deep.mjs', `export const DEEP = 1\n`)
    await w('shared/a.mjs', `export const A = 1\n`)
    await w('shared/b.mjs', `export const B = 1\n`)
    await w('tools/build-helper.mjs', `export const helper = 1\n`) // imported by NOBODY
    await w('docs/x.md', `# docs\n`)
    await w('node_modules/pkgx/index.mjs', `export const p = 1\n`)

    await w('packages/app/package.json', JSON.stringify({ name: 'app' }))
    await w(
      'packages/app/vx.config.mjs',
      `import 'pkgx'\nimport { FLAG } from '../../shared/flag.mjs'\nimport { A } from '../../shared/a.mjs'\nexport default { tasks: { build: { exec: { command: 'echo ' + FLAG + A } } } }\n`,
    )
    await w('packages/lib/package.json', JSON.stringify({ name: 'lib' }))
    await w('packages/lib/vx.config.mjs', `export default { tasks: {} }\n`)
    await w('packages/lib/preset.mjs', `import './internal.mjs'\nexport const P = 1\n`)
    await w('packages/lib/internal.mjs', `export const I = 1\n`)
    await w('apps/x/package.json', JSON.stringify({ name: 'x' }))
    await w(
      'apps/x/vx.config.mjs',
      `import { P } from '../../packages/lib/preset.mjs'\nexport default { tasks: { build: { exec: { command: 'echo ' + P } } } }\n`,
    )

    const meta = (name: string, dir: string): ProjectMeta => ({
      name,
      dir: path.join(root, dir),
      configPath: path.join(root, dir, 'vx.config.mjs'),
      packageJson: { name },
    })
    projects = [meta('app', 'packages/app'), meta('lib', 'packages/lib'), meta('x', 'apps/x')]

    await git(root, 'init', '-q')
    await git(root, 'config', 'user.email', 'test@vx.local')
    await git(root, 'config', 'user.name', 'vx test')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'initial')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const editThenSelect = async (rel: string, body: string): Promise<string[]> => {
    await writeFile(path.join(root, rel), body)
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    return [...out].sort()
  }

  it('PIN: a config-imported orphan selects the importing project', async () => {
    expect(
      await editThenSelect('shared/flag.mjs', `import './deep.mjs'\nexport const FLAG='two'\n`),
    ).toEqual(['app'])
  })

  it('PIN: transitively, through an orphan that imports another orphan', async () => {
    expect(await editThenSelect('shared/deep.mjs', `export const DEEP = 2\n`)).toEqual(['app'])
  })

  it('PIN: a config importing INTO another project selects both', async () => {
    // The shape the orphan-only reading misses: the target is owned, so it is
    // never an orphan, and no `workspaceFiles` glob is involved.
    expect(
      await editThenSelect(
        'packages/lib/preset.mjs',
        `import './internal.mjs'\nexport const P=2\n`,
      ),
    ).toEqual(['lib', 'x'])
  })

  it('CONTROL: an orphan module NO config imports selects the exact empty set', async () => {
    // The refutation of "any root-level .mjs change affects everything".
    expect(await editThenSelect('tools/build-helper.mjs', `export const helper = 2\n`)).toEqual([])
  })

  it('CONTROL: a sibling of an imported orphan selects nothing', async () => {
    expect(await editThenSelect('shared/b.mjs', `export const B = 2\n`)).toEqual([])
  })

  it('CONTROL: no descent past a project boundary', async () => {
    // `x`'s config imports lib/preset.mjs, which imports lib/internal.mjs.
    // Editing internal.mjs selects lib by CONTAINMENT and must not reach x —
    // the rule that keeps this walk from dragging in a whole source tree.
    expect(await editThenSelect('packages/lib/internal.mjs', `export const I = 2\n`)).toEqual([
      'lib',
    ])
  })

  it('CONTROL: a bare specifier contributes no edge', async () => {
    expect(await editThenSelect('node_modules/pkgx/index.mjs', `export const p = 2\n`)).toEqual([])
  })

  it('CONTROL: a docs-only change still selects nothing', async () => {
    expect(await editThenSelect('docs/x.md', `# docs edited\n`)).toEqual([])
  })
})
