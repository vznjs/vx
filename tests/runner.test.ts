import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCommand, shellQuote } from '../src/exec/runner.js'

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

  it('appends forwardArgs to the command, shell-quoted', async () => {
    const result = await runCommand({
      command: 'echo prefix:',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      forwardArgs: ['hello', 'world with space', `it's`],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(`prefix: hello world with space it's`)
  })

  it('reports cpuMs and peakRssBytes from rusage (v11 analytics)', async () => {
    // Burn a tiny bit of CPU so cpuMs is observably > 0.
    const result = await runCommand({
      command: 'i=0; while [ $i -lt 5000 ]; do i=$((i+1)); done; echo done',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.cpuMs).toBeDefined()
    expect(result.peakRssBytes).toBeDefined()
    expect(result.cpuMs!).toBeGreaterThanOrEqual(0)
    expect(result.peakRssBytes!).toBeGreaterThan(0)
  })

  it('captures rusage even when the command exits non-zero', async () => {
    const result = await runCommand({
      command: 'exit 7',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(7)
    expect(result.cpuMs).toBeDefined()
    expect(result.peakRssBytes).toBeDefined()
  })
})

describe('shellQuote', () => {
  it('leaves simple identifiers untouched', () => {
    expect(shellQuote('hello')).toBe('hello')
    expect(shellQuote('--watch')).toBe('--watch')
    expect(shellQuote('a/b.c=1')).toBe('a/b.c=1')
  })

  it('wraps strings with spaces in single quotes', () => {
    expect(shellQuote('hello world')).toBe(`'hello world'`)
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('handles empty string', () => {
    expect(shellQuote('')).toBe(`''`)
  })
})
