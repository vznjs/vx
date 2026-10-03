// The scan command vx hands SRT (B-92) lives in one 0700 directory per
// user (B-93). A directory per process outlived every SIGKILLed run, one
// left in the temp dir each time. SRT runs the file outside the sandbox, so
// anything at the name that is not this user's own empty executable in a
// directory only this user can write is refused for `true`. Each row runs
// in a child with its own TMPDIR: the path is fixed once a process.

import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox noscan directory test')
const EXEC = path.resolve(import.meta.dir, '..', 'src', 'exec', 'index.js')

/** The scan command a fresh process hands SRT under `tmp`. */
async function scanCommand(tmp: string): Promise<string> {
  const code = `
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    const { initSandbox, resetSandbox } = await import(${JSON.stringify(EXEC)})
    let seen
    const real = SandboxManager.initialize
    SandboxManager.initialize = (config, ...rest) => { seen = config.ripgrep?.command; return real(config, ...rest) }
    await initSandbox()
    await resetSandbox()
    console.log(seen)
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
  return out.trim()
}

describe.skipIf(!available || process.platform !== 'linux')('the no-scan directory', () => {
  let tmp = ''
  let own = ''
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-noscan-t-')))
    own = path.join(tmp, `vx-noscan-${process.getuid!()}`)
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('is one per user, so runs share it and a killed run leaves nothing new', async () => {
    const first = await scanCommand(tmp)
    expect(first).toBe(path.join(own, 'rg'))
    expect(await scanCommand(tmp)).toBe(first)
  }, 30_000)

  it('refuses a directory others can write, for `true`', async () => {
    mkdirSync(own, { mode: 0o700 })
    chmodSync(own, 0o777)
    expect(await scanCommand(tmp)).toBe(Bun.which('true')!)
  }, 30_000)

  it('refuses a file that is not empty, for `true`', async () => {
    mkdirSync(own, { mode: 0o700 })
    writeFileSync(path.join(own, 'rg'), '#!/bin/sh\necho ran > /dev/null\n', { mode: 0o700 })
    expect(await scanCommand(tmp)).toBe(Bun.which('true')!)
  }, 30_000)

  it('refuses a directory or a file it cannot run at the file name, for `true`', async () => {
    mkdirSync(own, { mode: 0o700 })
    mkdirSync(path.join(own, 'rg'))
    expect(await scanCommand(tmp)).toBe(Bun.which('true')!)
    rmSync(path.join(own, 'rg'), { recursive: true })
    writeFileSync(path.join(own, 'rg'), '', { mode: 0o600 })
    expect(await scanCommand(tmp)).toBe(Bun.which('true')!)
  }, 30_000)

  // Only root can hand a directory to another owner.
  it.skipIf(process.getuid!() !== 0)(
    'refuses a directory another user owns, for `true`',
    async () => {
      mkdirSync(own, { mode: 0o700 })
      chownSync(own, 65534, 65534)
      expect(await scanCommand(tmp)).toBe(Bun.which('true')!)
    },
    30_000,
  )

  it('refuses a link at the name, for `true`', async () => {
    const real = path.join(tmp, 'elsewhere')
    mkdirSync(real, { mode: 0o700 })
    await Bun.$`ln -s ${real} ${own}`.quiet()
    expect(await scanCommand(tmp)).toBe(Bun.which('true')!)
  }, 30_000)
})
