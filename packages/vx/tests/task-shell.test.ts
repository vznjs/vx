// Which `sh` parses a task's command. A task's PATH leads with its project's
// `node_modules/.bin` (execute-task's bin paths), and Bun resolved the bare
// `sh` of the spawn against THAT PATH: a dependency shipping a `sh` bin
// became the interpreter of every command in its project. The shell is
// resolved on vx's own PATH now (util/which.ts); the task's PATH still
// decides what the command itself resolves, inside that shell.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCommand, runPersistent } from '../src/exec/runner.js'

describe("a task's PATH decides its command, never its shell", () => {
  let cwd: string
  let env: Record<string, string>

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-task-shell-'))
    const bin = path.join(cwd, 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    // Absolute shebangs: neither script may resolve anything through PATH.
    await writeFile(path.join(bin, 'sh'), '#!/bin/sh\necho hijacked\n')
    await writeFile(path.join(bin, 'vx-own-tool'), '#!/bin/sh\necho tool ran\n')
    await chmod(path.join(bin, 'sh'), 0o755)
    await chmod(path.join(bin, 'vx-own-tool'), 0o755)
    env = { PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` }
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it("runCommand: a node_modules/.bin/sh does not run the command; the bin's tool does", async () => {
    const shell = await runCommand({ command: 'echo parsed by the real shell', cwd, env })
    expect(shell.stdout).toBe('parsed by the real shell\n')
    // CONTROL: the same PATH resolves the command's own word from the bin.
    const tool = await runCommand({ command: 'vx-own-tool', cwd, env })
    expect(tool.stdout).toBe('tool ran\n')
  })

  it('runPersistent: the same shell', async () => {
    const out: string[] = []
    const spawn = runPersistent({
      command: 'echo parsed by the real shell; vx-own-tool',
      cwd,
      env,
      readyWhen: 'tool ran',
      onStdout: (c) => out.push(c),
    })
    try {
      await spawn.ready
      expect(out.join('')).toStartWith('parsed by the real shell\ntool ran')
    } finally {
      await spawn.child.exited
    }
  })

  // CONTROL, on vx's own PATH: passes before the change and after it.
  it('$0 is still `sh`: the absolute path is spawned under its old name', async () => {
    const r = await runCommand({
      command: 'echo "$0"',
      cwd,
      env: { PATH: process.env['PATH'] ?? '' },
    })
    expect(r.stdout).toBe('sh\n')
  })
})
