// `sandbox.weakerWhenNested` reaches the sandbox. SRT reads
// `enableWeakerNestedSandbox` from its run-wide config only, so the
// per-call flag vx passed did nothing: a task in a container that refuses
// a fresh proc mount ("bwrap: Can't mount proc on /newroot/proc") failed
// with the flag set as without it, and the availability probe with it.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { TaskNode } from '../src/graph/index.js'
import { prepareSandbox } from '../src/sandbox/request.js'
import {
  probeSandbox,
  resetSandbox,
  resolveSandboxConfig,
  wrapSandboxedCommand,
} from '../src/sandbox/runtime.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox weaker-nested test')

describe.skipIf(!available || process.platform !== 'linux')('sandbox.weakerWhenNested', () => {
  let root = ''
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-weaker-')))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })
  afterEach(async () => {
    await resetSandbox()
  })

  const node = (id: string, weaker: boolean): TaskNode =>
    ({
      id,
      projectName: 'app',
      projectDir: root,
      taskName: id,
      config: { exec: { command: 'true', sandbox: weaker ? { weakerWhenNested: true } : {} } },
      deps: [],
      requested: true,
    }) as unknown as TaskNode
  const wrap = async (weaker: boolean): Promise<string> =>
    (
      await wrapSandboxedCommand({
        command: 'true',
        cwd: root,
        env: process.env,
        baseAllowRead: [root],
        baseDenyRead: [],
        config: resolveSandboxConfig(weaker ? { weakerWhenNested: true } : {}, root),
      })
    ).wrapped
  const FRESH = '--proc /proc'
  const HOSTS = '--bind /proc /proc'

  it('a task that sets it binds /proc and mounts none', async () => {
    await prepareSandbox([node('a', true)])!.arm()
    const w = await wrap(true)
    expect([w.includes(HOSTS), w.includes(FRESH)]).toEqual([true, false])
  })

  it('a task without it, in the same run, keeps the fresh /proc', async () => {
    await prepareSandbox([node('a', true), node('b', false)])!.arm()
    const [weak, secure, weakAgain] = await Promise.all([wrap(true), wrap(false), wrap(true)])
    expect([weak!.includes(HOSTS), secure!.includes(FRESH), secure!.includes(HOSTS)]).toEqual([
      true,
      true,
      false,
    ])
    expect(weakAgain!.includes(HOSTS)).toBe(true)
  })

  it('the probe of a run whose every task sets it wraps the weaker way', async () => {
    const seen: Array<boolean | undefined> = []
    const real = SandboxManager.wrapWithSandbox.bind(SandboxManager)
    const spy = spyOn(SandboxManager, 'wrapWithSandbox').mockImplementation(async (...a) => {
      seen.push(SandboxManager.getConfig()?.enableWeakerNestedSandbox)
      return real(...a)
    })
    try {
      expect((await probeSandbox({ weakerNested: true })).available).toBe(true)
      expect(seen).toEqual([true])
      expect(SandboxManager.getConfig()?.enableWeakerNestedSandbox).not.toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
