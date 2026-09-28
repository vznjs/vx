// `procfsIsOwn()` decides whether `/proc/<pid>` names OUR children: under
// the sandbox's nested pid namespace it does not (vx is pid 2 while
// `/proc/self` names 7), and every process-lifecycle read that asks it
// takes another route. Its verdict inverted passed the suite (E-15's
// sweep), so it is held here against a second reading of the same procfs:
// the pid field of `/proc/self/stat` is what that mount thinks our pid is.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
// A fresh instance: run-lock-fs.test.ts mocks `procfsIsOwn` for its whole
// process, and a shard that deals both files here read the mock (shard 2,
// 2026-09-28).
const REAL: string = '../src/util/procfs.js?real'
const { procfsIsOwn } = (await import(REAL)) as typeof import('../src/util/procfs.js')

/** Our pid as `/proc` reports it, or undefined where there is no procfs. */
function procfsPid(): number | undefined {
  try {
    return Number(readFileSync('/proc/self/stat', 'utf8').split(' ')[0])
  } catch {
    return undefined
  }
}

describe('procfsIsOwn', () => {
  it("says yes exactly when /proc's own record of this process carries our pid", () => {
    expect(procfsIsOwn()).toBe(process.platform === 'linux' && procfsPid() === process.pid)
  })
})
