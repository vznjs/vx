import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCommand } from './runner.js'

describe('runCommand', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vzn-runner-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('returns exit code 0 for a successful command and captures stdout', async () => {
    const result = await runCommand({
      command: 'echo hello',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns non-zero exit code for a failing command and captures stderr', async () => {
    const result = await runCommand({
      command: 'sh -c "echo bad >&2; exit 3"',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('bad')
  })

  it('streams chunks via onStdout / onStderr callbacks', async () => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    await runCommand({
      command: 'sh -c "echo out; echo err >&2"',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStdout: (c) => stdoutChunks.push(c),
      onStderr: (c) => stderrChunks.push(c),
    })
    expect(stdoutChunks.join('')).toContain('out')
    expect(stderrChunks.join('')).toContain('err')
  })

  it('surfaces command-not-found as a non-zero exit (shell reports 127)', async () => {
    const result = await runCommand({
      command: 'this-binary-does-not-exist-12345',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).not.toBe(0)
  })
})
