import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCommand, shellQuote } from '../src/exec/runner.js'

describe('runCommand', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-runner-'))
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

  // Adversarial inputs — verify quoting survives a literal pass
  // through `sh -c`. These would be catastrophic without proper
  // single-quoting; we want command injection to be impossible
  // through the forwardArgs path.
  it('quotes shell-injection attempts so they reach the child as literal text', async () => {
    const { runCommand } = await import('../src/exec/runner.js')
    const cwd = (await import('node:fs/promises')).mkdtemp(
      (await import('node:path')).join((await import('node:os')).tmpdir(), 'vx-runner-quote-'),
    )
    const dir = await cwd
    try {
      const payloads = [
        `; touch /tmp/vx-pwned-${process.pid}`, // statement injection
        `$(echo evaluated)`, // command substitution
        `"hello" world`, // mixed quoting
        `a 'b' c`, // single quotes inside
        `a\\b`, // backslash literal
        `multi
line`, // embedded newline
      ]
      const r = await runCommand({
        command: 'printf "%s\\n"',
        cwd: dir,
        env: { PATH: process.env.PATH ?? '' },
        forwardArgs: payloads,
      })
      expect(r.exitCode).toBe(0)
      // Each payload survives byte-for-byte (sans the literal newline
      // payload which prints across two lines — the joined output still
      // contains the originals).
      for (const p of payloads) {
        expect(r.stdout).toContain(p)
      }
      // Side effect that injection would have caused: the file MUST
      // not exist.
      const { existsSync } = await import('node:fs')
      expect(existsSync(`/tmp/vx-pwned-${process.pid}`)).toBe(false)
    } finally {
      await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
    }
  })
})
