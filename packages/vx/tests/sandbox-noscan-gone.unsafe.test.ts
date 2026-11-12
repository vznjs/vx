// The scan command vx hands SRT (B-92) is a file in a temp directory that
// the process's `exit` hook removes. A probe that met it gone asked SRT's
// dependency check about the live config, which still named it, and read
// "ripgrep not found": every sandboxed test after `sandbox-trace-exit`
// (which emits `exit` mid-run) failed on CI. The probe must not hinge on a
// file vx made. (Since B-93 vx never removes it; a temp cleaner may.)
//
// It runs in a child with its own TMPDIR: the directory is one per user,
// and removing the shared one failed a parallel shard's sandboxed task at
// bwrap (sandbox-mount-race.unsafe.test.ts).

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox noscan test')
const EXEC = path.resolve(import.meta.dir, '..', 'src', 'sandbox', 'runtime.js')

describe.skipIf(!available || process.platform !== 'linux')('the scan command gone', () => {
  let tmp = ''
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-noscan-g-')))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('leaves the sandbox available to the next probe', async () => {
    const code = `
      const { existsSync, rmSync } = await import('node:fs')
      const path = await import('node:path')
      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
      const { initSandbox, probeSandbox, resetSandbox } = await import(${JSON.stringify(EXEC)})
      let command
      const real = SandboxManager.initialize
      SandboxManager.initialize = (config, ...rest) => { command ??= config.ripgrep?.command; return real(config, ...rest) }
      await initSandbox()
      SandboxManager.initialize = real
      // The positive first: the file is there while the run holds it.
      const there = existsSync(command)
      rmSync(path.dirname(command), { recursive: true, force: true })
      await resetSandbox()
      const probe = await probeSandbox()
      await resetSandbox()
      console.log(JSON.stringify({ under: command.startsWith(${JSON.stringify(tmp)}), there, probe }))
    `
    const proc = Bun.spawn([process.execPath, '-e', code], {
      cwd: import.meta.dir,
      env: { ...process.env, TMPDIR: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ exit: await proc.exited, err: err.trim() }).toEqual({ exit: 0, err: '' })
    expect(JSON.parse(out)).toEqual({
      under: true,
      there: true,
      probe: { available: true, reason: '' },
    })
  }, 30_000)
})
