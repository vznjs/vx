// B-40: SRT's mandatory-deny scan, scoped to each task's write grants.
// The parity row builds the same wrap twice from one fixture: SRT's own
// whole-root scan at depth 3, and SRT at depth 1 plus the scoped denies.
// bwrap must receive the same deny binds under the fixture. The fixture
// holds only what rg and the scoped walk agree on (no .gitignore, no
// node_modules, no symlinks: there the scoped walk is stricter, which
// sandbox-deny-scan.test.ts holds).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  initSandbox,
  resetSandbox,
  resolveSandboxConfig,
  wrapSandboxedCommand,
} from '../src/exec/index.js'
import { scopedMandatoryDenies, srtDefaultWritePaths } from '../src/exec/sandbox-deny-scan.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox deny-scan test')

describe.skipIf(!available || process.platform !== 'linux')('the scoped deny scan', () => {
  let root = ''
  let prevCwd = ''
  const file = (rel: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), '')
  }
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-denyscan-')))
    for (const rel of [
      '.bashrc',
      '.gitmodules',
      '.claude/commands/k',
      'a/.mcp.json',
      'a/b/.BashRc',
      'a/b/c/.bashrc',
      'a/.vscode/x',
      'a/.idea/y/z',
      'a/ok.txt',
      'g/.git/config',
      'g/.git/hooks/h',
      'o/.zshrc',
      'o/.idea/w',
    ]) {
      file(rel)
    }
    // SRT reads the scan's root off the process.
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

  /** The deny binds under the fixture: every `--ro-bind` whose destination is in it. */
  const denyBinds = (wrapped: string): string[] =>
    [...wrapped.matchAll(/--ro-bind '?([^' ]+)'? '?([^' ]+)'?/g)]
      .map((m) => m[2]!)
      .filter((d) => d.startsWith(`${root}/`))
      .sort()

  const wrapWith = async (depth: number, writes: string[], denyWrite: string[]) => {
    // `initialize` keeps a runtime that is already up, as the gate's probe left it.
    await resetSandbox()
    await SandboxManager.initialize(
      {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        mandatoryDenySearchDepth: depth,
      },
      undefined,
      true,
    )
    const wrapped = await SandboxManager.wrapWithSandbox('true', undefined, {
      filesystem: { denyRead: [], allowRead: [], allowWrite: writes, denyWrite },
      network: { allowedDomains: [], deniedDomains: [] },
    })
    await SandboxManager.reset()
    return denyBinds(wrapped)
  }

  for (const grants of [['a', 'g'], ['.'], ['..']]) {
    it(`binds what SRT's whole-root scan binds, for write grants ${grants.join(', ')}`, async () => {
      const writes = grants.map((g) => path.join(root, g))
      const whole = await wrapWith(3, writes, [])
      const scoped = await wrapWith(
        1,
        writes,
        scopedMandatoryDenies(root, [...srtDefaultWritePaths(), ...writes]),
      )
      expect(whole.length).toBeGreaterThan(0)
      expect(scoped).toEqual(whole)
    })
  }

  it('a task wrap hands SRT the scoped denies of its write grants', async () => {
    await initSandbox()
    const spy = spyOn(SandboxManager, 'wrapWithSandbox')
    try {
      await wrapSandboxedCommand({
        command: 'true',
        cwd: path.join(root, 'a'),
        env: process.env,
        baseAllowRead: [],
        baseDenyRead: [],
        config: resolveSandboxConfig({ allow: { write: ['.'] } }, path.join(root, 'a')),
      })
      const denyWrite = spy.mock.calls[0]![2]!.filesystem!.denyWrite!
      expect([...denyWrite].sort()).toEqual(
        [
          path.join(root, 'a/.mcp.json'),
          path.join(root, 'a/.vscode'),
          path.join(root, 'a/b/.BashRc'),
        ].sort(),
      )
    } finally {
      spy.mockRestore()
    }
  })
})
