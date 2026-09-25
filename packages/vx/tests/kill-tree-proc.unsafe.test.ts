// `groupAlive` reads /proc to tell a live group member from a zombie, and
// only where /proc is this process's own namespace (`procfsIsOwn()`); a
// sandboxed shard's /proc is another namespace's, where the group signal
// answers instead. So this row runs in the unsafe suite, unsandboxed, the
// one place the parse is what decides.

import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { killTree, untilGroupsGone } from '../src/exec/kill-tree.js'

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
      const link = path.join(dir, 'a) Z 9 9')
      symlinkSync(Bun.which('sleep')!, link)
      const child = Bun.spawn(['sh', '-c', 'trap "" TERM; exec "$0" 30', link], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      try {
        const comm = `/proc/${child.pid}/comm`
        const deadline = Date.now() + 5_000
        while (readFileSync(comm, 'utf8').trim() !== 'a) Z 9 9') {
          if (Date.now() > deadline) throw new Error('the member never exec’d')
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
})
