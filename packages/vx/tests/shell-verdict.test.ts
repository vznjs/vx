// The shell's 127 and 126 name the word and nothing about why (items 257,
// 258): a bare word is a PATH lookup and the PATH is vx's; a word with a
// slash is a file, and "not found" for a file that exists is its `#!`
// interpreter — the shell's own line blames the file.
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
  await writeFile(path.join(cwd, 'blob'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]))
  await mkdir(path.join(cwd, 'dir'))
  for (const f of ['shebang.sh', 'crlf.sh', 'blob']) await chmod(path.join(cwd, f), 0o755)
})
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function verdict(code: number, command: string): string | undefined {
  return shellVerdict({ code, command, cwd, bins })
}

describe('shellVerdict', () => {
  it('says nothing for any other exit', () => {
    for (const code of [0, 1, 2, 125, 128, 130, 143]) {
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

  it('127 on a path that does not exist names the resolved path', () => {
    expect(verdict(127, './missing.sh')).toBe(
      `[vx] exit 127 is the shell's "not found": ./missing.sh does not exist — looked for ${path.join(cwd, 'missing.sh')}, relative to the task's working directory`,
    )
  })

  it('127 on a file that exists names its #! interpreter, not the PATH', () => {
    const v = verdict(127, './shebang.sh --flag')
    expect(v).toBe(
      `[vx] exit 127 is the shell's "not found", and ./shebang.sh exists: its #! interpreter /nonexistent/interp does not exist — install it or fix the line`,
    )
    expect(v).not.toContain('PATH')
  })

  it('127 on a CRLF script names the carriage return', () => {
    expect(verdict(127, './crlf.sh')).toBe(
      `[vx] exit 127 is the shell's "not found", and ./crlf.sh exists: its #! line ends in CRLF, so the interpreter the shell looked for is "/bin/sh\\r" — convert the file to LF line endings`,
    )
  })

  it('127 on a file with no #! line says so', () => {
    expect(verdict(127, 'bin/../blob')).toContain('and bin/../blob exists: it has no #! line')
  })

  it('126 names the word and the fix', () => {
    expect(verdict(126, './dir')).toBe(
      `[vx] exit 126 is the shell's "found but cannot execute": ./dir is not executable or is a directory — chmod +x it`,
    )
    expect(verdict(126, 'tsc')).toContain('tsc is not executable or is a directory')
  })
})
