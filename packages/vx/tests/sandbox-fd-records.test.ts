// SRT's Linux write observer records strace's own log as `deny openat
// /dev/fd/5`, and `refusedWrites` resolved that path in vx's process: a
// vx started with `5>out.log` in a single-package workspace reported a
// write to `out.log` and failed a clean sandboxed task (2026-10-02).
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { refusedWrites } from '../src/exec/sandbox-violations.js'

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
