// The shell's 127 and 126 name the word and nothing about why (items 257,
// 258): a bare word is a PATH lookup and the PATH is vx's; a word with a
// slash is a file, and the file says why — probed 2026-09-16 under dash and
// bash 5: a missing `#!` interpreter and a CRLF line are "not found" (127)
// blamed on the file, a directory, a file without the execute bit and one
// with no `#!` line are "cannot execute" (126).
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { shellVerdict } from '../src/orchestrator/shell-verdict.js'

const bins = ['/ws/packages/app/node_modules/.bin', '/ws/node_modules/.bin']
let cwd: string
beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-shell-verdict-'))
  await writeFile(path.join(cwd, 'shebang.sh'), '#!/nonexistent/interp -x\necho hi\n')
  await writeFile(path.join(cwd, 'crlf.sh'), '#!/bin/sh\r\necho hi\r\n')
  await writeFile(path.join(cwd, 'fine.sh'), '#!/bin/sh\necho hi\n')
  await writeFile(path.join(cwd, 'noexec.sh'), '#!/bin/sh\necho hi\n')
  await writeFile(path.join(cwd, 'blob'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]))
  await mkdir(path.join(cwd, 'dir'))
  for (const f of ['shebang.sh', 'crlf.sh', 'fine.sh', 'blob']) {
    await chmod(path.join(cwd, f), 0o755)
  }
  await chmod(path.join(cwd, 'noexec.sh'), 0o644)
})
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function verdict(code: number, command: string): string | undefined {
  return shellVerdict({ code, command, cwd, bins })
}

describe('shellVerdict', () => {
  it('says nothing for a plain exit', () => {
    for (const code of [0, 1, 2, 125, 128, 193, 255]) {
      expect(verdict(code, './shebang.sh')).toBeUndefined()
    }
  })

  it('127 on a bare word is the PATH rule with both bin directories', () => {
    expect(verdict(127, 'tsc --version')).toBe(
      `[vx] exit 127 is the shell's "command not found": tsc is not on this task's PATH — vx puts ${bins[0]} and ${bins[1]} first and never a sibling project's bin; install it in this package or at the workspace root`,
    )
  })

  it('127 on a pipeline names no word', () => {
    expect(verdict(127, 'tsc | tee log')).toStartWith(
      `[vx] exit 127 is the shell's "command not found": a command in this task is not on this task's PATH`,
    )
  })

  it('126 on a bare word names the word and the fix', () => {
    expect(verdict(126, 'tsc')).toBe(
      `[vx] exit 126 is the shell's "found but cannot execute": tsc is not executable or is a directory — chmod +x it`,
    )
  })

  it('127 on a path that does not exist names the resolved path', () => {
    expect(verdict(127, './missing.sh')).toBe(
      `[vx] exit 127 is the shell's "not found": ./missing.sh does not exist — looked for ${path.join(cwd, 'missing.sh')}, relative to the task's working directory`,
    )
  })

  it('127 on a file that exists names its #! interpreter, not the PATH', () => {
    const v = verdict(127, './shebang.sh --flag')
    expect(v).toBe(
      `[vx] exit 127 is the shell's "not found": ./shebang.sh exists, and its #! interpreter /nonexistent/interp does not — install it or fix the line`,
    )
    expect(v).not.toContain('PATH')
  })

  it('127 on a CRLF script names the carriage return', () => {
    expect(verdict(127, './crlf.sh')).toBe(
      `[vx] exit 127 is the shell's "not found": ./crlf.sh exists, and its #! line ends in CRLF, so the interpreter the shell looked for is "/bin/sh\\r" — convert the file to LF line endings`,
    )
  })

  it('126 on a directory says so', () => {
    expect(verdict(126, './dir')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": ./dir is a directory`,
    )
  })

  it('126 on a file without the execute bit says chmod', () => {
    expect(verdict(126, './noexec.sh')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": ./noexec.sh is not executable — chmod +x it`,
    )
  })

  it('126 on a file with no #! line names the loader', () => {
    expect(verdict(126, 'bin/../blob')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": bin/../blob has no #! line, so it ran as a binary the loader refused — add a #! line or build it for this platform`,
    )
  })

  // The file reads fine (its interpreter exists): the line shows the #! and stops.
  it('a runnable-looking file gets its #! line and no guess', () => {
    expect(verdict(126, './fine.sh')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": ./fine.sh exists and is executable, and the shell still could not run it — check its #! line (/bin/sh)`,
    )
  })

  // Item 259: an exit above 128 is a signal's number; the line names the
  // signal and what sends it. The runner's own report is definite; the
  // code alone names the possibility that the command exited so itself.
  it('a SIGKILL the runner saw names the OOM killer and a kill', () => {
    expect(
      shellVerdict({ code: 137, command: 'node build.js', cwd, bins, signal: 'SIGKILL' }),
    ).toBe(
      `[vx] exit 137 is how the shell reports a death by SIGKILL (9): nothing catches it — on Linux the kernel's OOM killer (dmesg, or the memory limit of the container's cgroup) or an explicit kill; vx's own timeout reports itself as a timeout`,
    )
  })

  it('a 139 with no signal reads as SIGSEGV in the last command, or its own exit', () => {
    expect(verdict(139, 'node a.js | tee log')).toBe(
      `[vx] exit 139 is 128 + 11, the shell's report of a death by SIGSEGV in the last command (or that command exited 139 itself): the program crashed in native code (a native module, or the runtime itself) — re-run the command by hand to reproduce`,
    )
  })

  it('SIGABRT names the heap limit; SIGPIPE the reader that left', () => {
    expect(
      shellVerdict({ code: 134, command: 'node a.js', cwd, bins, signal: 'SIGABRT' }),
    ).toContain(
      "the program aborted itself — an assertion, or an allocator failure (a JS runtime's heap limit reports here)",
    )
    expect(verdict(141, 'yes | head -1')).toContain(
      'it wrote to a pipe whose reader had gone — a reader in the command left early',
    )
  })

  // CONTROL: a SIGINT/SIGTERM the runner saw is the abort path's (it reverts
  // the task to aborted); the code alone (a pipeline's last command) is not.
  it('a SIGTERM or SIGINT the runner saw gets no line; the code alone does', () => {
    expect(
      shellVerdict({ code: 143, command: 'node a.js', cwd, bins, signal: 'SIGTERM' }),
    ).toBeUndefined()
    expect(
      shellVerdict({ code: 130, command: 'node a.js', cwd, bins, signal: 'SIGINT' }),
    ).toBeUndefined()
    expect(verdict(143, 'node a.js | tee log')).toContain(
      'something outside vx asked the process to stop',
    )
  })

  it('an unknown signal number above the table still names nothing false', () => {
    expect(verdict(128 + 64, 'x')).toBeUndefined()
    expect(verdict(200, 'x')).toBeUndefined()
  })
})
