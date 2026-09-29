// B-41: `allow.gitConfig` reaches the sandbox, for the task that declares
// it. SRT reads `allowGitConfig` from the run's `initialize` config only,
// so the per-task flag vx passed was inert: `.git/config` stayed
// read-only to every task. A run with such a task now sets it per wrap,
// and a task without the grant in the same run still cannot write it.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  initSandbox,
  resetSandbox,
  resolveSandboxConfig,
  runSandboxed,
  wrapSandboxedCommand,
} from '../src/exec/index.js'
import type { TaskNode } from '../src/graph/index.js'
import { prepareSandbox } from '../src/orchestrator/sandbox-request.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox git-config test')

describe.skipIf(!available)('allow.gitConfig', () => {
  let root = ''
  let prevCwd = ''
  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-gitcfg-')))
    mkdirSync(path.join(root, 'app'))
    git(root, 'init', '-q')
    git(path.join(root, 'app'), 'init', '-q')
    // SRT reads the scan's root, and the root `.git`, off the process.
    prevCwd = process.cwd()
    process.chdir(root)
  })
  afterAll(() => {
    process.chdir(prevCwd)
    rmSync(root, { recursive: true, force: true })
  })
  afterEach(async () => {
    await resetSandbox()
  })

  const setKey = (dir: string, key: string, gitConfig: boolean) =>
    runSandboxed({
      command: `git config ${key} 1`,
      cwd: dir,
      env: process.env,
      baseAllowRead: [root],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig(
        { allow: { write: ['.'], ...(gitConfig ? { gitConfig: true } : {}) } },
        dir,
      ),
    }).then((r) => r.exitCode)

  const read = (dir: string, key: string): string => {
    try {
      return git(dir, 'config', '--local', key)
    } catch {
      return ''
    }
  }

  for (const [name, rel] of [
    ['the root repository', '.'],
    ['a nested repository', 'app'],
  ] as const) {
    it(`writes ${name}'s .git/config for the task that grants it, and only for it`, async () => {
      const dir = path.join(root, rel)
      await initSandbox({ gitConfig: true })
      const granted = await setKey(dir, `vx.granted${rel === '.' ? 'Root' : 'App'}`, true)
      const withheld = await setKey(dir, `vx.withheld${rel === '.' ? 'Root' : 'App'}`, false)
      expect({
        granted,
        grantedValue: read(dir, `vx.granted${rel === '.' ? 'Root' : 'App'}`),
        withheldFailed: withheld !== 0,
        withheldValue: read(dir, `vx.withheld${rel === '.' ? 'Root' : 'App'}`),
      }).toEqual({ granted: 0, grantedValue: '1', withheldFailed: true, withheldValue: '' })
    })
  }

  const wrap = (gitConfig: boolean) =>
    wrapSandboxedCommand({
      command: 'true',
      cwd: root,
      env: process.env,
      baseAllowRead: [root],
      baseDenyRead: [],
      config: resolveSandboxConfig(
        { allow: { write: ['.'], ...(gitConfig ? { gitConfig: true } : {}) } },
        root,
      ),
    })

  // Each wrap reads SRT's run-wide config after it starts; concurrent wraps
  // hold the config for their own task only because they take turns.
  it("concurrent wraps each see their own task's grant", async () => {
    await initSandbox({ gitConfig: true })
    const seen: Array<boolean | undefined> = []
    const spy = spyOn(SandboxManager, 'wrapWithSandbox').mockImplementation(async () => {
      await Bun.sleep(5)
      seen.push(SandboxManager.getConfig()?.filesystem?.allowGitConfig)
      return 'true'
    })
    try {
      await Promise.all([wrap(true), wrap(false), wrap(true)])
      expect(seen).toEqual([true, false, true])
    } finally {
      spy.mockRestore()
    }
  })

  it('a run whose task grants it arms the per-wrap grant', async () => {
    const node = {
      id: 'app#t',
      projectName: 'app',
      projectDir: root,
      taskName: 't',
      config: { exec: { command: 'true', sandbox: { allow: { write: ['.'], gitConfig: true } } } },
      deps: [],
      requested: true,
    } as unknown as TaskNode
    await prepareSandbox([node])!.arm()
    const spy = spyOn(SandboxManager, 'wrapWithSandbox').mockImplementation(async () => {
      return String(SandboxManager.getConfig()?.filesystem?.allowGitConfig)
    })
    try {
      expect((await wrap(true)).wrapped.includes('true')).toBe(true)
      expect(spy.mock.results.length).toBe(1)
      expect(await spy.mock.results[0]!.value).toBe('true')
    } finally {
      spy.mockRestore()
    }
  })
})
