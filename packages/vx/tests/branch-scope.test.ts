// A branch's cache scope (2026-10-17): `<owner>/<repo>:<branch>`.
// CI names it (`github()`'s `setBranch`), and a checkout on that branch
// derives the same name from its `.git` files, with no network. It keys
// plugin entries only; task keys never carry it (2026-10-20).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  loadWorkspacePlugins,
  localBranchScope,
  resolveCacheScope,
} from '../src/orchestrator/index.js'
import { configuredBaseBranch } from '../src/workspace/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

let root: string
let git: (...args: string[]) => string
const env = {}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-branch-scope-', git: false })
  await addProject(root, 'app', {
    files: { 'src/in.txt': 'v1', 'README.md': 'one' },
    config: `export default { tasks: { build: { exec: { command: 'cat src/in.txt > out.txt' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } } } } }`,
  })
  git = gitIn(root)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  git('remote', 'add', 'origin', 'git@github.com:Acme/App.git')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})
afterEach(() => rm(root, { recursive: true, force: true }))

it("a checkout names its remote's repository and the branch it tracks, else its own; none on the default branch", () => {
  expect(localBranchScope(root, undefined, env)).toBeUndefined()
  git('checkout', '-q', '-b', 'feat/a+b')
  expect(localBranchScope(root, undefined, env)).toBe('acme/app:feat/a_b')
  // Tracking a fork's branch: the fork's repository, the upstream's name.
  git('remote', 'add', 'eve', 'https://github.com/eve/app.git')
  git('config', 'branch.feat/a+b.remote', 'eve')
  git('config', 'branch.feat/a+b.merge', 'refs/heads/team/feat')
  expect(localBranchScope(root, undefined, env)).toBe('eve/app:team/feat')
  git('checkout', '-q', '--detach')
  expect(localBranchScope(root, undefined, env)).toBeUndefined()
})

// A GitLab subgroup's project is `group/sub/app` on CI (`gitlab()`); a
// laptop that kept only the last two segments named another scope.
it("a subgroup's project path is kept whole, as gitlab() names it", () => {
  git('remote', 'set-url', 'origin', 'https://gitlab.com/Acme/Web/App.git')
  git('checkout', '-q', '-b', 'feat')
  expect(localBranchScope(root, undefined, env)).toBe('acme/web/app:feat')
})

it('no remote URL, no scope: nothing names the repository', () => {
  git('remote', 'remove', 'origin')
  git('checkout', '-q', '-b', 'feat')
  expect(localBranchScope(root, undefined, env)).toBeUndefined()
})

it('the default branch is `baseBranch`, else the remote HEAD when one is set', () => {
  git('checkout', '-q', '-b', 'trunk')
  git('update-ref', 'refs/remotes/origin/trunk', 'HEAD')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
  expect(localBranchScope(root, undefined, env)).toBeUndefined()
  git('checkout', '-q', '-b', 'main2')
  expect(localBranchScope(root, undefined, env)).toBe('acme/app:main2')
  // A configured `baseBranch` names it instead.
  expect(localBranchScope(root, 'main2', env)).toBeUndefined()
})

// Owner, 2026-10-18: a merge queue's run is trusted. It reads and writes
// the default keys, whatever branch git names; VX_CACHE_SCOPE still wins.
it("a plugin's trusted run has no scope, whatever git names", async () => {
  git('checkout', '-q', '-b', 'feat')
  expect(resolveCacheScope(root, null, true, undefined, env)).toBeUndefined()
  expect(resolveCacheScope(root, null, true, undefined, { VX_CACHE_SCOPE: 'x:y' })).toBe('x:y')
  const facts = async (...calls: string[]) => {
    const hook = calls.map((c) => `ctx.setBranch(${c})`).join('; ')
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([pluginSource('org/ci', `{ config(_w, ctx) { ${hook} } }`)]),
    )
    return (await loadWorkspacePlugins(root, () => {})).branch
  }
  expect(await facts("{ scope: 'a/b:c' }", "{ trusted: true, base: 'b4' }")).toEqual({
    trusted: true,
    base: 'b4',
  })
  expect(await facts('{ trusted: true }', "{ scope: 'a/b:c' }")).toEqual({ scope: 'a/b:c' }) // A plugin names the refs a remote reads (2026-10-25); a later one wins.
  expect(
    await facts(
      "{ refs: ['refs/heads/a', 'refs/heads/a', 'refs/heads/main'] }",
      "{ refs: ['refs/heads/main'] }",
    ),
  ).toEqual({ refs: ['refs/heads/main'] })
  await expect(facts("{ refs: ['main'] }")).rejects.toThrow(
    'setBranch: refs must be a list of refs',
  )
  await expect(facts("{ refs: 'refs/heads/main' }")).rejects.toThrow('setBranch: refs')
  // `--affected` reads the base into its `...[<base>]` filter: 42 diffed
  // from a commit named "42", and '' or 'a]b' broke the filter's syntax.
  for (const base of ['42', "''", "'a]b'", "'a b'"]) {
    await expect(facts(`{ base: ${base} }`)).rejects.toThrow(
      "plugin 'org/ci' failed in config: setBranch: base must be a commit or a ref",
    )
  }
})

it("VX_CACHE_SCOPE beats a plugin's scope, which beats git's; git's needs a cache plugin", () => {
  git('checkout', '-q', '-b', 'feat')
  expect(resolveCacheScope(root, undefined, false, undefined, env)).toBeUndefined()
  expect(resolveCacheScope(root, undefined, true, undefined, env)).toBe('acme/app:feat')
  expect(resolveCacheScope(root, 'acme/app:ci', true, undefined, env)).toBe('acme/app:ci')
  expect(resolveCacheScope(root, 'acme/app:ci', true, undefined, { VX_CACHE_SCOPE: 'x:y' })).toBe(
    'x:y',
  )
  expect(
    resolveCacheScope(root, 'acme/app:ci', true, undefined, { VX_CACHE_SCOPE: '' }),
  ).toBeUndefined()
  // A VX_* value the run does not take is usage, as every setting variable
  // is (cli.md § VX_E_USAGE), and names what it got.
  let refused: unknown
  try {
    resolveCacheScope(root, undefined, true, undefined, { VX_CACHE_SCOPE: 'a b' })
  } catch (err) {
    refused = err
  }
  expect(refused).toMatchObject({
    code: 'VX_E_USAGE',
    message:
      "VX_CACHE_SCOPE must be a scope name of letters, digits and . _ - / @ : (at most 128), like 'vznjs/vx:feat-x' (got a b)",
  })
})

it("VX_BASE_BRANCH beats the workspace's baseBranch, and a value no branch can take is refused", () => {
  const was = process.env['VX_BASE_BRANCH']
  try {
    delete process.env['VX_BASE_BRANCH']
    expect(configuredBaseBranch({ baseBranch: 'develop' })).toBe('develop')
    expect(configuredBaseBranch(null)).toBeUndefined()
    process.env['VX_BASE_BRANCH'] = 'release/2'
    expect(configuredBaseBranch({ baseBranch: 'develop' })).toBe('release/2')
    process.env['VX_BASE_BRANCH'] = '--output=x'
    expect(() => configuredBaseBranch(null)).toThrow(
      "VX_BASE_BRANCH must be a branch name like 'main' (got --output=x)",
    )
  } finally {
    if (was === undefined) delete process.env['VX_BASE_BRANCH']
    else process.env['VX_BASE_BRANCH'] = was
  }
})
