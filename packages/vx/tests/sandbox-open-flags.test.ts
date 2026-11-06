// Linux reports a refused `openat` with its flags, and the parse dropped
// them: the fix judged read or write by whether the host had the file, so
// `cat optional.cfg 2>/dev/null` suggested a WRITE grant, and applying it
// made vx create an empty placeholder there (2026-11-06).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { resolveSandboxConfig } from '../src/exec/index.js'
import { parseStraceViolations } from '../src/exec/sandbox-violations.js'
import { sandboxFix } from '../src/orchestrator/sandbox-fix.js'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-open-flags-')))
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src', 'i.js'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fixOf = async (trace: string[]) => {
  const log = path.join(dir, 'trace.log')
  writeFileSync(log, [...trace, ''].join('\n'))
  const violations = await parseStraceViolations(
    log,
    { command: 'x', cwd: dir, env: {}, config: resolveSandboxConfig({}, dir) } as never,
    { allowRead: [], denyRead: [dir], cwd: dir },
  )
  return sandboxFix(violations, dir)
}

it('grants by the flags a refused open asked for, not by whether the host has the file', async () => {
  expect(
    await fixOf([
      // Missing on the host, opened to read: a read grant, not a create.
      '1 openat(AT_FDCWD, "optional.cfg", O_RDONLY|O_CLOEXEC) = -1 ENOENT (x)',
      '2 openat(AT_FDCWD, "opt/b.cfg", O_RDONLY <unfinished ...>',
      '2 <... openat resumed>) = -1 ENOENT (x)',
      // On the host, opened to write: a write grant, not a read.
      '1 openat(AT_FDCWD, "src/i.js", O_WRONLY|O_CREAT|O_TRUNC, 0666) = -1 EACCES (x)',
      '3 openat(AT_FDCWD, "out/o.js", O_RDWR|O_CREAT <unfinished ...>',
      '3 <... openat resumed>) = -1 EACCES (x)',
    ]),
  ).toEqual({ read: ['opt/b.cfg', 'optional.cfg'], write: ['out/', 'src/'] })
})
