import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  captureDefaultBranch,
  captureGitContext,
  captureHostContext,
  captureWorkspaceIdentity,
  detectCi,
  normalizeRemoteUrl,
  resolveCacheScope,
} from '../src/orchestrator/run-context.js'

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(proc.stderr)}`)
  }
}

describe('captureGitContext', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-runctx-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports commit sha + branch from one spawn in a committed repo', async () => {
    git(dir, ['init', '-q', '-b', 'main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    await writeFile(path.join(dir, 'a.txt'), 'one')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', 'init'])

    const ctx = captureGitContext(dir)
    expect(ctx.commitSha).toMatch(/^[0-9a-f]{40,64}$/)
    expect(ctx.branch).toBe('main')
    // dirty is no longer probed here — it's passed in by the
    // orchestrator (reusing the GitFilesCache populate's status spawn);
    // unspecified defaults to null.
    expect(ctx.dirty).toBeNull()
  })

  it('passes the supplied dirty flag straight through (no extra spawn)', () => {
    git(dir, ['init', '-q', '-b', 'main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])

    expect(captureGitContext(dir, true).dirty).toBe(true)
    expect(captureGitContext(dir, false).dirty).toBe(false)
    expect(captureGitContext(dir, null).dirty).toBeNull()
  })

  it('returns null commit/branch in a non-git directory without throwing', () => {
    const ctx = captureGitContext(dir)
    expect(ctx.commitSha).toBeNull()
    expect(ctx.branch).toBeNull()
    expect(ctx.dirty).toBeNull()
  })
})

describe('captureDefaultBranch', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dfltbr-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('prefers GitLab CI_DEFAULT_BRANCH', () => {
    expect(captureDefaultBranch({ CI_DEFAULT_BRANCH: 'trunk' }, dir)).toBe('trunk')
    // whitespace trimmed
    expect(captureDefaultBranch({ CI_DEFAULT_BRANCH: '  main \n' }, dir)).toBe('main')
  })

  it('reads GitHub event payload repository.default_branch', async () => {
    const evt = path.join(dir, 'event.json')
    await writeFile(evt, JSON.stringify({ repository: { default_branch: 'develop' } }))
    expect(captureDefaultBranch({ GITHUB_EVENT_PATH: evt }, dir)).toBe('develop')
  })

  it('GitLab env wins over a GitHub event payload', async () => {
    const evt = path.join(dir, 'event.json')
    await writeFile(evt, JSON.stringify({ repository: { default_branch: 'develop' } }))
    expect(captureDefaultBranch({ CI_DEFAULT_BRANCH: 'trunk', GITHUB_EVENT_PATH: evt }, dir)).toBe(
      'trunk',
    )
  })

  it('falls back to git origin/HEAD, stripping the remote prefix', () => {
    git(dir, ['init', '-q', '-b', 'main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    // A bare "remote" repo to point origin at + set origin/HEAD.
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    expect(captureDefaultBranch({}, dir)).toBe('main')
  })

  it('returns null when nothing resolves (no env, no remote HEAD)', () => {
    git(dir, ['init', '-q', '-b', 'main'])
    // no origin/HEAD ref set
    expect(captureDefaultBranch({}, dir)).toBeNull()
  })

  it('ignores an unreadable / malformed GitHub event payload, falls through to null', () => {
    expect(
      captureDefaultBranch({ GITHUB_EVENT_PATH: path.join(dir, 'missing.json') }, dir),
    ).toBeNull()
  })
})

describe('detectCi', () => {
  it('detects no CI for an empty env', () => {
    expect(detectCi({})).toEqual({ ci: false, provider: null })
  })

  it('treats CI=0 / CI=false as not-CI', () => {
    expect(detectCi({ CI: '0' })).toEqual({ ci: false, provider: null })
    expect(detectCi({ CI: 'false' })).toEqual({ ci: false, provider: null })
    expect(detectCi({ CI: '' })).toEqual({ ci: false, provider: null })
  })

  it('detects a bare truthy CI as generic', () => {
    expect(detectCi({ CI: 'true' })).toEqual({ ci: true, provider: 'generic' })
    expect(detectCi({ CI: '1' })).toEqual({ ci: true, provider: 'generic' })
  })

  it('detects specific providers', () => {
    expect(detectCi({ GITHUB_ACTIONS: 'true' })).toEqual({ ci: true, provider: 'github' })
    expect(detectCi({ GITLAB_CI: 'true' })).toEqual({ ci: true, provider: 'gitlab' })
    expect(detectCi({ BUILDKITE: 'true' })).toEqual({ ci: true, provider: 'buildkite' })
    expect(detectCi({ CIRCLECI: 'true' })).toEqual({ ci: true, provider: 'circleci' })
  })

  it('prefers the specific provider over a generic CI flag', () => {
    expect(detectCi({ CI: 'true', GITHUB_ACTIONS: 'true' })).toEqual({
      ci: true,
      provider: 'github',
    })
  })
})

describe('captureHostContext', () => {
  it('reports platform + arch and a hostname', () => {
    const ctx = captureHostContext()
    expect(ctx.os).toBe(process.platform)
    expect(ctx.arch).toBe(process.arch)
    // host may be null on a locked-down box, but on a normal runner it's
    // a non-empty string.
    if (ctx.host !== null) expect(ctx.host.length).toBeGreaterThan(0)
  })
})

describe('normalizeRemoteUrl', () => {
  it('reduces every common form of the same repo to one string', () => {
    const want = 'github.com/vznjs/vx'
    expect(normalizeRemoteUrl('git@github.com:vznjs/vx.git')).toBe(want)
    expect(normalizeRemoteUrl('https://github.com/vznjs/vx.git')).toBe(want)
    expect(normalizeRemoteUrl('https://github.com/vznjs/vx')).toBe(want)
    expect(normalizeRemoteUrl('ssh://git@github.com/vznjs/vx.git')).toBe(want)
    expect(normalizeRemoteUrl('HTTPS://user:pass@GitHub.com/vznjs/vx/')).toBe(want)
    // An explicit port must not split the id: a ported SSH/HTTPS URL reduces to
    // the same string as the unported form (the port is stripped, not kept).
    expect(normalizeRemoteUrl('ssh://git@github.com:2222/vznjs/vx.git')).toBe(want)
    expect(normalizeRemoteUrl('https://github.com:8443/vznjs/vx.git')).toBe(want)
  })
})

describe('captureWorkspaceIdentity', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-wsid-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const git = (...args: string[]): void => {
    const p = Bun.spawnSync({ cmd: ['git', '-C', dir, ...args], stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
  }

  it('derives the SAME id from ssh and https remotes of one repo', () => {
    git('init', '-q')
    git('remote', 'add', 'origin', 'git@github.com:vznjs/vx.git')
    const a = captureWorkspaceIdentity(dir)
    git('remote', 'set-url', 'origin', 'https://github.com/vznjs/vx.git')
    const b = captureWorkspaceIdentity(dir)
    expect(a.id).toBe(b.id)
    expect(a.name).toBe('vx')
    expect(a.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('no remote → persists a salt in .vx/workspace-id and stays stable', async () => {
    git('init', '-q')
    const a = captureWorkspaceIdentity(dir)
    const b = captureWorkspaceIdentity(dir)
    expect(a.id).toBe(b.id)
    expect(a.name).toBe(path.basename(dir))
    const salt = await Bun.file(path.join(dir, '.vx', 'workspace-id')).text()
    expect(salt.trim().length).toBeGreaterThan(0)
  })

  it('never throws outside a git repo', () => {
    const identity = captureWorkspaceIdentity(dir)
    expect(identity.id).toMatch(/^[0-9a-f]{16}$/)
    expect(identity.name).toBe(path.basename(dir))
  })
})

describe('resolveCacheScope', () => {
  it('derives a per-PR scope from GitHub / GitLab PR context', () => {
    expect(resolveCacheScope({ GITHUB_REF: 'refs/pull/42/merge' })).toBe('pr-42')
    expect(resolveCacheScope({ GITHUB_HEAD_REF: 'feature/x' })).toBe('gh-feature-x')
    expect(resolveCacheScope({ CI_MERGE_REQUEST_IID: '7' })).toBe('mr-7')
  })
  it('VX_CACHE_SCOPE overrides and is sanitized', () => {
    expect(resolveCacheScope({ VX_CACHE_SCOPE: 'my/scope!' })).toBe('my-scope-')
  })
  it('returns undefined outside a PR', () => {
    expect(resolveCacheScope({})).toBeUndefined()
    expect(resolveCacheScope({ GITHUB_REF: 'refs/heads/main' })).toBeUndefined()
  })
})
