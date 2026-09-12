import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cgroupMemoryLimitBytes, machineMemoryBytes } from '../src/memory-limit.js'

const GiB = 1024 ** 3
/** What an unlimited v1 level writes (PAGE_COUNTER_MAX × 4 KiB). */
const V1_UNLIMITED = '9223372036854771712'

describe('cgroupMemoryLimitBytes', () => {
  // Fixture cgroup trees under a temp root, so the reader is pinned on
  // both hierarchies whatever this machine runs — and the machine itself
  // is read once below, as a boundary check that cannot throw.
  let root: string
  let membership: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vx-cgroup-'))
    membership = path.join(root, 'proc-self-cgroup')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const file = (rel: string, content: string): void => {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  it('v2: the tightest limit on the path to the root binds, `max` binds nothing', () => {
    file('cgroup.controllers', 'cpu memory\n')
    file('memory.max', 'max\n')
    file('a/memory.max', `${8 * GiB}\n`)
    file('a/b/memory.max', 'max\n')
    file('a/b/c/memory.max', `${12 * GiB}\n`)
    writeFileSync(membership, '0::/a/b/c\n')
    // The 8 GiB two levels up binds, not the 12 GiB on the leaf.
    expect(cgroupMemoryLimitBytes({ root, procSelfCgroup: membership })).toBe(8 * GiB)
  })

  it('v2: every level unlimited → undefined', () => {
    file('cgroup.controllers', 'memory\n')
    file('memory.max', 'max\n')
    file('a/memory.max', 'max\n')
    writeFileSync(membership, '0::/a\n')
    expect(cgroupMemoryLimitBytes({ root, procSelfCgroup: membership })).toBeUndefined()
  })

  it("v1: the memory controller's mount, the unlimited sentinel binds nothing", () => {
    // This container's shape (2026-09-12): a v1 hierarchy, the process a
    // few levels down, every level at the sentinel — and a limit on an
    // ancestor when one exists.
    file('memory/memory.limit_in_bytes', `${V1_UNLIMITED}\n`)
    file('memory/job/memory.limit_in_bytes', `${4 * GiB}\n`)
    file('memory/job/step/memory.limit_in_bytes', `${V1_UNLIMITED}\n`)
    writeFileSync(
      membership,
      ['9:name=systemd:/', '4:memory:/job/step', '1:cpu,cpuacct:/', ''].join('\n'),
    )
    expect(cgroupMemoryLimitBytes({ root, procSelfCgroup: membership })).toBe(4 * GiB)
  })

  it('v1: a combined controller list still names memory', () => {
    file('memory/memory.limit_in_bytes', `${2 * GiB}\n`)
    writeFileSync(membership, '3:cpu,memory:/\n')
    expect(cgroupMemoryLimitBytes({ root, procSelfCgroup: membership })).toBe(2 * GiB)
  })

  it('v1: sentinel everywhere → undefined', () => {
    file('memory/memory.limit_in_bytes', `${V1_UNLIMITED}\n`)
    file('memory/x/memory.limit_in_bytes', `${V1_UNLIMITED}\n`)
    writeFileSync(membership, '4:memory:/x\n')
    expect(cgroupMemoryLimitBytes({ root, procSelfCgroup: membership })).toBeUndefined()
  })

  it('no membership file, or no cgroup files → undefined, never a throw', () => {
    expect(
      cgroupMemoryLimitBytes({ root, procSelfCgroup: path.join(root, 'absent') }),
    ).toBeUndefined()
    writeFileSync(membership, '0::/a/b\n')
    expect(cgroupMemoryLimitBytes({ root, procSelfCgroup: membership })).toBeUndefined()
  })

  it('a membership path that escapes the root is not walked', () => {
    file('memory.max', `${1 * GiB}\n`)
    writeFileSync(membership, '0::/../../\n')
    expect(cgroupMemoryLimitBytes({ root, procSelfCgroup: membership })).toBeUndefined()
  })

  it('reads THIS machine without throwing, never above the total', () => {
    const limit = cgroupMemoryLimitBytes()
    if (limit !== undefined) expect(limit).toBeGreaterThan(64 * 1024 * 1024)
    expect(machineMemoryBytes()).toBeLessThanOrEqual(os.totalmem())
    expect(machineMemoryBytes()).toBeGreaterThan(0)
  })
})

describe('machineMemoryBytes', () => {
  it('is the total capped by the cgroup limit, on Linux', () => {
    if (process.platform !== 'linux') return
    const root = mkdtempSync(path.join(os.tmpdir(), 'vx-cgroup-'))
    try {
      const membership = path.join(root, 'proc-self-cgroup')
      mkdirSync(path.join(root, 'memory'), { recursive: true })
      writeFileSync(path.join(root, 'memory', 'memory.limit_in_bytes'), `${1 * GiB}\n`)
      writeFileSync(membership, '4:memory:/\n')
      expect(machineMemoryBytes({ root, procSelfCgroup: membership })).toBe(
        Math.min(os.totalmem(), 1 * GiB),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
