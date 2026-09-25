// strace-vx.ts tells vx's own syscalls from its children's by the spawn
// tree. A spawn strace split across threads names its new pid on the
// `<... clone3 resumed>` line, and git's worker threads were counted as
// vx's until that line was read (item 753).
import { describe, expect, it } from 'bun:test'
import { countVx } from '../strace-vx.js'

const TRACE = [
  '100 execve("/usr/bin/vx", ["vx"], 0x0) = 0',
  '100 openat(AT_FDCWD, "a", O_RDONLY) = 3',
  '100 clone3({flags=CLONE_VM, ...}, 88) = 200',
  '200 execve("/usr/bin/git", ["git", "status"], 0x0) = 0',
  '200 clone3({flags=CLONE_VM|CLONE_THREAD, ...}, 88 <unfinished ...>',
  '100 openat(AT_FDCWD, "b", O_RDONLY) = 4',
  '200 <... clone3 resumed>) = 201',
  '201 newfstatat(AT_FDCWD, "x", {st_mode=S_IFREG}, 0) = 0',
  '201 newfstatat(AT_FDCWD, "y", {st_mode=S_IFREG}, 0) = 0',
  '100 clone3({flags=CLONE_VM|CLONE_THREAD, ...}, 88 <unfinished ...>',
  '100 <... clone3 resumed>) = 101',
  '101 read(3, "", 4096) = 0',
].join('\n')

describe('countVx', () => {
  it("a child's thread spawned through a resumed clone3 is the child's, not vx's", () => {
    const counts = Object.fromEntries(countVx(TRACE))
    expect(counts).toEqual({ execve: 1, openat: 2, clone3: 2, read: 1 })
  })
})
