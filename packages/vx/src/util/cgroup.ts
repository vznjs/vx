// What this process may actually use, as its cgroup bounds it. Inside a
// container `navigator.hardwareConcurrency` and `os.totalmem()` report
// the HOST's cores and RAM; the cgroup that runs the job (a docker
// executor's `--cpus` / `--memory`, a Kubernetes limit) is what the
// kernel enforces. A limit set on an ANCESTOR binds too, so each reader
// walks from this process's cgroup up to the root and keeps the
// tightest value. Linux only; elsewhere the machine's numbers stand.
// Both hierarchies: v2 (unified, `memory.max` / `cpu.max`) and v1 (one
// mount per controller, `memory.limit_in_bytes` / `cpu.cfs_*_us`).

import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CgroupProbe {
  /** The cgroup filesystem root. Default `/sys/fs/cgroup`. */
  readonly root?: string
  /** This process's cgroup membership file. Default `/proc/self/cgroup`. */
  readonly procSelfCgroup?: string
}

/**
 * The tightest memory limit on this process's cgroup or any ancestor, in
 * bytes; undefined when no cgroup bounds it. v2: `memory.max`, `max`
 * binds nothing. v1: `memory.limit_in_bytes`, where an unlimited level
 * writes the page-counter maximum (~2^63) — anything past 2^60 binds
 * nothing.
 */
export function cgroupMemoryLimitBytes(probe: CgroupProbe = {}): number | undefined {
  return tightest(probe, 'memory', {
    v2: (dir) =>
      parseLimit(read(dir, 'memory.max'), (raw) => (raw === 'max' ? undefined : Number(raw))),
    v1: (dir) =>
      parseLimit(read(dir, 'memory.limit_in_bytes'), (raw) => {
        const n = Number(raw)
        return n >= 2 ** 60 ? undefined : n
      }),
  })
}

/**
 * The tightest CPU quota on this process's cgroup or any ancestor, in
 * cores (a fraction is possible: `--cpus=1.5`); undefined when no cgroup
 * bounds it. v2: `cpu.max` is `<quota> <period>` or `max <period>`. v1:
 * `cpu.cfs_quota_us` (-1 for none) over `cpu.cfs_period_us`.
 */
export function cgroupCpuQuota(probe: CgroupProbe = {}): number | undefined {
  return tightest(probe, 'cpu', {
    v2: (dir) => {
      const raw = read(dir, 'cpu.max')
      if (raw === undefined) return undefined
      const [quota, period] = raw.split(/\s+/)
      return quota === 'max' ? undefined : ratio(Number(quota), Number(period ?? '100000'))
    },
    v1: (dir) => {
      const quota = read(dir, 'cpu.cfs_quota_us')
      const period = read(dir, 'cpu.cfs_period_us')
      if (quota === undefined || period === undefined) return undefined
      const q = Number(quota)
      return q <= 0 ? undefined : ratio(q, Number(period))
    },
  })
}

/** The machine's total memory, capped by its cgroup limit. */
export function machineMemoryBytes(probe: CgroupProbe = {}): number {
  const total = os.totalmem()
  if (process.platform !== 'linux') return total
  const limit = cgroupMemoryLimitBytes(probe)
  return limit === undefined ? total : Math.min(total, limit)
}

/**
 * The cores this process may run on, capped by its cgroup CPU quota,
 * rounded up (a 1.5-core quota is two workers, not one) and never below
 * one. The default worker count.
 */
export function machineParallelism(probe: CgroupProbe = {}): number {
  const cores = Math.max(1, navigator.hardwareConcurrency)
  if (process.platform !== 'linux') return cores
  const quota = cgroupCpuQuota(probe)
  return quota === undefined ? cores : Math.max(1, Math.min(cores, Math.ceil(quota)))
}

function ratio(quota: number, period: number): number | undefined {
  return Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0
    ? quota / period
    : undefined
}

function parseLimit(
  raw: string | undefined,
  parse: (raw: string) => number | undefined,
): number | undefined {
  if (raw === undefined) return undefined
  const n = parse(raw)
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined
}

function read(dir: string, file: string): string | undefined {
  const p = path.join(dir, file)
  if (!existsSync(p)) return undefined
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    // A level that cannot be read bounds nothing.
    return undefined
  }
}

/**
 * The minimum over every level from this process's cgroup (for
 * `controller`) up to the hierarchy's root. The v1 mount is
 * `<root>/<controller>`; v2 is the one unified tree at `<root>`. A
 * membership path that escapes the root (a foreign file) is not walked.
 */
function tightest(
  probe: CgroupProbe,
  controller: 'memory' | 'cpu',
  readers: { v2: (dir: string) => number | undefined; v1: (dir: string) => number | undefined },
): number | undefined {
  const root = probe.root ?? '/sys/fs/cgroup'
  let membership: string
  try {
    membership = readFileSync(probe.procSelfCgroup ?? '/proc/self/cgroup', 'utf8')
  } catch {
    return undefined
  }
  const candidates: number[] = []
  for (const line of membership.split('\n')) {
    const parts = line.split(':')
    if (parts.length < 3) continue
    const controllers = parts[1]!
    const cgroupPath = parts.slice(2).join(':')
    if (controllers === '') {
      walkUp(path.join(root, cgroupPath), root, readers.v2, candidates)
    } else if (controllers.split(',').includes(controller)) {
      const base = path.join(root, controller)
      walkUp(path.join(base, cgroupPath), base, readers.v1, candidates)
    }
  }
  return candidates.length === 0 ? undefined : Math.min(...candidates)
}

function walkUp(
  from: string,
  stopAt: string,
  readLevel: (dir: string) => number | undefined,
  into: number[],
): void {
  let dir = path.resolve(from)
  const stop = path.resolve(stopAt)
  if (dir !== stop && !dir.startsWith(stop + path.sep)) return
  for (;;) {
    const n = readLevel(dir)
    if (n !== undefined) into.push(n)
    if (dir === stop) return
    dir = path.dirname(dir)
  }
}
