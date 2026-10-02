import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  affectedProjects,
  defaultAffectedBase,
  refIsHead,
  workspaceGlobsMatch,
} from '../src/workspace/affected.js'
import {
  computeWorkspaceFingerprint,
  WORKSPACE_FINGERPRINT_FILES,
} from '../src/workspace/fingerprint.js'
import type { ProjectMeta } from '../src/workspace/workspace.js'
import { listProjects, loadWorkspace } from '../src/workspace/index.js'
import { workspaceGlobOwners } from '../src/cli/select.js'
import { loadCliProjects } from '../src/cli/workspace-config.js'
import { PLUGIN_IMPORT, pluginSource, testPlugin } from './helpers/plugin.js'
import { claimedAffected } from '../src/orchestrator/index.js'
import type { FingerprintContext, VxPlugin } from '../src/index.js'
import { UserError } from '../src/util/index.js'
import { addProject, gitInitCommit, makeWorkspace } from './helpers/workspace.js'
import { startGitEnumeration } from '../src/cache/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

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

  // Item 1079: a member linked in from elsewhere in the tree is indexed by
  // its link, and git reports its files at their real place, which owned
  // no project: an edit there selected nothing.
  it('selects a member linked in from elsewhere in the tree when its real files change', async () => {
    await mkdir(path.join(root, 'ext/c'), { recursive: true })
    await writeFile(path.join(root, 'ext/c/file.txt'), 'c-initial')
    await symlink('../ext/c', path.join(root, 'packages/c'))
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'linked member')
    const withC = [
      ...projects,
      {
        name: 'c',
        dir: path.join(root, 'packages/c'),
        configPath: null,
        packageJson: { name: 'c' },
      },
    ]
    await writeFile(path.join(root, 'ext/c/file.txt'), 'c-changed')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: withC })
    expect([...out]).toEqual(['c'])
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

  it('diffs from the merge base: a base branch that moved on does not select its own changes', async () => {
    // Turbo's `test_affected_merge_base_diverged`: the branch changes `a`,
    // `main` separately changes `b`. Since main, only `a` is this branch's
    // work — a two-dot diff against `main` would select `b` too, and would
    // HIDE `a` if main later landed the same bytes.
    await git(root, 'branch', '-m', 'main')
    await git(root, 'checkout', '-q', '-b', 'feature')
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-on-feature')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'feature: a')
    await git(root, 'checkout', '-q', 'main')
    await writeFile(path.join(root, 'packages/b/file.txt'), 'b-on-main')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'main: b')
    await git(root, 'checkout', '-q', 'feature')

    const out = await affectedProjects({ workspaceRoot: root, since: 'main', projects })
    expect([...out]).toEqual(['a'])
  })

  it('throws UserError when the ref does not resolve', async () => {
    expect(
      affectedProjects({ workspaceRoot: root, since: 'no-such-branch', projects }),
    ).rejects.toThrow(/did not resolve/)
  })

  // The base reaches git as an argument, never a shell — but an option-like
  // value is a real option: `git diff … --output=<path>` writes the diff to
  // <path>. The guard is a check that knows it is a security boundary, not
  // an exit-code side effect of `verifyRef`; the second assertion is the one
  // that survives a refactor of that function.
  it.each(['--output=OUT', '-', '--', '--upload-pack=OUT', ''])(
    'refuses an option-like or empty base (%j) before git sees it',
    async (shape) => {
      const out = path.join(root, 'injected')
      const since = shape.replace('OUT', out)
      await expect(affectedProjects({ workspaceRoot: root, since, projects })).rejects.toThrow(
        /is not a ref/,
      )
      expect(existsSync(out)).toBe(false)
    },
  )

  // A range whose end is not a commit, or starts with "-", is refused
  // before git sees it: the non-repository root proves no spawn ran (git's
  // answer there would be "not a git repository").
  it.each([
    ['..HEAD', 'HEAD..HEAD'],
    ['HEAD~1..', 'HEAD~1..HEAD'],
    ['HEAD~1...--output=x', 'HEAD~1...HEAD'],
  ])('refuses the range %j before git sees it', async (since, shown) => {
    const bare = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-range-'))
    try {
      for (const workspaceRoot of [root, bare]) {
        const err = await affectedProjects({ workspaceRoot, since, projects }).then(
          () => null,
          (e: unknown) => e as Error,
        )
        expect(err).toBeInstanceOf(UserError)
        expect(err?.message).toBe(
          `git ref "${since}" is not a range vx takes: both ends name a commit ("${shown}"), ` +
            'and neither starts with "-".',
        )
      }
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  // Turbo's `--filter=[main...HEAD]` (changes on HEAD since the merge base)
  // and `[main..HEAD]` (since main itself): vx refused both, though an end
  // at HEAD is the working tree vx diffs against.
  it('takes a range ending at HEAD: `...` from the merge base, `..` from the start', async () => {
    await git(root, 'branch', '-m', 'main')
    await git(root, 'checkout', '-q', '-b', 'feature')
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-on-feature')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'feature: a')
    await git(root, 'checkout', '-q', 'main')
    await writeFile(path.join(root, 'packages/b/file.txt'), 'b-on-main')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'main: b')
    await git(root, 'checkout', '-q', 'feature')
    const sel = async (since: string) =>
      [...(await affectedProjects({ workspaceRoot: root, since, projects }))].sort()
    expect(await sel('main...HEAD')).toEqual(['a'])
    expect(await sel('main...feature')).toEqual(['a'])
    expect(await sel('main..HEAD')).toEqual(['a', 'b'])
    // An end elsewhere is a tree vx does not have.
    const err = await affectedProjects({
      workspaceRoot: root,
      since: 'feature...main',
      projects,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message).toBe(
      'git ref "feature...main" ends at "main", not HEAD: vx diffs against the working tree — ' +
        'check out "main" and pass "feature...HEAD" (or "feature").',
    )
  })

  it('CONTROL: the base a range refusal names works on its own', async () => {
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-rev2')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'rev2')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
    expect([...out]).toEqual(['a'])
  })

  it('CONTROL: the injection the guard refuses is real — git honours --output as an option', async () => {
    const out = path.join(root, 'injected')
    const proc = Bun.spawn({
      cmd: ['git', 'diff', '--no-renames', '--name-only', `--output=${out}`],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)
    expect(existsSync(out)).toBe(true)
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

  it('a git diff that FAILS is an error, never an empty change set', async () => {
    // The third "ignores git's exit code" hole of this arc, and the one
    // with the worst blast radius. `gitPaths` throws on a non-zero exit;
    // without that the parse gets empty stdout, so `changed` is EMPTY,
    // every project maps to nothing, and `vx run test --affected` exits
    // 0 having run nothing. Green CI over a broken repository — which is
    // the exact failure `docs/cli.md` states as a principle: "input
    // hashing sees it, so `--affected` must too."
    //
    // Reaching it needs a repo where the ref VERIFIES and the diff does
    // not, or the guard above answers first (the 561 shape). Deleting
    // the commit's tree object is that: `rev-parse --verify HEAD` reads
    // the commit and succeeds, `merge-base HEAD HEAD` succeeds, and
    // `git diff HEAD` exits 128 with `bad tree object` (measured).
    const tree = (await Bun.$`git -C ${root} rev-parse HEAD^{tree}`.text()).trim()
    await rm(path.join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)), { force: true })

    const err = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).not.toBeNull()
    expect(err?.message).toMatch(/git diff failed \(exit 128\)/)
  })

  it('a project inside a nested repository is selected when git reports its repository changed', async () => {
    // The workspace repository sees a submodule or an embedded repository as
    // ONE path — the gitlink `vendor/sub` when its checkout is dirty or moved,
    // `vendor/nested/` while untracked — and none of the files inside, so an
    // edit there selected nothing (2026-09-16). A changed path that is a
    // directory on disk is such a repository, and every project under it
    // changed with it.
    const subC = path.join(root, 'vendor/sub/c')
    await mkdir(subC, { recursive: true })
    await writeFile(path.join(subC, 'file.txt'), 'c-initial')
    await git(path.join(root, 'vendor/sub'), 'init', '-q')
    await git(path.join(root, 'vendor/sub'), 'config', 'user.email', 'test@vx.local')
    await git(path.join(root, 'vendor/sub'), 'config', 'user.name', 'vx test')
    await git(path.join(root, 'vendor/sub'), 'add', '.')
    await git(path.join(root, 'vendor/sub'), 'commit', '-q', '-m', 'c')
    // `git add` of an embedded repository records a gitlink — what a submodule is.
    await git(root, 'add', 'vendor/sub')
    await git(root, 'commit', '-q', '-m', 'gitlink')
    const nested = [
      ...projects,
      { name: 'c', dir: subC, configPath: null, packageJson: { name: 'c' } },
    ]
    // Control: a clean tree selects nothing, and a change beside it only its own project.
    expect([
      ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: nested })),
    ]).toEqual([])
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-changed')
    expect([
      ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: nested })),
    ]).toEqual(['a'])
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-initial')
    // An edit inside the nested repository: git reports `vendor/sub`.
    await writeFile(path.join(subC, 'file.txt'), 'c-changed')
    expect([
      ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: nested })),
    ]).toEqual(['c'])
    // A repository that asks git to hide its submodules (`diff.ignoreSubmodules`,
    // or `submodule.<name>.ignore` in `.gitmodules`) hid the edit, and a
    // committed bump too, while the task's key moved (item 951).
    await git(root, 'config', 'diff.ignoreSubmodules', 'all')
    expect([
      ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: nested })),
    ]).toEqual(['c'])
    await git(root, 'config', '--unset', 'diff.ignoreSubmodules')
    await git(path.join(root, 'vendor/sub'), 'commit', '-qam', 'bump')
    await git(root, 'commit', '-qam', 'bump gitlink')
    await git(root, 'config', 'diff.ignoreSubmodules', 'all')
    expect([
      ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects: nested })),
    ]).toEqual(['c'])
    await git(root, 'config', '--unset', 'diff.ignoreSubmodules')
    await writeFile(path.join(subC, 'file.txt'), 'c-dirty-again')
    // An untracked embedded repository is new work: git reports `vendor/nested/`.
    const nestedD = path.join(root, 'vendor/nested/d')
    await mkdir(nestedD, { recursive: true })
    await writeFile(path.join(nestedD, 'file.txt'), 'd')
    await git(path.join(root, 'vendor/nested'), 'init', '-q')
    const withD = [
      ...nested,
      { name: 'd', dir: nestedD, configPath: null, packageJson: { name: 'd' } },
    ]
    expect(
      [...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: withD }))].sort(),
    ).toEqual(['c', 'd'])
  })

  it('a workspace config edit, or one to a file it imports, selects every project (item 953)', async () => {
    // Its plugins' `project` and `config` stages shape every resolved config,
    // so the edit can re-key any task; it selected nothing (item 953).
    await mkdir(path.join(root, 'tools'), { recursive: true })
    await writeFile(path.join(root, 'tools/gen.mjs'), "export const cmd = 'echo v1'\n")
    await writeFile(path.join(root, 'tools/unrelated.mjs'), 'export {}\n')
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      "import { cmd } from './tools/gen.mjs'\nexport default { plugins: [] }\n",
    )
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'workspace config')
    const all = () =>
      affectedProjects({ workspaceRoot: root, since: 'HEAD', projects }).then((s) => [...s].sort())
    // Control: a root file the workspace config does not import selects nothing.
    await writeFile(path.join(root, 'tools/unrelated.mjs'), 'export const x = 1\n')
    expect(await all()).toEqual([])
    await git(root, 'checkout', '--', 'tools/unrelated.mjs')
    await writeFile(path.join(root, 'tools/gen.mjs'), "export const cmd = 'echo v2'\n")
    expect(await all()).toEqual(['a', 'b'])
    await git(root, 'checkout', '--', 'tools/gen.mjs')
    await writeFile(path.join(root, 'vx.workspace.mjs'), 'export default { plugins: [] }\n')
    expect(await all()).toEqual(['a', 'b'])
  })

  it('a deleted package selects the projects that depend on it (item 959)', async () => {
    // It is no project now: its paths map to nothing and the dependents walk
    // sees today's graph, so `git rm -r` of a dependency selected nothing.
    await mkdir(path.join(root, 'packages/lib'), { recursive: true })
    await writeFile(path.join(root, 'packages/lib/package.json'), JSON.stringify({ name: 'lib' }))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib')
    const withDeps: ProjectMeta[] = [
      { ...projects[0]!, packageJson: { name: 'a', devDependencies: { lib: 'workspace:*' } } },
      projects[1]!,
    ]
    const select = (extra: ProjectMeta[] = []) =>
      affectedProjects({
        workspaceRoot: root,
        since: 'HEAD',
        projects: [...withDeps, ...extra],
      }).then((s) => [...s].sort())
    // Control: an edited manifest is its own project's change only.
    await writeFile(
      path.join(root, 'packages/lib/package.json'),
      JSON.stringify({ name: 'lib', version: '2' }),
    )
    const libNow: ProjectMeta = {
      name: 'lib',
      dir: path.join(root, 'packages/lib'),
      configPath: null,
      packageJson: { name: 'lib', version: '2' },
    }
    expect(await select([libNow])).toEqual(['lib'])
    await rm(path.join(root, 'packages/lib'), { recursive: true })
    expect(await select()).toEqual(['a'])
  })

  it('a new nested project selects the project it took files from (D-1)', async () => {
    // `a`'s inputs stop at every project below it, so a manifest that makes
    // `packages/a/sub` a project re-keys `a` while containment maps the
    // change to `sub` alone.
    await mkdir(path.join(root, 'packages/a/sub'), { recursive: true })
    await writeFile(path.join(root, 'packages/a/sub/data.txt'), 'data')
    await writeFile(path.join(root, 'packages/a/sub/package.json'), JSON.stringify({}))
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'sub')
    const sub: ProjectMeta = {
      name: 'sub',
      dir: path.join(root, 'packages/a/sub'),
      configPath: null,
      packageJson: { name: 'sub' },
    }
    const select = () =>
      affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: [...projects, sub] }).then(
        (s) => [...s].sort(),
      )
    // Control: an edit to a manifest that already named a project.
    await writeFile(path.join(root, 'packages/a/sub/package.json'), JSON.stringify({ name: 'sub' }))
    await git(root, 'commit', '-q', '-am', 'name sub')
    await writeFile(
      path.join(root, 'packages/a/sub/package.json'),
      JSON.stringify({ name: 'sub', version: '2' }),
    )
    expect(await select()).toEqual(['sub'])
    // A nameless manifest at the base was no project, and a missing one neither.
    await git(root, 'checkout', '-q', 'HEAD~1', '--', 'packages/a/sub/package.json')
    await git(root, 'commit', '-q', '-m', 'unname sub')
    await writeFile(path.join(root, 'packages/a/sub/package.json'), JSON.stringify({ name: 'sub' }))
    expect(await select()).toEqual(['a', 'sub'])
    await git(root, 'rm', '-q', '--cached', 'packages/a/sub/package.json')
    await git(root, 'commit', '-q', '-m', 'drop sub manifest')
    expect(await select()).toEqual(['a', 'sub'])
  })

  it('a manifest edit that drops an edge selects the dependent (D-3)', async () => {
    // `a` declares `lib@^1`. A bump to 2.0.0, or a rename, drops the edge:
    // `a` re-keys through its upstream while containment maps the change to
    // `lib` alone and today's graph shows no dependent.
    await mkdir(path.join(root, 'packages/lib'), { recursive: true })
    const lib = (pkg: object) =>
      writeFile(path.join(root, 'packages/lib/package.json'), JSON.stringify(pkg))
    await lib({ name: 'lib', version: '1.0.0' })
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib')
    const select = (libPkg: ProjectMeta['packageJson']) =>
      affectedProjects({
        workspaceRoot: root,
        since: 'HEAD',
        projects: [
          { ...projects[0]!, packageJson: { name: 'a', dependencies: { lib: '^1.0.0' } } },
          projects[1]!,
          ...(libPkg.name === ''
            ? []
            : [
                {
                  name: libPkg.name,
                  dir: path.join(root, 'packages/lib'),
                  configPath: null,
                  packageJson: libPkg,
                },
              ]),
        ],
      }).then((s) => [...s].sort())
    // Control: a bump the range still admits keeps the edge.
    await lib({ name: 'lib', version: '1.1.0' })
    expect(await select({ name: 'lib', version: '1.1.0' })).toEqual(['lib'])
    await lib({ name: 'lib', version: '2.0.0' })
    expect(await select({ name: 'lib', version: '2.0.0' })).toEqual(['a', 'lib'])
    await lib({ name: 'lib2', version: '1.0.0' })
    expect(await select({ name: 'lib2', version: '1.0.0' })).toEqual(['a', 'lib2'])
    // Two manifests in one `git cat-file --batch`: `b` sorts first, so the
    // bump is the second blob read, and a misread offset between blobs read
    // it as absent at the base, where the edge could not drop.
    await writeFile(path.join(root, 'packages/b/package.json'), JSON.stringify({ name: 'b' }))
    await git(root, 'add', 'packages/b/package.json')
    await git(root, 'commit', '-q', '-m', 'b manifest')
    await writeFile(
      path.join(root, 'packages/b/package.json'),
      JSON.stringify({ name: 'b', version: '2.0.0' }),
    )
    await lib({ name: 'lib', version: '2.0.0' })
    expect(await select({ name: 'lib', version: '2.0.0' })).toEqual(['a', 'b', 'lib'])
  })

  // Item 1084 (superseded by D-3): a deleted dependency named by an alias
  // or a path, which no key names.
  for (const [title, spec, edit] of [
    ['a deleted dependency named by an npm alias', { mylib: 'npm:lib@^1.0.0' }, null],
    ['a deleted dependency named by path', { mylib: 'file:../lib' }, null],
  ] as const) {
    it(`${title} selects the project that depended on it`, async () => {
      await mkdir(path.join(root, 'packages/lib'), { recursive: true })
      await writeFile(
        path.join(root, 'packages/lib/package.json'),
        JSON.stringify({ name: 'lib', version: '1.0.0' }),
      )
      await git(root, 'add', '-A')
      await git(root, 'commit', '-q', '-m', 'lib')
      const withDeps: ProjectMeta[] = [
        { ...projects[0]!, packageJson: { name: 'a', dependencies: { ...spec } } },
        projects[1]!,
      ]
      if (edit === null) await rm(path.join(root, 'packages/lib'), { recursive: true })
      else await writeFile(path.join(root, 'packages/lib/package.json'), JSON.stringify(edit))
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: withDeps })
      expect([...out]).toEqual(['a'])
    })
  }

  // Item 1085: a config naming a deleted project in `dependsOn` fails its
  // run ("no such project"), and no package edge leads to it.
  it('a deleted package selects the projects whose tasks name it in dependsOn', async () => {
    await mkdir(path.join(root, 'packages/lib'), { recursive: true })
    await writeFile(path.join(root, 'packages/lib/package.json'), JSON.stringify({ name: 'lib' }))
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib')
    let asked = 0
    const select = () =>
      affectedProjects({
        workspaceRoot: root,
        since: 'HEAD',
        projects,
        taskEdges: async () => {
          asked += 1
          return new Map([['b', ['lib']]])
        },
      }).then((s) => [...s].sort())
    // Control: a change that moves no package's identity never asks.
    await writeFile(path.join(root, 'packages/a/file.txt'), 'a-changed')
    expect(await select()).toEqual(['a'])
    expect(asked).toBe(0)
    await rm(path.join(root, 'packages/lib'), { recursive: true })
    expect(await select()).toEqual(['a', 'b'])
  })

  it('a moved project root selects the dependent its path spec pointed at', async () => {
    // `a` reaches `lib` by `file:../lib`; after `git mv packages/lib
    // packages/core` the spec names no project, so the edge drops while
    // `a`'s own manifest is unchanged: only the base graph sees it.
    await mkdir(path.join(root, 'packages/lib'), { recursive: true })
    await writeFile(path.join(root, 'packages/lib/package.json'), JSON.stringify({ name: 'lib' }))
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib')
    await git(root, 'mv', 'packages/lib', 'packages/core')
    const moved: ProjectMeta[] = [
      { ...projects[0]!, packageJson: { name: 'a', dependencies: { lib: 'file:../lib' } } },
      projects[1]!,
      {
        name: 'lib',
        dir: path.join(root, 'packages/core'),
        configPath: null,
        packageJson: { name: 'lib' },
      },
    ]
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: moved })
    expect([...out].sort()).toEqual(['a', 'lib'])
  })

  it('a root `workspaces` edit selects every project (item 959)', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'root manifest')
    const select = () =>
      affectedProjects({ workspaceRoot: root, since: 'HEAD', projects }).then((s) => [...s].sort())
    // Control: a root manifest edit that leaves `workspaces` alone.
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'], scripts: { x: 'true' } }),
    )
    expect(await select()).toEqual([])
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/a'] }))
    expect(await select()).toEqual(['a', 'b'])
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

  // Nx's sibling-prefix case: a string-prefix owner test would hand
  // `packages/app-e2e/x` to `packages/app` as well (or instead).
  it('a change in a sibling-prefix project dir selects exactly that project', async () => {
    const names = ['app', 'app-e2e', 'app-e2e-utils']
    for (const name of names) {
      await mkdir(path.join(root, 'packages', name), { recursive: true })
      await writeFile(path.join(root, 'packages', name, 'file.txt'), `${name}-initial`)
    }
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'siblings')
    const siblings: ProjectMeta[] = names.map((name) => ({
      name,
      dir: path.join(root, 'packages', name),
      configPath: null,
      packageJson: { name },
    }))
    await writeFile(path.join(root, 'packages/app-e2e/file.txt'), 'app-e2e-changed')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: siblings })
    expect([...out]).toEqual(['app-e2e'])
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

  it("reads the run's walk for untracked files: `git ls-files --others`' set", async () => {
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'gitignore')
    await mkdir(path.join(root, 'packages/a/ignored'), { recursive: true })
    await writeFile(path.join(root, 'packages/a/ignored/blob.bin'), 'junk')
    await writeFile(path.join(root, 'packages/a/new.ts'), 'x')
    await mkdir(path.join(root, 'packages/b/deep/dir'), { recursive: true })
    await writeFile(path.join(root, 'packages/b/deep/dir/y.ts'), 'y')
    await mkdir(path.join(root, 'packages/b/inner'), { recursive: true })
    await git(path.join(root, 'packages/b/inner'), 'init', '-q')
    await writeFile(path.join(root, 'packages/b/inner/z.ts'), 'z')
    const others = Bun.spawnSync({
      cmd: ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
      cwd: root,
    })
      .stdout.toString()
      .split('\0')
      .filter((p) => p !== '')
    const walk = await startGitEnumeration(root, ['.'])
    expect([...walk.untracked!].sort()).toEqual(others.sort())
    expect(others.length).toBe(3)
    const read = (untracked: readonly string[]) =>
      affectedProjects({
        workspaceRoot: root,
        since: 'HEAD',
        projects,
        untracked: async () => untracked,
      })
    expect([...(await read(walk.untracked!))].sort()).toEqual(['a', 'b'])
    // CONTROL: the answer is the walk's, not a spawn of its own.
    expect([...(await read([]))]).toEqual([])
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
        'export default { plugins: [], concurrency: 99 }\n',
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

    // bun.lock names a patch by path, so a patch edit leaves it byte-identical
    // while the fingerprint folds the patch's content: the same condition.
    it('an edit to a patch bun.lock names selects every project', async () => {
      const lock = '{"lockfileVersion":1,"patchedDependencies":{"x@1.0.0":"patches/x@1.0.0.patch"}}'
      await writeFile(path.join(root, 'bun.lock'), lock)
      await mkdir(path.join(root, 'patches'), { recursive: true })
      await writeFile(path.join(root, 'patches/x@1.0.0.patch'), 'v1\n')
      await writeFile(path.join(root, 'patches/other.patch'), 'v1\n')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'patch')

      // Control: a patch file the lockfile does not name moves nothing.
      await writeFile(path.join(root, 'patches/other.patch'), 'v2\n')
      expect([
        ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })),
      ]).toEqual([])
      const before = await computeWorkspaceFingerprint(root)
      await writeFile(path.join(root, 'patches/x@1.0.0.patch'), 'v2\n')
      expect(await computeWorkspaceFingerprint(root)).not.toBe(before)
      const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
      expect([...out].sort()).toEqual(['a', 'b'])
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

    describe('a CLAIMED file asks its plugin instead of widening', () => {
      // `VxPlugin.fingerprint` takes a lockfile out of the digest every key
      // folds, and the plugin folds what the file means per project. So the
      // selection question is the plugin's too: it sees the bytes at the base
      // ref and in the working tree, and names the projects — only "cannot
      // tell" (undefined) widens as an unclaimed file does.
      type Change = { file: string; before: Uint8Array | null; after: Uint8Array | null }
      const asked: Change[] = []
      const claimOf = (
        answer: readonly string[] | undefined,
        loaded = { count: 0 },
      ): (() => Promise<{
        files: ReadonlySet<string>
        affected: (c: Change) => Promise<ReadonlySet<string> | undefined>
      }>) => {
        return async () => {
          loaded.count += 1
          return {
            files: new Set(['pnpm-lock.yaml']),
            affected: async (c: Change) => {
              asked.push(c)
              return answer === undefined ? undefined : new Set(answer)
            },
          }
        }
      }
      beforeEach(() => asked.splice(0))

      it("selects the plugin's projects, given the base-ref and working-tree bytes", async () => {
        await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nv1\n')
        await git(root, 'add', '.')
        await git(root, 'commit', '-q', '-m', 'add lockfile')
        await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nv2\n')

        const out = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: claimOf(['b']),
        })
        expect([...out]).toEqual(['b'])
        expect(asked).toHaveLength(1)
        expect(asked[0]!.file).toBe('pnpm-lock.yaml')
        expect(new TextDecoder().decode(asked[0]!.before!)).toBe('lockfileVersion: 9\nv1\n')
        expect(new TextDecoder().decode(asked[0]!.after!)).toBe('lockfileVersion: 9\nv2\n')
        // CONTROL: the same edit with no claim still selects everything.
        const bare = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
        expect([...bare].sort()).toEqual(['a', 'b'])
      })

      it('unions the answer with the path-owned projects', async () => {
        await writeFile(path.join(root, 'pnpm-lock.yaml'), 'v1')
        await git(root, 'add', '.')
        await git(root, 'commit', '-q', '-m', 'add lockfile')
        await writeFile(path.join(root, 'pnpm-lock.yaml'), 'v2')
        await writeFile(path.join(root, 'packages/a/file.txt'), 'a-changed')
        const out = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: claimOf(['b']),
        })
        expect([...out].sort()).toEqual(['a', 'b'])
        // And an empty answer selects only the path-owned project.
        const none = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: claimOf([]),
        })
        expect([...none]).toEqual(['a'])
      })

      it('"cannot tell" (undefined) widens exactly as an unclaimed file does', async () => {
        await writeFile(path.join(root, 'pnpm-lock.yaml'), 'v1')
        const out = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: claimOf(undefined),
        })
        expect([...out].sort()).toEqual(['a', 'b'])
      })

      it('a NEW claimed file has no base-ref bytes; a DELETED one no working-tree bytes', async () => {
        await writeFile(path.join(root, 'pnpm-lock.yaml'), 'v1')
        await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: claimOf([]),
        })
        expect(asked[0]!.before).toBeNull()
        expect(asked[0]!.after).not.toBeNull()
        await git(root, 'add', '.')
        await git(root, 'commit', '-q', '-m', 'add lockfile')
        await rm(path.join(root, 'pnpm-lock.yaml'))
        asked.splice(0)
        await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: claimOf([]),
        })
        expect(asked[0]!.before).not.toBeNull()
        expect(asked[0]!.after).toBeNull()
      })

      it('an UNCLAIMED lockfile changing alongside still widens', async () => {
        await writeFile(path.join(root, 'pnpm-lock.yaml'), 'v1')
        await writeFile(path.join(root, 'bun.lock'), '{}')
        const out = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: claimOf([]),
        })
        expect([...out].sort()).toEqual(['a', 'b'])
      })

      it('the claims are never loaded when no fingerprint file changed', async () => {
        // Loading them evaluates the workspace file; the diff that touches
        // no lockfile — nearly every one — must not pay for it.
        const loaded = { count: 0 }
        await writeFile(path.join(root, 'packages/a/file.txt'), 'a-changed')
        const out = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: claimOf(['b'], loaded),
        })
        expect([...out]).toEqual(['a'])
        expect(loaded.count).toBe(0)
      })

      it('a claimed root file core does not fold is asked about too (item 961)', async () => {
        // `turbo()` shapes every task from turbo.json; an edit re-keys them
        // through their resolved configs while no project owns the path, and
        // `--affected` selected nothing.
        await writeFile(path.join(root, 'turbo.json'), '{"tasks":{}}')
        await writeFile(path.join(root, 'README.md'), 'v1')
        await git(root, 'add', '.')
        await git(root, 'commit', '-q', '-m', 'turbo.json')
        const readsTurbo = (answer: readonly string[] | undefined) => async () => ({
          files: new Set(['turbo.json']),
          affected: async (c: Change) => {
            asked.push(c)
            return answer === undefined ? undefined : new Set(answer)
          },
        })
        // Control: an unclaimed root file still selects nothing.
        await writeFile(path.join(root, 'README.md'), 'v2')
        const readme = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: readsTurbo(undefined),
        })
        expect([...readme]).toEqual([])
        expect(asked).toHaveLength(0)
        await writeFile(path.join(root, 'turbo.json'), '{"tasks":{"build":{}}}')
        const all = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: readsTurbo(undefined),
        })
        expect([...all].sort()).toEqual(['a', 'b'])
        expect(asked.map((c) => c.file)).toEqual(['turbo.json'])
        const one = await affectedProjects({
          workspaceRoot: root,
          since: 'HEAD',
          projects,
          fingerprintClaims: readsTurbo(['b']),
        })
        expect([...one]).toEqual(['b'])
      })

      // Every row above hands `affectedProjects` a shim whose `affected`
      // returns a Set directly, so not one of them reaches the host that
      // stands between a REAL plugin's answer and this selection:
      // `claimedAffected`, wired in at its one call site, `cli/select.ts`
      // (plugin-pipeline.test.ts pins that wire end to end through the CLI).
      // The host's refusals are its own contract, and the string arm is the
      // one its docblock names outright.
      describe('claimedAffected — what a real plugin is allowed to answer', () => {
        const change = { file: 'pnpm-lock.yaml', before: null, after: null }
        const ctx = { projects: [] } as unknown as FingerprintContext
        const answering = (answer: unknown): VxPlugin =>
          testPlugin('org/pm', {
            fingerprint: {
              files: ['pnpm-lock.yaml'],
              affected: () => answer as never,
            },
          })
        const refusal = async (answer: unknown): Promise<string> => {
          try {
            await claimedAffected(answering(answer), change, ctx)
          } catch (err) {
            return err instanceof Error ? err.message : String(err)
          }
          return 'ACCEPTED'
        }

        it("a STRING is refused by name: 'all' does not select the projects a, l and l", async () => {
          // A string IS iterable, so with no guard at all the fold below walks
          // its CHARACTERS and the run silently narrows to whatever projects
          // happen to be spelled with them. Measured: the guard's explicit
          // `typeof answer === 'string'` arm is belt-and-braces — a string is
          // not an `'object'` either, so the second arm refuses it with the
          // same sentence. The arm states the intent; this row pins the
          // behaviour, and fails when the guard goes.
          expect(await refusal('all')).toBe(
            "plugin 'org/pm' failed in fingerprint: returned a string, not a list of project names",
          )
        })

        it('NULL and a number are refused with the same sentence, not a TypeError', async () => {
          // `typeof null === 'object'`, so null reaches `for (const name of
          // answer)` unless its own arm stops it — and what a `for…of` over
          // null or a number throws is an internal error naming neither the
          // plugin nor the hook.
          expect(await refusal(null)).toBe(
            "plugin 'org/pm' failed in fingerprint: returned null, not a list of project names",
          )
          expect(await refusal(42)).toBe(
            "plugin 'org/pm' failed in fingerprint: returned a number, not a list of project names",
          )
        })

        it('a name that is not a string is refused, rather than added as one', async () => {
          expect(await refusal([1])).toBe(
            "plugin 'org/pm' failed in fingerprint: affected project a number is not a name",
          )
        })

        it('a plugin that THROWS in `affected` is named, not surfaced as an internal error', async () => {
          const thrower = testPlugin('org/pm-boom', {
            fingerprint: {
              files: ['pnpm-lock.yaml'],
              affected: () => {
                throw new Error('boom')
              },
            },
          })
          await expect(claimedAffected(thrower, change, ctx)).rejects.toThrow(
            "plugin 'org/pm-boom' failed in fingerprint: boom",
          )
        })

        it('CONTROL: an array, a Set and "cannot tell" all pass through', async () => {
          expect([...(await claimedAffected(answering(['a', 'b']), change, ctx))!]).toEqual([
            'a',
            'b',
          ])
          expect([...(await claimedAffected(answering(new Set(['b'])), change, ctx))!]).toEqual([
            'b',
          ])
          expect(await claimedAffected(answering(undefined), change, ctx)).toBeUndefined()
        })
      })
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

  // nx#16975: a diff naming thousands of files overflowed a fixed buffer
  // (Node's `execSync` default is 1 MiB of stdout).
  it('six thousand changed files, over a megabyte of paths, select their project and no other', async () => {
    await mkdir(path.join(root, 'packages/b/gen'), { recursive: true })
    const long = 'x'.repeat(160)
    await Promise.all(
      Array.from({ length: 6000 }, (_, i) =>
        writeFile(path.join(root, `packages/b/gen/${long}-${i}.txt`), `${i}`),
      ),
    )
    const listed = Bun.spawnSync({ cmd: ['git', 'ls-files', '-o', '-z'], cwd: root })
    expect(listed.stdout.length).toBeGreaterThan(1024 * 1024)
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'generated')
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
    expect([...out]).toEqual(['b'])
    // Removed here, under this row's bound: the 6,000 files and their git
    // objects timed out the afterEach (bun's 5 s default) on a box under
    // I/O load (11.1 s for the row and its hooks, M-21).
    await rm(root, { recursive: true, force: true })
  }, 30_000)

  // nx#18112, nx#20691: deleting a whole project marked every project
  // affected (or failed on the missing one).
  it('a deleted project directory selects no remaining project', async () => {
    await git(root, 'rm', '-r', '-q', 'packages/a')
    await git(root, 'commit', '-q', '-m', 'drop a')
    const remaining = projects.filter((p) => p.name !== 'a')
    const out = await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD~1',
      projects: remaining,
    })
    expect([...out]).toEqual([])
    // CONTROL: the same diff, while `a` is still listed, names it.
    const listed = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
    expect([...listed]).toEqual(['a'])
  })
})

describe('defaultAffectedBase', () => {
  it('falls back to HEAD~1 when origin/HEAD is not set, and says "shallow clone" when that has no parent', async () => {
    // A CI checkout at fetch-depth 1 has neither origin/HEAD nor HEAD~1;
    // the old answer was `git ref "HEAD~1" did not resolve` — a ref the
    // user never typed (CI persona, 2026-09-16).
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-default-'))
    try {
      await git(root, 'init', '-q')
      await git(root, 'config', 'user.email', 'test@vx.local')
      await git(root, 'config', 'user.name', 'vx test')
      await writeFile(path.join(root, 'a'), 'x')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'one')
      await expect(defaultAffectedBase(root)).rejects.toThrow(
        /--affected has no base here: origin\/HEAD is not set \(or names a branch that is gone\) and HEAD has no parent .* a shallow clone\? .*fetch-depth: 0.*--affected=origin\/main/,
      )
      await writeFile(path.join(root, 'a'), 'y')
      await git(root, 'commit', '-q', '-am', 'two')
      expect(await defaultAffectedBase(root)).toBe('HEAD~1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('with no origin/HEAD, a trunk branch that is not HEAD is the base (D-93)', async () => {
    // actions/checkout fetches with no origin/HEAD, and a local repo has no
    // remote: `HEAD~1` saw a feature branch's last commit only, where Turbo
    // and Nx compare with `main`.
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-trunk-'))
    try {
      await git(root, 'init', '-q', '-b', 'main')
      await git(root, 'config', 'user.email', 'test@vx.local')
      await git(root, 'config', 'user.name', 'vx test')
      const commit = async (v: string): Promise<void> => {
        await writeFile(path.join(root, 'a'), v)
        await git(root, 'add', '.')
        await git(root, 'commit', '-q', '-m', v)
      }
      await commit('1')
      await commit('2')
      // CONTROL: on main itself, main is HEAD, so the previous commit.
      expect(await defaultAffectedBase(root)).toBe('HEAD~1')
      await git(root, 'checkout', '-q', '-b', 'feat')
      await commit('3')
      await commit('4')
      expect(await defaultAffectedBase(root)).toBe('main')
      // The remote's trunk before a local one, `main` before `master`.
      await git(root, 'update-ref', 'refs/remotes/origin/master', 'main')
      expect(await defaultAffectedBase(root)).toBe('origin/master')
      await git(root, 'update-ref', 'refs/remotes/origin/main', 'main')
      expect(await defaultAffectedBase(root)).toBe('origin/main')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refIsHead: the base is HEAD itself in a single-branch clone whose origin/HEAD is this branch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-self-'))
    try {
      await git(root, 'init', '-q', '-b', 'feat')
      await git(root, 'config', 'user.email', 'test@vx.local')
      await git(root, 'config', 'user.name', 'vx test')
      await writeFile(path.join(root, 'a'), 'x')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'one')
      await git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
      await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat')
      expect(await defaultAffectedBase(root)).toBe('origin/feat')
      expect(refIsHead(root, 'origin/feat')).toBe(true)
      expect(refIsHead(root, 'HEAD')).toBe(true)
      // CONTROL: once HEAD moves on, the same base is a real one.
      await writeFile(path.join(root, 'a'), 'y')
      await git(root, 'commit', '-q', '-am', 'two')
      expect(refIsHead(root, 'origin/feat')).toBe(false)
      expect(refIsHead(root, 'HEAD~1')).toBe(false)
      expect(refIsHead(root, 'no-such-ref')).toBe(false)
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
      // origin/HEAD at an existing origin/main: returned over HEAD~1.
      await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
      expect(await defaultAffectedBase(root)).toBe('origin/main')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an origin/HEAD naming a deleted branch is no base: HEAD~1, or the no-base hint (E-90)', async () => {
    // A pruned fetch keeps the symref after the remote deletes the branch;
    // bare --affected failed `git ref "origin/master" did not resolve`.
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-gone-'))
    try {
      await git(root, 'init', '-q')
      await git(root, 'config', 'user.email', 'test@vx.local')
      await git(root, 'config', 'user.name', 'vx test')
      await writeFile(path.join(root, 'a'), 'x')
      await git(root, 'add', '.')
      await git(root, 'commit', '-q', '-m', 'one')
      await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master')
      await expect(defaultAffectedBase(root)).rejects.toThrow(/--affected has no base here/)
      await writeFile(path.join(root, 'a'), 'y')
      await git(root, 'commit', '-q', '-am', 'two')
      expect(await defaultAffectedBase(root)).toBe('HEAD~1')
      // CONTROL: the branch back, the symref is the base again.
      await git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD~1')
      expect(await defaultAffectedBase(root)).toBe('origin/master')
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
// outside the declaring project, so mapping changed paths to project dirs
// cannot see them: `--affected` selected nothing for a change that re-keyed
// the task. Answering needs the resolved configs, which selection runs
// before loading — so the resolver is a callback, asked about every changed
// path once something changed (a glob may name a file inside ANOTHER
// project, item 954), and never when nothing did.

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

  it('reads a spelling the way the KEY reads it, or --affected skips a stale project', () => {
    // This function decides whether a changed workspace-root file marks a
    // project affected; `resolveWorkspaceFiles` decides whether the same
    // file is folded into that project's key. They have to agree, and on
    // five spellings they did not: the key folded the file and this
    // matched nothing, so `vx run --affected` left out a project its own
    // key called stale (item 445). `asTrees` on both sides is what the
    // resolver does.
    for (const glob of ['./shared/**', 'shared', 'shared/', 'shared//**', 'shared/./**']) {
      expect([glob, workspaceGlobsMatch([glob], 'shared/schema.txt')]).toEqual([glob, true])
    }
  })

  it('a negation reads the same way, so a loose spelling still subtracts', () => {
    // The other half of the partition. Left raw, `!./shared/ignored/**`
    // excluded nothing, so a file the config meant to drop stayed an
    // owner — the opposite error to the row above, and the one that makes
    // `--affected` too WIDE.
    expect(workspaceGlobsMatch(['shared/**', '!./shared/ignored/**'], 'shared/ignored/a.txt')).toBe(
      false,
    )
    expect(workspaceGlobsMatch(['shared/**', '!shared/ignored'], 'shared/ignored/a.txt')).toBe(
      false,
    )
  })

  it('CONTROL: the folding does not make an unrelated path match', () => {
    // Passes with and without the fix, which is what makes it a control:
    // otherwise the two rows above would be satisfied by a function that
    // says yes to everything, and `--affected` that selects everything is
    // no longer `--affected`.
    for (const glob of ['./shared/**', 'shared', 'shared/']) {
      expect([glob, workspaceGlobsMatch([glob], 'other/schema.txt')]).toEqual([glob, false])
      expect([glob, workspaceGlobsMatch([glob], 'shared-ish/schema.txt')]).toEqual([glob, false])
    }
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

  it('does NOT consult configs when nothing changed', async () => {
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
    expect([...out]).toEqual([])
    expect(calls).toBe(0)
  })

  it('asks about an in-project path too: another project may name it (item 954)', async () => {
    // `schema.md` allows a `workspaceFiles` glob into another project's
    // directory. Asking only the paths no project owns left the declaring
    // project out of a run its own key called stale.
    await writeFile(path.join(root, 'packages/a/file.txt'), 'changed')
    const seen: string[][] = []
    const out = await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD',
      projects,
      workspaceGlobOwners: async (changed) => {
        seen.push([...changed])
        return ['tool']
      },
    })
    expect(seen).toEqual([['packages/a/file.txt']])
    expect([...out].sort()).toEqual(['a', 'tool'])
  })

  it('consults configs once, with EXACTLY the changed paths', async () => {
    await writeFile(path.join(root, 'packages/a/file.txt'), 'changed')
    await writeFile(path.join(root, 'shared/schema.txt'), 'v2')
    const seen: string[][] = []
    const out = await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD',
      projects,
      workspaceGlobOwners: async (changed) => {
        seen.push([...changed].sort())
        return []
      },
    })
    expect(seen).toEqual([['packages/a/file.txt', 'shared/schema.txt']])
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
  it('PIN: deleting an imported orphan selects the importer it broke (item 958)', async () => {
    // The target no longer resolves, and an unresolvable import contributed
    // no edge: `--filter '[HEAD]'` exited 0 with app's config broken.
    await rm(path.join(root, 'shared/a.mjs'))
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out].sort()).toEqual(['app'])
  })

  it('PIN: a specifier spelled with an escape still reaches its importer (D-23)', async () => {
    // The scan decodes `\x2e` to `.`; the textual pass before it must not
    // drop a config whose relative import holds no literal `./`.
    await writeFile(
      path.join(root, 'packages/lib/vx.config.mjs'),
      "import { B } from '\\x2e\\x2e/\\x2e\\x2e/shared/b.mjs'\nexport default { tasks: {} }\n",
    )
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib imports b, escaped')
    expect(await editThenSelect('shared/b.mjs', 'export const B = 2\n')).toEqual(['lib'])
  })

  it('PIN: an extensionless import whose target is deleted reaches its importer too (item 958)', async () => {
    await writeFile(
      path.join(root, 'packages/lib/vx.config.mjs'),
      `import { B } from '../../shared/b'\nexport default { tasks: {} }\n`,
    )
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib imports b')
    await rm(path.join(root, 'shared/b.mjs'))
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out].sort()).toEqual(['lib'])
  })

  it('PIN: an extensionless import of a deleted directory index reaches its importer', async () => {
    await mkdir(path.join(root, 'shared/c'), { recursive: true })
    await writeFile(path.join(root, 'shared/c/index.mjs'), `export const C = 1\n`)
    await writeFile(
      path.join(root, 'packages/lib/vx.config.mjs'),
      `import { C } from '../../shared/c'\nexport default { tasks: {} }\n`,
    )
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib imports c')
    await rm(path.join(root, 'shared/c'), { recursive: true })
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out].sort()).toEqual(['lib'])
  })

  it('PIN: a tsconfig paths alias is an import edge, its deletion too (D-27)', async () => {
    // Bun resolves `@shared/*` through the nearest tsconfig.json and loads
    // the file from disk, so editing it re-keys lib's task; the walk read
    // only relative specifiers and selected nothing.
    await writeFile(
      path.join(root, 'tsconfig.json'),
      '{ "compilerOptions": { "paths": { "@shared/*": ["./shared/*"] } } }',
    )
    await writeFile(
      path.join(root, 'packages/lib/vx.config.mjs'),
      `import { FLAG } from '@shared/flag.mjs'\nexport default { tasks: {} }\n`,
    )
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib imports flag by alias')
    expect(
      await editThenSelect('shared/flag.mjs', `import './deep.mjs'\nexport const FLAG=2\n`),
    ).toEqual(['app', 'lib'])
    expect(await editThenSelect('shared/deep.mjs', `export const DEEP = 2\n`)).toEqual([
      'app',
      'lib',
    ])
    await rm(path.join(root, 'shared/flag.mjs'))
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out].sort()).toEqual(['app', 'lib'])
  })

  it('PIN: an alias through a symlinked dir names the file git reports (D-30)', async () => {
    // Bun loads the alias target by its real path, and the diff names the
    // real path; the edge must too, or the importer is missed.
    await symlink('shared', path.join(root, 'linked'))
    await writeFile(
      path.join(root, 'tsconfig.json'),
      '{ "compilerOptions": { "paths": { "@l/*": ["./linked/*"] } } }',
    )
    await writeFile(
      path.join(root, 'packages/lib/vx.config.mjs'),
      `import { B } from '@l/b.mjs'\nexport default { tasks: {} }\n`,
    )
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'lib imports b through a link')
    expect(await editThenSelect('shared/b.mjs', 'export const B = 2\n')).toEqual(['lib'])
  })
})

// The root `"."` member is a supported (and, in this repo, load-bearing)
// shape, and since D-39 any root with a `vx.config` is one. Its directory is
// the WHOLE workspace, so every shared file is "owned" by it; the walk
// descends through the root's own files as through unowned ones, since they
// are the same shared tooling (D-41). It stopped after one hop before, and
// an edit to a helper two hops out left the importer unselected while its
// key moved.
describe('affectedProjects: a workspace whose ROOT is itself a project', () => {
  let root: string
  let projects: ProjectMeta[]

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-affroot-'))
    const w = async (rel: string, body: string) => {
      const abs = path.join(root, rel)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, body)
    }
    await w('shared/flag.mjs', `import './deep.mjs'\nexport const FLAG = 'one'\n`)
    await w('shared/deep.mjs', `export const DEEP = 1\n`)
    await w('package.json', JSON.stringify({ name: 'root-pkg' }))
    await w('vx.config.mjs', `export default { tasks: {} }\n`)
    await w('packages/app/package.json', JSON.stringify({ name: 'app' }))
    await w(
      'packages/app/vx.config.mjs',
      `import { FLAG } from '../../shared/flag.mjs'\nexport default { tasks: { build: { exec: { command: 'echo ' + FLAG } } } }\n`,
    )
    projects = [
      {
        name: 'root-pkg',
        dir: root,
        configPath: path.join(root, 'vx.config.mjs'),
        packageJson: { name: 'root-pkg' },
      },
      {
        name: 'app',
        dir: path.join(root, 'packages/app'),
        configPath: path.join(root, 'packages/app/vx.config.mjs'),
        packageJson: { name: 'app' },
      },
    ]
    await git(root, 'init', '-q')
    await git(root, 'config', 'user.email', 'test@vx.local')
    await git(root, 'config', 'user.name', 'vx test')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'initial')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('still selects the importer one hop out', async () => {
    await writeFile(
      path.join(root, 'shared/flag.mjs'),
      `import './deep.mjs'\nexport const FLAG='two'\n`,
    )
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out].sort()).toEqual(['app', 'root-pkg'])
  })

  it('selects the importer two hops out, through files the root owns (D-41)', async () => {
    // `app`'s config reads FLAG, which is computed from deep.mjs, so app's
    // key moves here; the walk stopped at the root's first file and left
    // app out.
    await writeFile(path.join(root, 'shared/deep.mjs'), `export const DEEP = 2\n`)
    const out = await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects })
    expect([...out].sort()).toEqual(['app', 'root-pkg'])
  })
})

// `--affected`'s base is a SECURITY boundary, and it is guarded twice: a
// pre-spawn check that refuses an option-like `since`, and
// `--end-of-options` on every git call "so a second caller cannot lose
// the guard by accident". The check has four rows naming concrete attack
// values; the second layer had NOTHING — removing all five occurrences
// left the whole repo green (item 463), which is 461's layered blindness
// on a security boundary this time.
//
// Its behaviour is not observable today: every guarded helper is reached
// only with the already-checked `since`, so the layer is insurance
// against the future caller its own comment names. That makes it a LAW
// rather than a behaviour — the same genre as the module-boundary test —
// and the law is what stops it being deleted as dead code.
describe('every git call that passes a VALUE ends its options', () => {
  it('holds for every argument array in affected.ts', async () => {
    const src = await Bun.file(
      path.join(import.meta.dir, '..', 'src', 'workspace', 'affected.ts'),
    ).text()
    const arrays = [...src.matchAll(/spawnGit(?:Sync)?\(\s*(\[[^\]]*\])/gs)].map((m) => m[1]!)
    // The module is expected to spawn git in a handful of places; if this
    // drops to nothing the regex has stopped matching and the law is vacuous.
    expect(arrays.length).toBeGreaterThanOrEqual(4)
    const offenders = arrays.filter((a) => {
      // A pure spread forwards a caller-built array; the caller carries the
      // guard (and is itself one of these arrays).
      if (/^\[\s*\.\.\.[A-Za-z_$][\w$]*\s*,?\s*\]$/.test(a)) return false
      // All-literal argument lists cannot carry a user value.
      const passesAValue = /\$\{/.test(a) || /,\s*[A-Za-z_$][\w$]*\s*[,\]]/.test(a)
      return passesAValue && !a.includes('--end-of-options')
    })
    expect(offenders).toEqual([])
  })
})

describe("workspaceGlobOwners: the run path's staged load", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-owners-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    // A `project` plugin gives a config-less package a task reading a root
    // glob; a written config in a sibling declares none.
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
        'gen',
        `{ project(config, ctx) {
        if (ctx.name === 'bare') config.tasks.build = { exec: { command: 'true' }, cache: {
          inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] }, outputs: { files: [] } } }
      } }`,
      )}] }\n`,
    )
    for (const [name, config] of [
      ['bare', null],
      ['written', "export default { tasks: { build: { exec: { command: 'true' } } } }\n"],
    ] as const) {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
      if (config !== null) await writeFile(path.join(dir, 'vx.config.mjs'), config)
    }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // The OUTER guard of the same pair, pinned on its own for the same
  // reason. `loadCliProjects` is the staged load every verb goes
  // through, and it refuses a frozen run with no lock before selection
  // even begins — which is why the inner guard above could be deleted
  // with the whole repo still green.
  it('the staged load itself refuses a frozen run with no lock', async () => {
    const metas = await listProjects(await loadWorkspace(root))
    // Control: the same load without `frozen` succeeds, so the rejection
    // is the flag and not the fixture.
    expect((await loadCliProjects(root, metas, 'all', {})).size).toBeGreaterThan(0)
    await expect(loadCliProjects(root, metas, 'all', { frozen: true })).rejects.toThrow(
      /--frozen requires/,
    )
  })

  // A `--frozen` run with no lock is refused HERE, before the tolerant
  // sweep below can answer "nothing affected". The layering is what hid
  // this: `workspace-config.ts` refuses first on the CLI path, so
  // removing either guard alone leaves the other covering and the whole
  // repo still passes. Removing BOTH and running the real CLI on a
  // lockless workspace with an orphan-only change exits 0 saying
  // "nothing affected" — a green CI that ran nothing and never said why
  // (measured, item 461). This row pins THIS guard on its own, so the
  // pair is covered rather than each hiding the other's absence.
  it('refuses a frozen run with no lock instead of sweeping and answering "nothing"', async () => {
    const metas = await listProjects(await loadWorkspace(root))
    // Control first: without `frozen` the same call answers normally, so
    // the rejection below is the flag's doing and not a broken fixture.
    expect(await workspaceGlobOwners(root, metas, ['shared/x.ts'])).toEqual(['bare'])
    await expect(
      workspaceGlobOwners(root, metas, ['shared/x.ts'], { frozen: true }),
    ).rejects.toThrow(/--frozen requires/)
  })

  it('a glob a plugin gave a config-less package selects it; a sibling without one is not selected', async () => {
    // Read raw, `bare` had no config to inspect and an orphan edit under
    // shared/ selected nothing — `--affected` skipped a task whose input
    // had changed.
    const metas = await listProjects(await loadWorkspace(root))
    expect(await workspaceGlobOwners(root, metas, ['shared/x.ts'])).toEqual(['bare'])
    expect(await workspaceGlobOwners(root, metas, ['docs/x.md'])).toEqual([])
  })
})

describe('a fingerprint claim in a workspace BELOW the git root', () => {
  type Change = { file: string; before: Uint8Array | null; after: Uint8Array | null }
  let repo: string
  let ws: string
  let projects: ProjectMeta[]

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-subdir-'))
    ws = path.join(repo, 'code')
    await mkdir(path.join(ws, 'packages/a'), { recursive: true })
    await writeFile(path.join(ws, 'packages/a/file.txt'), 'a')
    await writeFile(path.join(ws, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nv1\n')
    // A DECOY at the repo root, so reading the wrong anchor finds bytes
    // rather than nothing — the reading this row exists to exclude is
    // "resolved from the repo root", not merely "found nothing".
    await writeFile(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nDECOY\n')
    projects = [
      { name: 'a', dir: path.join(ws, 'packages/a'), configPath: null, packageJson: { name: 'a' } },
    ]
    await git(repo, 'init', '-q')
    await git(repo, 'config', 'user.email', 'test@vx.local')
    await git(repo, 'config', 'user.name', 'vx test')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-q', '-m', 'initial')
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('reads the base-ref bytes from the WORKSPACE, not the repo root', async () => {
    // `gitBytesAt` spells the path `${ref}:./${file}`, and the `./` is
    // what anchors it to the cwd — the workspace — instead of the
    // repository root. Every other fixture in this file has the two in
    // the same place, so the anchor had no witness: drop it and a
    // workspace under `code/` reads some other file's bytes, or none,
    // and hands the plugin a `before` that was never its input.
    await writeFile(path.join(ws, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nv2\n')
    const asked: Change[] = []

    const out = await affectedProjects({
      workspaceRoot: ws,
      since: 'HEAD',
      projects,
      fingerprintClaims: async () => ({
        files: new Set(['pnpm-lock.yaml']),
        affected: async (c: Change) => {
          asked.push(c)
          return new Set(['a'])
        },
      }),
    })

    expect([...out]).toEqual(['a'])
    expect(asked).toHaveLength(1)
    expect(new TextDecoder().decode(asked[0]!.before!)).toBe('lockfileVersion: 9\nv1\n')
    expect(new TextDecoder().decode(asked[0]!.after!)).toBe('lockfileVersion: 9\nv2\n')
  })
})

describe('an --affected run walks the worktree once', () => {
  it('the selection reads the walk the run reuses: one status, no ls-files --others', async () => {
    const root = await makeWorkspace({ prefix: 'vx-affected-walk-', git: false })
    try {
      for (const name of ['a', 'b']) {
        await addProject(root, name, {
          config: `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
          files: { 'src/index.js': 'export {}\n' },
        })
      }
      gitInitCommit(root)
      await writeFile(path.join(root, 'packages/a/src/new.js'), 'export {}\n')
      const bin = path.join(root, '.gitbin')
      const log = path.join(root, '.gitbin.log')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'git'),
        `#!/bin/sh\necho "$*" >> '${log}'\nexec '${Bun.which('git')!}' "$@"\n`,
        { mode: 0o755 },
      )
      await writeFile(path.join(root, '.gitignore'), '.gitbin*\n')
      const p = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', 'build', '--affected=HEAD', '--dry'],
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env['PATH']}`, NO_COLOR: '1' },
      })
      expect([p.exitCode, p.stderr.toString()]).toEqual([0, ''])
      const lines = (await Bun.file(log).text()).split('\n')
      const count = (re: RegExp) => lines.filter((l) => re.test(l)).length
      expect([count(/(^| )status /), count(/ls-files .*--others/)]).toEqual([1, 0])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
