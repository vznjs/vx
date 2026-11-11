// `groupAlive` reads /proc to tell a live group member from a zombie, and
// only where /proc is this process's own namespace (`procfsIsOwn()`); a
// sandboxed shard's /proc is another namespace's, where the group signal
// answers instead. So this row runs in the unsafe suite, unsandboxed, the
// one place the parse is what decides.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { type Child, groupAlive, killTree, untilGroupsGone } from '../src/exec/kill-tree.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-kill-tree-proc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('untilGroupsGone reading /proc', () => {
  it.skipIf(process.platform !== 'linux')(
    "a live member whose name holds ') Z' is read as live, not as a zombie",
    async () => {
      // /proc/<pid>/stat is `<pid> (<comm>) <state> <ppid> <pgrp> …`, and
      // comm is whatever the executable is called. Named `a) Z 9 9`, a
      // parse from the FIRST ')' reads state Z and calls a TERM-ignoring
      // member dead, so it would never get the SIGKILL.
      // A script, not a link to `sleep`: uutils (Ubuntu 26) is one binary
      // that picks its tool by the name it runs as, and exited at once.
      // A script's process takes the script's name as its comm.
      const script = path.join(dir, 'a) Z 9 9')
      writeFileSync(script, '#!/bin/sh\ntrap "" TERM\nsleep 30\n', { mode: 0o755 })
      const child = Bun.spawn([script], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      try {
        // The name is there once the exec is: Bun.spawn may return before
        // it, and a read then saw the forked `bun` (2 of 200 under load).
        // The TERM is ignored once the script's trap ran (bit 15 of SigIgn),
        // and only then may it be sent.
        const named = (): boolean =>
          readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim() === 'a) Z 9 9'
        const deadline = Date.now() + 5_000
        while (!named()) {
          if (Date.now() > deadline) throw new Error('the member never took its name')
          await Bun.sleep(5)
        }
        const ignoresTerm = (): boolean => {
          const m = /^SigIgn:\s*([0-9a-f]+)$/m.exec(
            readFileSync(`/proc/${child.pid}/status`, 'utf8'),
          )
          return m !== null && (BigInt(`0x${m[1]}`) & (1n << 14n)) !== 0n
        }
        while (!ignoresTerm()) {
          if (Date.now() > deadline) throw new Error('the member never ignored TERM')
          await Bun.sleep(5)
        }
        killTree(child, 'SIGTERM')
        expect(await untilGroupsGone([child], 200)).toEqual([child])
      } finally {
        killTree(child, 'SIGKILL')
        await child.exited
      }
    },
  )

  // A group whose last member died waits as a zombie until its parent reaps
  // it: an orphan's init took 1 to 2 s (2026-09-24), and `kill -0` counts it
  // live, so a shutdown that asked the group signal sat that out. Here the
  // parent is a `sleep` that never reaps, so the zombie stays put and the
  // read is decided by state, not by how long the reap takes.
  it.skipIf(process.platform !== 'linux')('a group of one zombie is gone', async () => {
    const pidFile = path.join(dir, 'zombie.pid')
    const parent = Bun.spawn(
      ['sh', '-c', `setsid sh -c 'echo $$ > "$0"' ${JSON.stringify(pidFile)} & exec sleep 30`],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
    try {
      const state = (pid: number): string | undefined => {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
          return stat.slice(stat.lastIndexOf(')') + 2).split(' ', 1)[0]
        } catch {
          return undefined
        }
      }
      const deadline = Date.now() + 10_000
      let pid = 0
      while (pid === 0 || state(pid) !== 'Z') {
        if (Date.now() > deadline) throw new Error(`no zombie (pid ${pid}, state ${state(pid)})`)
        try {
          pid = Number(readFileSync(pidFile, 'utf8').trim())
        } catch {}
        await Bun.sleep(5)
      }
      // CONTROL: the group signal still answers for it.
      expect(() => process.kill(-pid, 0)).not.toThrow()
      expect(groupAlive({ pid } as Child)).toBe(false)
    } finally {
      parent.kill('SIGKILL')
      await parent.exited
    }
  })
})
