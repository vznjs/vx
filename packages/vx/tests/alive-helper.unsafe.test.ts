// The helper every kill test trusts, tested on its own.
//
// `isAlive` is the answer to "is the child dead yet" for the abort, signal,
// keep-alive and task-tree suites, and its failure mode is SILENT: a helper
// that answers "dead" too eagerly turns every one of those waits green
// without a child ever having died. The claim it exists for — a zombie is
// dead, though signal 0 still lands on it — was measured, not assumed (it
// was two thirds of the signal-handling suite's wall time), and nothing
// held the helper to it.
//
// The zombie is built the way the kernel makes them: a shell backgrounds a
// child that exits immediately and then `exec`s, so the parent can never
// wait and the entry stays in the table until that parent dies.
//
// `.unsafe`: a sandbox cannot host this one. The runtime gives the task its
// own PID namespace with its own `/proc`, and the pid the shell prints does
// not name the same process there — a probe inside the gate's sandbox read
// `child pid 8` while `/proc/8/stat` said `8 (bun) S`, with the task itself
// at pid 2 under a pid-1 `bwrap`. The row simply cannot observe a zombie
// through that mount, which is the same reason the sandbox's own suites and
// the cross-project law live out here.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'

describe('isAlive', () => {
  it('is true for a running child and false once it is gone', async () => {
    const child = Bun.spawn(['sleep', '30'])
    expect(isAlive(child.pid)).toBe(true)
    child.kill('SIGKILL')
    expect(await waitForDead(child.pid, 2_000)).toBe(true)
    expect(isAlive(child.pid)).toBe(false)
  })

  it('is false for a pid nothing owns', () => {
    // Past any `pid_max` a kernel hands out (the default is 4 194 304), so
    // this needs no spawn and cannot race a recycled pid.
    expect(isAlive(0x7fff_fffe)).toBe(false)
  })

  it.skipIf(process.platform !== 'linux')(
    'is false for a ZOMBIE, which signal 0 still lands on',
    async () => {
      // `sleep 0 &` exits at once and the shell then `exec`s, so the parent
      // is now a `sleep` that will never wait: the entry cannot be reaped
      // while it lives. Leaving bash in place instead is not deterministic —
      // it reaped the child inside the gate's sandbox, and the read came
      // back ENOENT.
      //
      // The pid travels through a FILE, not a pipe: the first version read
      // one chunk off `shell.stdout` and left the stream open, and that row
      // failed twice under the gate's parallel load while passing alone
      // every time. An unread pipe is a lifetime this test does not control;
      // with `stdout: 'ignore'` there is none.
      const dir = mkdtempSync(path.join(tmpdir(), 'vx-zombie-'))
      const pidFile = path.join(dir, 'pid')
      const shell = Bun.spawn(['bash', '-c', `sleep 0 & echo $! > "${pidFile}"; exec sleep 30`], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      try {
        let pid = 0
        for (let i = 0; i < 400 && pid === 0; i++) {
          // The file appears only once the shell has run its first line.
          const raw = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : ''
          if (raw !== '') pid = Number(raw)
          else await Bun.sleep(5)
        }
        expect({ pidRead: Number.isInteger(pid) && pid > 0 }).toEqual({ pidRead: true })
        // The premise, asserted rather than assumed: the parent must still be
        // alive, because it is what keeps the entry unreaped.
        expect({ parentAlive: isAlive(shell.pid) }).toEqual({ parentAlive: true })
        let stat = ''
        for (let i = 0; i < 400; i++) {
          // A vanished entry means something reaped it after all, which the
          // assertion below must report as itself rather than as an ENOENT
          // stack from the reader.
          stat = await Bun.file(`/proc/${pid}/stat`)
            .text()
            .catch(() => '() reaped')
          if (stat.charAt(stat.lastIndexOf(')') + 2) === 'Z') break
          await Bun.sleep(5)
        }
        expect({ state: stat.charAt(stat.lastIndexOf(')') + 2) }).toEqual({ state: 'Z' })
        // The blind spot the helper exists for, both halves in one place.
        expect(() => process.kill(pid, 0)).not.toThrow()
        expect(isAlive(pid)).toBe(false)
        expect(await waitForDead(pid, 100)).toBe(true)
      } finally {
        shell.kill('SIGKILL')
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
