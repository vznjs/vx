import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  resourceUsageToCpuRss,
  runCommand,
  runPersistent,
  shellQuote,
  signalExitCode,
} from '../src/exec/runner.js'

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

  it('reports 128+signo for a SIGKILL-killed child (137)', async () => {
    const result = await runCommand({
      command: 'kill -KILL $$',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(137)
  })

  it('reports 128+signo for a SIGTERM-killed child (143)', async () => {
    const result = await runCommand({
      command: 'kill -TERM $$',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(143)
  })
})

describe('signalExitCode', () => {
  it('maps common signals via the platform signal table', () => {
    expect(signalExitCode('SIGKILL')).toBe(137)
    expect(signalExitCode('SIGTERM')).toBe(143)
    expect(signalExitCode('SIGINT')).toBe(130)
  })

  it('falls back to 130 for unknown signal names', () => {
    expect(signalExitCode('SIGNOTREAL')).toBe(130)
  })
})

describe('runPersistent', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-persistent-runner-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('resolves ready when the marker arrives without a trailing newline', async () => {
    // Prompt-style banner: no newline after the marker, child stays
    // alive. Line-by-line-only matching would hang here forever.
    const spawn = runPersistent({
      command: `printf 'Listening on :3000'; sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening on',
    })
    try {
      const settled = await Promise.race([
        spawn.ready.then(() => 'ready'),
        Bun.sleep(3_000).then(() => 'timed out'),
      ])
      expect(settled).toBe('ready')
      expect(spawn.bufferedStdout()).toContain('Listening on :3000')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }, 8_000)

  it('stops buffering once ready has resolved (buffers capture up to ready only)', async () => {
    // A kept-alive dev server streams for hours; the buffers' contract is
    // "captured up to the moment ready resolved" — later output must keep
    // flowing to the live callbacks WITHOUT accreting into vx's heap.
    const live: string[] = []
    const spawn = runPersistent({
      command: `printf 'server ready\\n'; sleep 0.2; printf 'later chatter\\n'; sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'server ready',
      onStdout: (c) => live.push(c),
    })
    try {
      await spawn.ready
      const deadline = Date.now() + 3_000
      while (!live.join('').includes('later chatter') && Date.now() < deadline) {
        await Bun.sleep(25)
      }
      expect(live.join('')).toContain('later chatter')
      expect(spawn.bufferedStdout()).toContain('server ready')
      expect(spawn.bufferedStdout()).not.toContain('later chatter')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }, 8_000)

  it('matches a marker split across chunks within one line', async () => {
    const spawn = runPersistent({
      command: `printf 'Listen'; sleep 0.15; printf 'ing on :3000'; sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening on',
    })
    try {
      const settled = await Promise.race([
        spawn.ready.then(() => 'ready'),
        Bun.sleep(3_000).then(() => 'timed out'),
      ])
      expect(settled).toBe('ready')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }, 8_000)

  it('still matches a marker on a complete newline-terminated line', async () => {
    const spawn = runPersistent({
      command: `echo 'Local: http://localhost:5173'; sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Local:',
    })
    try {
      const settled = await Promise.race([
        spawn.ready.then(() => 'ready'),
        Bun.sleep(3_000).then(() => 'timed out'),
      ])
      expect(settled).toBe('ready')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }, 8_000)

  it('rejects ready when the child exits before the marker appears', async () => {
    const spawn = runPersistent({
      command: 'echo nope; exit 1',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening',
    })
    await expect(spawn.ready).rejects.toThrow(/exited before becoming ready/)
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

describe('resourceUsageToCpuRss — peak RSS unit per platform', () => {
  // maxRSS's unit differs by OS: Linux returns kilobytes, macOS/BSD bytes.
  // Treating macOS's byte value as KB inflates peak RSS by 1024×.
  // Only the fields the converter reads; cast through unknown for the rest.
  const usage = {
    cpuTime: { total: 1_500_000n },
    maxRSS: 480_000, // raw ru_maxrss
  } as unknown as Parameters<typeof resourceUsageToCpuRss>[0]

  it('Linux: maxRSS is kilobytes → ×1024 to bytes', async () => {
    const r = resourceUsageToCpuRss(usage, 'linux')
    expect(r.peakRssBytes).toBe(480_000 * 1024)
    expect(r.cpuMs).toBe(1500)
  })

  it('macOS: maxRSS is already bytes → no multiply', async () => {
    const r = resourceUsageToCpuRss(usage, 'darwin')
    expect(r.peakRssBytes).toBe(480_000)
  })

  it('Windows: PeakWorkingSetSize is bytes → no multiply', async () => {
    const r = resourceUsageToCpuRss(usage, 'win32')
    expect(r.peakRssBytes).toBe(480_000)
  })
})
