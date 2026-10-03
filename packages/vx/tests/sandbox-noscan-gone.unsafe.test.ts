// The scan command vx hands SRT (B-92) is a file in a temp directory that
// the process's `exit` hook removes. A probe that met it gone asked SRT's
// dependency check about the live config, which still named it, and read
// "ripgrep not found": every sandboxed test after `sandbox-trace-exit`
// (which emits `exit` mid-run) failed on CI. The probe must not hinge on a
// file vx made. (Since B-93 vx never removes it; a temp cleaner may.)

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { initSandbox, probeSandbox, resetSandbox } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox noscan test')
const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')

describe.skipIf(!available || process.platform !== 'linux')('the scan command gone', () => {
  it('leaves the sandbox available to the next probe', async () => {
    await resetSandbox()
    const spy = spyOn(SandboxManager, 'initialize')
    let command: string
    try {
      await initSandbox()
      command = (spy.mock.calls[0]![0] as { ripgrep: { command: string } }).ripgrep.command
    } finally {
      spy.mockRestore()
    }
    // The positive first: the file is there while the run holds it.
    expect(existsSync(command)).toBe(true)
    rmSync(path.dirname(command), { recursive: true, force: true })
    await resetSandbox()
    try {
      expect(await probeSandbox()).toEqual({ available: true, reason: '' })
    } finally {
      await resetSandbox()
    }
  })
})
