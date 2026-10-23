// `groupAlive` reads /proc to tell a live group member from a zombie, and
// only where /proc is this process's own namespace (`procfsIsOwn()`); a
// sandboxed shard's /proc is another namespace's, where the group signal
// answers instead. So this row runs in the unsafe suite, unsandboxed, the
// one place the parse is what decides.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
        // The name is there at exec; the TERM is ignored once the script's
        // trap ran (bit 15 of SigIgn), and only then may it be sent.
        expect(readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim()).toBe('a) Z 9 9')
        const ignoresTerm = (): boolean => {
          const m = /^SigIgn:\s*([0-9a-f]+)$/m.exec(
            readFileSync(`/proc/${child.pid}/status`, 'utf8'),
          )
          return m !== null && (BigInt(`0x${m[1]}`) & (1n << 14n)) !== 0n
        }
        const deadline = Date.now() + 5_000
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
})
