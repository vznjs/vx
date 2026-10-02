// `runSandboxed` awaits the runtime, the tracer probe and the wrap before
// it spawns. A stop that landed in between was not looked at again: the
// task spawned after the teardown had swept the run's children, and ran.
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox abort-before-spawn test')

describe.skipIf(!available)('a sandboxed task stopped before its spawn', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-abort-')))
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })

  const start = (signal?: AbortSignal) =>
    runSandboxed({
      command: 'echo ran > marker.txt',
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({ allow: { write: ['marker.txt'] } }, dir),
      ...(signal !== undefined ? { signal } : {}),
    })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('never runs, and exits as %s would have', async (reason, code) => {
    const ac = new AbortController()
    const run = start(ac.signal)
    ac.abort(reason)
    const r = await run
    expect([r.exitCode, r.signal, existsSync(path.join(dir, 'marker.txt'))]).toEqual([
      code,
      reason,
      false,
    ])
  })

  it('CONTROL: runs when no stop came', async () => {
    const r = await start(new AbortController().signal)
    expect([r.exitCode, existsSync(path.join(dir, 'marker.txt'))]).toEqual([0, true])
  })
})
