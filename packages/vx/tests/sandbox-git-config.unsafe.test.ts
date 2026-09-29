// B-41: `allow.gitConfig` reaches the sandbox, for the task that declares
// it. SRT reads `allowGitConfig` from the run's `initialize` config only,
// so the per-task flag vx passed was inert: `.git/config` stayed
// read-only to every task. A run with such a task now sets it per wrap,
// and a task without the grant in the same run still cannot write it.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
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
})
