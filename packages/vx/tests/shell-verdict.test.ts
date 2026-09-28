// The shell's 127 and 126 name the word and nothing about why (items 257,
// 258): a bare word is a PATH lookup and the PATH is vx's; a word with a
// slash is a file, and the file says why — probed 2026-09-16 under dash and
// bash 5: a missing `#!` interpreter and a CRLF line are "not found" (127)
// blamed on the file, a directory, a file without the execute bit and one
// with no `#!` line are "cannot execute" (126).
import { readFileSync } from 'node:fs'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { shellVerdict } from '../src/orchestrator/shell-verdict.js'

const bins = ['/ws/packages/app/node_modules/.bin', '/ws/node_modules/.bin']
const signalNumber = os.constants.signals as Record<string, number>
let cwd: string
beforeAll(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-shell-verdict-')))
  await writeFile(path.join(cwd, 'shebang.sh'), '#!/nonexistent/interp -x\necho hi\n')
  await writeFile(path.join(cwd, 'crlf.sh'), '#!/bin/sh\r\necho hi\r\n')
  await writeFile(path.join(cwd, 'fine.sh'), '#!/bin/sh\necho hi\n')
  await writeFile(path.join(cwd, 'noexec.sh'), '#!/bin/sh\necho hi\n')
  await writeFile(path.join(cwd, 'blob'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]))
  await writeFile(path.join(cwd, 'noeol.sh'), '#!/nonexistent/interp')
  await writeFile(path.join(cwd, 'tab.sh'), '#!/nonexistent/interp\t-x\necho hi\n')
  await writeFile(path.join(cwd, 'space.sh'), '#! /nonexistent/interp\necho hi\n')
  await writeFile(path.join(cwd, 'space-ok.sh'), '#! /bin/sh\necho hi\n')
  await writeFile(path.join(cwd, 'relative.sh'), '#!no-such-relative-interp\necho hi\n')
  await writeFile(path.join(cwd, 'typo.sh'), '#/nonexistent/interp\necho hi\n')
  await writeFile(path.join(cwd, 'long.sh'), `#!/bin/sh ${'é'.repeat(300)}\necho hi\n`)
  await mkdir(path.join(cwd, 'interp-é'))
  await symlink('/bin/sh', path.join(cwd, 'interp-é', 'sh'))
  await writeFile(path.join(cwd, 'utf8.sh'), `#!${cwd}/interp-é/sh\necho hi\n`)
  await mkdir(path.join(cwd, 'dir'))
  for (const f of [
    'shebang.sh',
    'crlf.sh',
    'fine.sh',
    'blob',
    'noeol.sh',
    'tab.sh',
    'space.sh',
    'space-ok.sh',
    'relative.sh',
    'typo.sh',
    'long.sh',
    'utf8.sh',
  ]) {
    await chmod(path.join(cwd, f), 0o755)
  }
  await chmod(path.join(cwd, 'noexec.sh'), 0o644)
  await writeFile(path.join(cwd, 'groupexec.sh'), '#!/bin/sh\necho hi\n')
  await chmod(path.join(cwd, 'groupexec.sh'), 0o654)
  // Executable, unreadable: the owner passes the X_OK question and is
  // refused the read (root reads anything, so its row skips as root).
  await writeFile(path.join(cwd, 'noread.sh'), '#!/bin/sh\necho hi\n')
  await chmod(path.join(cwd, 'noread.sh'), 0o111)
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

  // Only the owner's bit counts for the owner: 0o654 gives the group and
  // others execute but not this user, and the shell refuses it.
  it.skipIf(skipAsRoot('126 on a file only the group may execute says chmod'))(
    '126 on a file only the group may execute says chmod',
    () => {
      expect(verdict(126, './groupexec.sh')).toBe(
        `[vx] exit 126 is the shell's "cannot execute": ./groupexec.sh is not executable — chmod +x it`,
      )
    },
  )

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

  // C-33: the #! line is read the way the kernel reads it.
  it('a #! line with no newline keeps its last character', () => {
    expect(verdict(127, './noeol.sh')).toBe(
      `[vx] exit 127 is the shell's "not found": ./noeol.sh exists, and its #! interpreter /nonexistent/interp does not — install it or fix the line`,
    )
  })

  it('a tab ends the interpreter as a space does', () => {
    expect(verdict(127, './tab.sh')).toBe(
      `[vx] exit 127 is the shell's "not found": ./tab.sh exists, and its #! interpreter /nonexistent/interp does not — install it or fix the line`,
    )
  })

  it('a space after #! is not part of the interpreter', () => {
    expect(verdict(127, './space.sh')).toBe(
      `[vx] exit 127 is the shell's "not found": ./space.sh exists, and its #! interpreter /nonexistent/interp does not — install it or fix the line`,
    )
    expect(verdict(126, './space-ok.sh')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": ./space-ok.sh exists and is executable, and the shell still could not run it — check its #! line (/bin/sh)`,
    )
  })

  // The kernel resolves a relative interpreter from the task's directory,
  // not vx's: the line shows it and does not guess.
  it('a relative #! interpreter is not looked up from vx', () => {
    expect(verdict(126, './relative.sh')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": ./relative.sh exists and is executable, and the shell still could not run it — check its #! line (no-such-relative-interp)`,
    )
  })

  it('a # without the ! is no #! line', () => {
    expect(verdict(126, './typo.sh')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": ./typo.sh has no #! line, so it ran as a binary the loader refused — add a #! line or build it for this platform`,
    )
  })

  // 256 bytes, as the kernel reads: 10 of `#!/bin/sh ` and 123 two-byte é.
  it('only the first 256 bytes of the file are read', () => {
    expect(verdict(126, './long.sh')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": ./long.sh exists and is executable, and the shell still could not run it — check its #! line (/bin/sh ${'é'.repeat(123)})`,
    )
  })

  // The kernel takes the #! path as bytes and the file system names it in
  // UTF-8; a latin1 read named a present interpreter missing.
  it('a non-ASCII #! interpreter that exists is found', () => {
    expect(verdict(126, './utf8.sh')).toBe(
      `[vx] exit 126 is the shell's "cannot execute": ./utf8.sh exists and is executable, and the shell still could not run it — check its #! line (${cwd}/interp-é/sh)`,
    )
  })

  it.skipIf(skipAsRoot('a file that exists and refuses a read names the refusal'))(
    'a file that exists and refuses a read names the refusal',
    () => {
      let message = ''
      try {
        readFileSync(path.join(cwd, 'noread.sh'))
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).not.toBe('')
      expect(verdict(126, './noread.sh')).toBe(
        `[vx] exit 126 is the shell's "cannot execute": ./noread.sh could not be read (${message})`,
      )
    },
  )

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

  // Each named signal's line, whole; SIGINT through the code alone, since
  // the runner's own SIGINT is the abort path's.
  it('every named signal has its own reason', () => {
    const why: [string, string][] = [
      [
        'SIGBUS',
        'the program crashed in native code (a native module, or the runtime itself) — re-run the command by hand to reproduce',
      ],
      [
        'SIGILL',
        'the program crashed in native code (a native module, or the runtime itself) — re-run the command by hand to reproduce',
      ],
      [
        'SIGFPE',
        'the program crashed in native code (a native module, or the runtime itself) — re-run the command by hand to reproduce',
      ],
      [
        'SIGTRAP',
        "the program hit a breakpoint or a trap instruction — a debugger, or a runtime's fatal check",
      ],
      [
        'SIGHUP',
        'the process lost its controlling terminal or session (a hangup, a closed SSH session)',
      ],
      ['SIGXCPU', "a CPU-time limit (ulimit -t, or a sandbox's) was hit"],
      ['SIGXFSZ', 'a file-size limit (ulimit -f) was hit'],
      ['SIGSYS', 'a system call was refused — a seccomp filter, or the sandbox'],
      [
        'SIGQUIT',
        'the process was sent a quit (Ctrl-\\, or a kill -QUIT); a core dump may be beside it',
      ],
      ['SIGUSR1', 'the process was killed by that signal'],
    ]
    for (const [signal, reason] of why) {
      const num = signalNumber[signal]!
      expect(shellVerdict({ code: 128 + num, command: 'x', cwd, bins, signal })).toBe(
        `[vx] exit ${128 + num} is how the shell reports a death by ${signal} (${num}): ${reason}`,
      )
    }
    expect(verdict(130, 'x')).toBe(
      `[vx] exit 130 is 128 + 2, the shell's report of a death by SIGINT in the last command (or that command exited 130 itself): something outside vx interrupted the process (a Ctrl-C reaching it, a kill -INT)`,
    )
  })

  it('a signal name the platform does not know gets no line', () => {
    expect(
      shellVerdict({ code: 137, command: 'x', cwd, bins, signal: 'SIGNOTREAL' }),
    ).toBeUndefined()
  })

  it('an unknown signal number above the table still names nothing false', () => {
    expect(verdict(128 + 64, 'x')).toBeUndefined()
    expect(verdict(200, 'x')).toBeUndefined()
  })
})
