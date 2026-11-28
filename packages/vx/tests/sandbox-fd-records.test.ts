// SRT's Linux write observer records strace's own log as `deny openat
// /dev/fd/5`, and `refusedWrites` resolved that path in vx's process: a
// vx started with `5>out.log` in a single-package workspace reported a
// write to `out.log` and failed a clean sandboxed task (2026-10-02).
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { observedWrites, refusedWrites } from '../src/sandbox/violations.js'

describe.skipIf(process.platform !== 'linux')('a write record naming a descriptor', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-fd-rec-')))
  const fd = openSync(path.join(dir, 'out.log'), 'w')
  afterAll(() => {
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  })

  it("is not resolved through vx's own descriptor table", () => {
    expect(
      refusedWrites(
        [`deny openat /dev/fd/${fd}`, `deny openat /proc/self/fd/${fd}`, 'deny openat /dev/null'],
        [],
      ),
    ).toEqual([])
  })

  it('CONTROL: a write to the same file by its path is reported', () => {
    expect(refusedWrites([`deny openat ${dir}/out.log`], []).map((v) => v.line)).toEqual([
      `openat(${dir}/out.log) = a write no grant covers  [${dir}/out.log]`,
    ])
  })
})

// A write record's path may hold a newline (vx-observe escapes it, and
// `observedWrites` decodes it back), and the record's parse read a path
// only up to its first one: `mkdir "$(printf 'a\nb')"` refused by the
// sandbox failed the task with no violation named (2026-11-23).
describe.skipIf(process.platform !== 'linux')('a write record whose path holds a newline', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-nl-rec-')))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('is reported with its whole path', () => {
    const records = observedWrites(`W mkdir "${dir}/new\\nl"\nW mkdir "${dir}/ta\\tb"\n`)
    expect(records).toEqual([`deny mkdir ${dir}/new\nl`, `deny mkdir ${dir}/ta\tb`])
    expect(refusedWrites(records, []).map((v) => v.path)).toEqual([`${dir}/new\nl`, `${dir}/ta\tb`])
  })
})

// A write through a dangling link creates the link's target, and the
// record names the link: judged there, `esc -> /tmp/x` read as a write
// in the project, and the fix granted `esc`, which the lock then refused
// as resolving out of the project (2026-11-28).
describe.skipIf(process.platform !== 'linux')('a write record through a dangling link', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-dangle-rec-')))
  symlinkSync(path.join(dir, 'away', 'target'), path.join(dir, 'esc'))
  mkdirSync(path.join(dir, 'away'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("is judged at the link's target", () => {
    expect(refusedWrites([`deny openat ${dir}/esc`], []).map((v) => v.path)).toEqual([
      `${dir}/away/target`,
    ])
  })

  it('CONTROL: an unlink of the link itself is judged at the link', () => {
    expect(refusedWrites([`deny unlink ${dir}/esc`], []).map((v) => v.path)).toEqual([`${dir}/esc`])
  })
})
