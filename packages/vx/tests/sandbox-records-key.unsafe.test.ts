// Linux keys SRT's write records by the first 100 characters of what it
// wrapped. A networked task's wrap opened with the proxy-bridge wait, the
// same 190 characters for every task, so two networked tasks shared a key:
// the later one took the earlier one's writes as its own violations.
// main went red on c4314a0: release.sync reported build.bun.darwin-x64's
// granted writes to dist/ on the worker both ran on (2026-10-23).

import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox records key test')

describe.skipIf(!available || process.platform !== 'linux')('two networked tasks at once', () => {
  let dir = ''
  beforeAll(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-records-key-')))
    await resetSandbox()
    await initSandbox({ allowedDomains: ['a.test'] })
  })
  afterAll(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })

  const run = (command: string, allow: { network: string[]; write?: string[] }) =>
    runSandboxed({
      command,
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({ allow }, dir),
    })

  it("each keeps its own writes: the later one is not handed the earlier one's", async () => {
    const writer = run('sleep 0.5; mkdir -p out && echo x > out/a', {
      network: ['a.test'],
      write: ['out/'],
    })
    await Bun.sleep(100)
    const idle = run('sleep 1.5', { network: ['a.test'] })
    const [w, i] = await Promise.all([writer, idle])
    expect({
      writer: [w.exitCode, w.violations.map((v) => v.line)],
      idle: [i.exitCode, i.violations.map((v) => v.line)],
    }).toEqual({ writer: [0, []], idle: [0, []] })
  }, 30_000)
})
