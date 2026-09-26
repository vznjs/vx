// A process exit while a sandboxed task's strace log is being removed. The
// removal unlinks asynchronously; it struck the log from the exit hook's
// list before the unlink began, so an exit in between found nothing to
// remove and left the log (item 868). The unlink of the log is held
// pending here, so the exit lands inside that window every time; its own
// file because `mock.module` holds for the whole file.

import * as fsPromises from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const real = { ...fsPromises }
let hold: Promise<void> | undefined
let started: ((file: string) => void) | undefined
await mock.module('node:fs/promises', () => ({
  ...real,
  unlink: async (p: string) => {
    if (hold !== undefined && path.basename(String(p)).startsWith('vx-strace-')) {
      started?.(String(p))
      await hold
    }
    return real.unlink(p)
  },
}))
const { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } =
  await import('../src/exec/index.js')
const { sandboxAvailable } = await import('./helpers/sandbox-gate.js')

const available = await sandboxAvailable('sandbox trace-log exit test')

describe.skipIf(!available || process.platform !== 'linux')('a sandboxed task’s trace log', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await real.mkdtemp(path.join(os.tmpdir(), 'vx-trace-exit-')))
    await initSandbox()
  })
  afterEach(async () => {
    hold = undefined
    started = undefined
    await resetSandbox()
    await real.rm(dir, { recursive: true, force: true })
  })

  it('goes with an exit that lands while it is being removed', async () => {
    let release!: () => void
    hold = new Promise((r) => {
      release = r
    })
    const removing = new Promise<string>((r) => {
      started = r
    })
    const running = runSandboxed({
      command: 'echo up',
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({}, dir),
    })
    const log = await removing
    // The positive first: the log is there when its removal begins.
    expect(existsSync(log)).toBe(true)
    process.emit('exit', 0)
    const left = existsSync(log)
    release()
    await running
    expect(left).toBe(false)
  })
})
