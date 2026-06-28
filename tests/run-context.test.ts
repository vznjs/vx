import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { captureGitContext, captureHostContext, detectCi } from '../src/orchestrator/run-context.js'

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
