import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { runCommand } from '../src/exec/runner.js'
import * as spawnOffModule from '../src/exec/spawn-off.js'

const linux = process.platform === 'linux'

// A task's shell is started before the task is asked for, so the slot that
// frees does not wait for sh to exec: 4.4 → 2.7 ms of each task's time
// past its own work (200 `sleep 0.02`, 2026-11-01).
describe.skipIf(!linux)('a task runs in a shell started before it', () => {
  let cwd: string
  const env = { PATH: process.env.PATH ?? '', VX_W: "it's a\nvalue $HOME" }
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-warm-'))
    // The pool's first spare, started by this call.
    await runCommand({ command: 'true', cwd, env })
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('spawns no shell for the task it runs', async () => {
    const spy = spyOn(spawnOffModule, 'spawnOff')
    try {
      const res = await runCommand({ command: 'echo warm-out; exit 3', cwd, env })
      expect(res.exitCode).toBe(3)
      expect(res.stdout).toBe('warm-out\n')
      expect(spy.mock.calls.some(([o]) => o.cmd.join(' ').includes('warm-out'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('hands the task the env, directory and descriptors a fresh shell would', async () => {
    const probe = 'env | sort; pwd; ls /proc/self/fd; echo $0'
    const warm = await runCommand({ command: probe, cwd, env })
    // An env name sh cannot export keeps a task off the spare: it spawns.
    const spy = spyOn(spawnOffModule, 'spawnOff')
    try {
      const fresh = await runCommand({ command: probe, cwd, env: { ...env, 'A-B': '1' } })
      expect(warm.stdout).toBe(fresh.stdout)
      expect(spy.mock.calls.some(([o]) => o.cmd.join(' ').includes(probe))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('fails a task whose directory is gone as a spawn that threw', async () => {
    const res = await runCommand({ command: 'true', cwd: path.join(cwd, 'gone'), env })
    expect(res.spawnFailed).toBe(true)
    expect(res.exitCode).toBe(127)
    expect(res.stderr).toContain('does not exist')
  })
})
