// Linux reports a refused `openat` with its flags, and the parse dropped
// them: the fix judged read or write by whether the host had the file, so
// `cat optional.cfg 2>/dev/null` suggested a WRITE grant, and applying it
// made vx create an empty placeholder there (2026-11-06).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { resolveSandboxConfig } from '../src/exec/index.js'
import { parseStraceViolations, refusedWrites } from '../src/exec/sandbox-violations.js'
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
  return sandboxFix(violations, dir, dir)
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

// strace never sees an `openat2`: SRT's write observer takes each one, read
// or write, since its flags lie in a struct the seccomp filter cannot read,
// and its record carries no flags. Every one was judged a write: a granted
// `openat2(O_RDONLY)` read failed a clean task as `a write no grant covers`
// with `write: ['deep/']` as the fix (2026-11-07).
it.skipIf(process.platform !== 'linux')(
  'an openat2 record is a read or a write: skipped where the sandbox can read, else named for a read',
  () => {
    const file = path.join(dir, 'src', 'i.js')
    expect(refusedWrites([`deny openat2 ${file}`], [], [], [path.join(dir, 'src')])).toEqual([])
    const v = refusedWrites([`deny openat2 ${file}`], [])
    expect(v.map((x) => [x.line, x.ignorable])).toEqual([
      [`openat2(${file}) = an open no grant covers  [${file}]`, ['read', 'write']],
    ])
    expect(sandboxFix(v, dir, dir)).toEqual({ read: ['src/i.js'] })
    // Under a directory a file grant widened: a granted read there too.
    const widened = {
      entries: new Map([[dir, new Set([path.join(dir, 'src')])]]),
      granted: [path.join(dir, 'out.txt')],
    }
    expect(refusedWrites([`deny openat2 ${file}`], [dir], [], [dir], widened)).toEqual([])
    expect(refusedWrites([`deny openat2 ${file}`], [dir], [], [], widened)).toHaveLength(1)
  },
)

// `tsc -b` touches an up-to-date dependency's buildinfo (`utimensat`) when
// its sources are newer than it — a branch switched and back, the
// dependency a hit — and swallows the refusal. Judged a write, the
// dependant failed every run until `--force` (tsref repro1, 2026-11-12).
// On a path the sandbox shows read-only, a timestamp change landed nothing.
it.skipIf(process.platform !== 'linux')(
  'a refused timestamp change where the sandbox can read is no violation; one elsewhere, or a write there, is',
  () => {
    const file = path.join(dir, 'src', 'i.js')
    const readable = [path.join(dir, 'src')]
    expect(refusedWrites([`deny utimensat ${file}`], [], [], readable)).toEqual([])
    expect(refusedWrites([`deny utimensat ${file}`], []).map((v) => v.line)).toEqual([
      `utimensat(${file}) = a write no grant covers  [${file}]`,
    ])
    expect(refusedWrites([`deny openat ${file}`], [], [], readable).map((v) => v.line)).toEqual([
      `openat(${file}) = a write no grant covers  [${file}]`,
    ])
    // `touch` opens for writing first (GNU without `-c`, uutils always),
    // then, refused, sets the times by path: one touch, no write.
    const touch = (p: string) => [`deny openat ${p}`, `deny utimensat ${p}`]
    expect(refusedWrites(touch(file), [], [], readable)).toEqual([])
    // A file it would have created is no touch of what is there.
    const made = path.join(dir, 'src', 'new.js')
    expect(refusedWrites(touch(made), [], [], readable).map((v) => v.line)).toEqual([
      `openat(${made}) = a write no grant covers  [${made}]`,
      `utimensat(${made}) = a write no grant covers  [${made}]`,
    ])
  },
)
