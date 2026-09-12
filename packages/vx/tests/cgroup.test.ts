import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  cgroupCpuQuota,
  cgroupMemoryLimitBytes,
  machineMemoryBytes,
  machineParallelism,
} from '../src/util/cgroup.js'

const GiB = 1024 ** 3
/** What an unlimited v1 memory level writes (PAGE_COUNTER_MAX × 4 KiB). */
const V1_UNLIMITED = '9223372036854771712'

// Fixture cgroup trees under a temp root pin both hierarchies whatever
// this machine runs; the machine itself is read once, as a boundary
// check that cannot throw and never exceeds what the OS reports.
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
const probe = () => ({ root, procSelfCgroup: membership })

describe('cgroupMemoryLimitBytes', () => {
  it('v2: the tightest limit on the path to the root binds, `max` binds nothing', () => {
    file('cgroup.controllers', 'cpu memory\n')
    file('memory.max', 'max\n')
    file('a/memory.max', `${8 * GiB}\n`)
    file('a/b/memory.max', 'max\n')
    file('a/b/c/memory.max', `${12 * GiB}\n`)
    writeFileSync(membership, '0::/a/b/c\n')
    // The 8 GiB two levels up binds, not the 12 GiB on the leaf.
    expect(cgroupMemoryLimitBytes(probe())).toBe(8 * GiB)
  })

  it('v2: every level unlimited → undefined', () => {
    file('memory.max', 'max\n')
    file('a/memory.max', 'max\n')
    writeFileSync(membership, '0::/a\n')
    expect(cgroupMemoryLimitBytes(probe())).toBeUndefined()
  })

  it("v1: the memory controller's mount, the unlimited sentinel binds nothing", () => {
    // This container's shape (2026-09-12): a v1 hierarchy, the process a
    // few levels down, the sentinel above and a 13.3 GiB limit on the leaf.
    file('memory/memory.limit_in_bytes', `${V1_UNLIMITED}\n`)
    file('memory/job/memory.limit_in_bytes', `${4 * GiB}\n`)
    file('memory/job/step/memory.limit_in_bytes', `${V1_UNLIMITED}\n`)
    writeFileSync(
      membership,
      ['9:name=systemd:/', '4:memory:/job/step', '1:cpu,cpuacct:/', ''].join('\n'),
    )
    expect(cgroupMemoryLimitBytes(probe())).toBe(4 * GiB)
  })

  it('v1: a combined controller list still names memory', () => {
    file('memory/memory.limit_in_bytes', `${2 * GiB}\n`)
    writeFileSync(membership, '3:cpu,memory:/\n')
    expect(cgroupMemoryLimitBytes(probe())).toBe(2 * GiB)
  })

  it('v1: sentinel everywhere → undefined', () => {
    file('memory/memory.limit_in_bytes', `${V1_UNLIMITED}\n`)
    file('memory/x/memory.limit_in_bytes', `${V1_UNLIMITED}\n`)
    writeFileSync(membership, '4:memory:/x\n')
    expect(cgroupMemoryLimitBytes(probe())).toBeUndefined()
  })

  it('no membership file, or no cgroup files → undefined, never a throw', () => {
    expect(
      cgroupMemoryLimitBytes({ root, procSelfCgroup: path.join(root, 'absent') }),
    ).toBeUndefined()
    writeFileSync(membership, '0::/a/b\n')
    expect(cgroupMemoryLimitBytes(probe())).toBeUndefined()
  })

  it('a membership path that escapes the root is not walked', () => {
    file('memory.max', `${1 * GiB}\n`)
    writeFileSync(membership, '0::/../../\n')
    expect(cgroupMemoryLimitBytes(probe())).toBeUndefined()
  })
})

describe('cgroupCpuQuota', () => {
  it('v2: `<quota> <period>` in cores, the tightest level binds, `max` binds nothing', () => {
    file('cpu.max', 'max 100000\n')
    file('a/cpu.max', '200000 100000\n')
    file('a/b/cpu.max', 'max 100000\n')
    file('a/b/c/cpu.max', '350000 100000\n')
    writeFileSync(membership, '0::/a/b/c\n')
    expect(cgroupCpuQuota(probe())).toBe(2)
  })

  it('v1: cfs quota over period, -1 binds nothing, a fraction stays a fraction', () => {
    // `docker run --cpus=1.5` writes 150000/100000.
    file('cpu/cpu.cfs_quota_us', '-1\n')
    file('cpu/cpu.cfs_period_us', '100000\n')
    file('cpu/job/cpu.cfs_quota_us', '150000\n')
    file('cpu/job/cpu.cfs_period_us', '100000\n')
    writeFileSync(membership, ['4:memory:/job', '1:cpu,cpuacct:/job', ''].join('\n'))
    expect(cgroupCpuQuota(probe())).toBe(1.5)
  })

  it('no quota anywhere → undefined', () => {
    file('cpu/cpu.cfs_quota_us', '-1\n')
    file('cpu/cpu.cfs_period_us', '100000\n')
    writeFileSync(membership, '1:cpu:/\n')
    expect(cgroupCpuQuota(probe())).toBeUndefined()
  })
})

describe('the machine as this process may use it', () => {
  it('memory: the total capped by the cgroup limit, on Linux', () => {
    if (process.platform !== 'linux') return
    file('memory/memory.limit_in_bytes', `${1 * GiB}\n`)
    writeFileSync(membership, '4:memory:/\n')
    expect(machineMemoryBytes(probe())).toBe(Math.min(os.totalmem(), 1 * GiB))
  })

  it('parallelism: the cores capped by the quota, rounded UP, never below one', () => {
    if (process.platform !== 'linux') return
    file('cpu/cpu.cfs_quota_us', '150000\n')
    file('cpu/cpu.cfs_period_us', '100000\n')
    writeFileSync(membership, '1:cpu:/\n')
    // A 1.5-core quota is two workers (the half core is real time), unless
    // the machine has fewer cores than that.
    expect(machineParallelism(probe())).toBe(Math.min(navigator.hardwareConcurrency, 2))
    file('cpu/cpu.cfs_quota_us', '20000\n')
    expect(machineParallelism(probe())).toBe(1)
  })

  it('reads THIS machine without throwing, never above what the OS reports', () => {
    const limit = cgroupMemoryLimitBytes()
    if (limit !== undefined) expect(limit).toBeGreaterThan(64 * 1024 * 1024)
    expect(machineMemoryBytes()).toBeLessThanOrEqual(os.totalmem())
    expect(machineMemoryBytes()).toBeGreaterThan(0)
    expect(machineParallelism()).toBeLessThanOrEqual(Math.max(1, navigator.hardwareConcurrency))
    expect(machineParallelism()).toBeGreaterThanOrEqual(1)
  })
})
