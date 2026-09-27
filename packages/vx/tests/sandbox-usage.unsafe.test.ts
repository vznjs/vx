// What a Linux sandboxed task reports of its own usage. bwrap runs the
// command in a pid namespace, and what its processes use never reaches
// vx's wait: a sandboxed busy loop reported the few milliseconds of
// strace and the shells around it as its CPU, and vx's own high-water
// mark, inherited at exec, as its peak (B-3). A number that is not the
// task's is worse than none, so none is reported.

import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { runCommand } from '../src/exec/runner.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox usage test')
// Burns 400 ms of its own CPU, however long the box takes to give it: a
// wall-clock loop read 246 ms of CPU in a loaded gate.
const BUSY = `bun -e "while (process.cpuUsage().user < 400000) {}"`

describe.skipIf(!available || process.platform !== 'linux')('a sandboxed task’s usage', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-usage-')))
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })

  it('is not reported, since what bwrap’s namespace used never reaches the wait', async () => {
    // The positive first: the same command, unsandboxed, burns what it says.
    const plain = await runCommand({ command: BUSY, cwd: dir, env: process.env })
    expect(plain.exitCode).toBe(0)
    expect(plain.cpuMs!).toBeGreaterThanOrEqual(300)
    const r = await runSandboxed({
      command: BUSY,
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({}, dir),
    })
    expect([r.exitCode, r.cpuMs, r.peakRssBytes]).toEqual([0, undefined, undefined])
  }, 60_000)
})
