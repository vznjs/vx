// A branch's cache scope (owner, 2026-10-17): `<owner>/<repo>:<branch>`.
// CI names it (`github()`'s `setBranch`), and a checkout on that branch
// derives the same name from its `.git` files, with no network. What the
// branch changed since the default branch decides which tasks read it;
// only a scoped run asks git that.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  loadWorkspacePlugins,
  localBranchScope,
  resolveCacheScope,
} from '../src/orchestrator/index.js'
import { branchChanges, configuredBaseBranch } from '../src/workspace/index.js'
import { scopedKey } from '../src/cache/scoped-cache.js'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { run } from './helpers/orchestrator.js'
import { silentLogger } from './helpers/orchestrator-fixture.js'

let root: string
let git: (...args: string[]) => string
const env = {}
const REMOTE = pluginSource('org/remote', '{ cache() { return undefined } }')

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
  expect(await facts('{ trusted: true }', "{ scope: 'a/b:c' }")).toEqual({ scope: 'a/b:c' })
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
  expect(() =>
    resolveCacheScope(root, undefined, true, undefined, { VX_CACHE_SCOPE: 'a b' }),
  ).toThrow('VX_CACHE_SCOPE must be')
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
      "VX_BASE_BRANCH must be a branch name like 'main'",
    )
  } finally {
    if (was === undefined) delete process.env['VX_BASE_BRANCH']
    else process.env['VX_BASE_BRANCH'] = was
  }
})

it('a branch changed what differs from its merge base with the default branch, or from a named base', async () => {
  const dir = path.join(root, 'packages/app')
  const projects = Promise.resolve([
    { name: 'app', dir, configPath: path.join(dir, 'vx.config.mjs') },
  ])
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('checkout', '-q', '-b', 'feat')
  await writeFile(path.join(root, 'packages/app/src/in.txt'), 'v2')
  git('commit', '-qam', 'edit')
  await writeFile(path.join(root, 'packages/app/README.md'), 'two')
  const changes = await branchChanges(root, undefined, undefined, projects)
  expect([...changes.changed].sort()).toEqual(['packages/app/README.md', 'packages/app/src/in.txt'])
  // A base a plugin names (a PR's base commit) is the base.
  git('commit', '-qam', 'readme')
  const base = git('rev-parse', 'HEAD~1').trim()
  expect((await branchChanges(root, base, undefined, projects)).changed).toEqual([
    'packages/app/README.md',
  ])
})

it('with no base to diff from, a branch changed nothing: every task reads the default key', async () => {
  // One commit and no trunk: a CI checkout at fetch-depth 1.
  git('branch', '-m', 'main', 'feat')
  const changes = await branchChanges(root, undefined, undefined, Promise.resolve([]))
  expect(changes.changed).toEqual([])
  // A base git cannot resolve is no change either.
  const bad = await branchChanges(root, 'deadbeef', undefined, Promise.resolve([]))
  expect(bad.changed).toEqual([])
})

it("on a branch, a README edit hits main's entry and a source edit reads and writes the branch's scope", async () => {
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([REMOTE]))
  git('add', '-A')
  git('commit', '-qm', 'remote')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const store = new Map<string, Uint8Array>()
  const remote: RemoteCacheLayer = {
    has: async (h) => store.has(h),
    hasMany: async (hs) => new Set(hs.filter((h) => store.has(h))),
    get: async (h) => {
      const b = store.get(h)
      return b === undefined ? null : { body: new Blob([b]), durationMs: undefined }
    },
    put: async (h, body) => void store.set(h, new Uint8Array(await body.arrayBuffer())),
  }
  const fixture = { root, log: [] as string[], err: [] as string[] }
  const once = async (): Promise<{ status: string; hash: string }> => {
    await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
    const r = await run({
      cwd: root,
      tasks: ['build'],
      log: silentLogger(fixture),
      remoteCache: remote,
      remoteReadOnlyByDefault: false,
    })
    expect(r.ok).toBe(true)
    return { status: r.outcomes[0]!.status, hash: r.outcomes[0]!.hash! }
  }
  const main = await once()
  expect([...store.keys()]).toEqual([main.hash])
  git('checkout', '-q', '-b', 'feat')
  await writeFile(path.join(root, 'packages/app/README.md'), 'two')
  expect(await once()).toEqual({ status: 'cache-hit-remote', hash: main.hash })
  await writeFile(path.join(root, 'packages/app/src/in.txt'), 'v2')
  const feat = await once()
  expect(feat.status).toBe('success')
  expect(store.has(scopedKey('acme/app:feat', feat.hash))).toBe(true)
  expect(store.has(feat.hash)).toBe(false)
})

// Owner, 2026-10-17: "local never cares about scopes but gets access to
// them when on branches from remote". A laptop on a branch reads the
// branch's remote entry and keeps it under the task key, so the same inputs
// on any branch, main included, hit it locally with no remote at all.
it("a laptop keeps a branch's remote entry under the task key: any branch then hits it locally", async () => {
  const fixture = { root, log: [] as string[], err: [] as string[] }
  await writeFile(path.join(root, 'packages/app/src/in.txt'), 'v2')
  // CI on the branch built it and saved it under the scope.
  const store = new Map<string, Uint8Array>()
  const remote: RemoteCacheLayer = {
    has: async (h) => store.has(h),
    get: async (h) => {
      const b = store.get(h)
      return b === undefined ? null : { body: new Blob([b]), durationMs: undefined }
    },
    put: async (h, body) => void store.set(h, new Uint8Array(await body.arrayBuffer())),
  }
  const once = async (opts: Record<string, unknown>) => {
    const r = await run({
      cwd: root,
      tasks: ['build'],
      log: silentLogger(fixture),
      scopeChanges: {
        projects: new Set(['app']),
        changed: ['packages/app/src/in.txt'],
        paths: new Map([['app', ['src/in.txt']]]),
        whole: new Set(),
      },
      ...opts,
    })
    expect(r.ok).toBe(true)
    return { status: r.outcomes[0]!.status, hash: r.outcomes[0]!.hash! }
  }
  const ci = await once({
    remoteCache: remote,
    remoteReadOnlyByDefault: false,
    cacheScope: 'acme/app:feat',
  })
  expect([...store.keys()]).toEqual([scopedKey('acme/app:feat', ci.hash)])
  await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
  // The laptop: read-only remote, the same scope.
  expect(await once({ remoteCache: remote, cacheScope: 'acme/app:feat' })).toEqual({
    status: 'cache-hit-remote',
    hash: ci.hash,
  })
  // No scope and no remote: the local store answers under the task key.
  expect(await once({})).toEqual({ status: 'cache-hit', hash: ci.hash })
})

// The zero-cost gate (EA, 2026-10-17): a run with no scope, or on the
// default branch, asks git nothing a run without scopes would not.
it('only a scoped run that asks its remote diffs the branch: main, a warm run and an unscoped run spawn no merge-base or diff', async () => {
  const remote = pluginSource(
    'org/remote',
    '{ cache() { return { has: async () => false, get: async () => null, put: async () => {} } } }',
  )
  const bin = await mkdtemp(path.join(os.tmpdir(), 'vx-branch-scope-git-'))
  const log = path.join(bin, 'calls.log')
  const real = Bun.which('git')!
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> ${log}\nexec ${real} "$@"\n`)
  await chmod(path.join(bin, 'git'), 0o755)
  const calls = async (): Promise<string[]> => {
    await rm(log, { force: true })
    const p = Bun.spawnSync({
      cmd: [
        process.execPath,
        path.join(import.meta.dir, 'helpers', 'vx-locked.ts'),
        'run',
        'build',
        '--all',
      ],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${bin}:${process.env['PATH']}`, NO_COLOR: '1', CI: '' },
    })
    expect(new TextDecoder().decode(p.stderr) + new TextDecoder().decode(p.stdout)).toContain(
      'info',
    )
    return (await readFile(log, 'utf8').catch(() => '')).split('\n')
  }
  const diffs = (lines: string[]): string[] =>
    lines.filter((l) => /^(merge-base|diff|for-each-ref|symbolic-ref) /.test(l))
  try {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([remote]))
    git('add', '-A')
    git('commit', '-qm', 'remote')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    expect(diffs(await calls())).toEqual([])
    git('checkout', '-q', '-b', 'feat')
    // The local cache answers: no remote call, so nothing to route.
    expect(diffs(await calls()).filter((l) => /^(merge-base|diff) /.test(l))).toEqual([])
    await writeFile(path.join(root, 'packages/app/src/in.txt'), 'v2')
    git('commit', '-qam', 'change')
    expect(diffs(await calls()).some((l) => l.startsWith('merge-base'))).toBe(true)
    // No cache plugin: no scope, no diff.
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([]))
    expect(diffs(await calls())).toEqual([])
  } finally {
    await rm(bin, { recursive: true, force: true })
  }
})
