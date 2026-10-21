// What a Linux sandboxed task reports of its own usage. bwrap runs the
// command in a pid namespace, and what its processes use never reaches
// vx's wait: a sandboxed busy loop reported the few milliseconds of
// strace and the shells around it as its CPU, and vx's own high-water
// mark, inherited at exec, as its peak (B-3). So vx looks at the task's
// process tree while it runs: CPU (with what reaped children used) and
// resident memory, the task's own, not the wait's.

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
// Under strace each `cpuUsage()` is a traced syscall, so the sandbox burns
// a clock instead: `Date.now()` is the vDSO's, never a syscall.
const SPIN = `bun -e "const t = Date.now(); while (Date.now() - t < 800) {}"`

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

  it('is looked at while it runs, since what bwrap’s namespace used never reaches the wait', async () => {
    // The positive first: the same command, unsandboxed, burns what it says.
    const plain = await runCommand({ command: BUSY, cwd: dir, env: process.env })
    expect(plain.exitCode).toBe(0)
    expect(plain.cpuMs!).toBeGreaterThanOrEqual(300)
    const r = await runSandboxed({
      command: SPIN,
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({}, dir),
    })
    expect(r.exitCode).toBe(0)
    // The last look can land 250 ms before the end, and a loaded box gives
    // the spin less than its wall time; one thread spins, so never more
    // than twice the time it ran.
    expect(r.cpuMs!).toBeGreaterThanOrEqual(150)
    expect(r.cpuMs!).toBeLessThan(r.durationMs * 2)
    // Bun's own heap, never vx's inherited mark.
    expect(r.peakRssBytes!).toBeGreaterThan(5 * 2 ** 20)
    expect(r.peakRssBytes!).toBeLessThan(1024 * 2 ** 20)
  }, 60_000)
})
