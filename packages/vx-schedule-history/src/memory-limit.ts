// The memory this process may actually use: the machine's total, capped
// by the cgroup limit a container runs under. `os.totalmem()` reports the
// HOST's RAM inside a cgroup-limited container (a CI job's docker
// executor, a Kubernetes runner), so a budget read from it alone lets the
// packing admit what the OOM killer will not. Linux only; elsewhere the
// total is the answer.

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
 * bytes; undefined when no cgroup bounds it (no cgroup files, or every
 * level says unlimited). Both hierarchies: v2 (`memory.max`, `max` for
 * unlimited) and v1 (`memory.limit_in_bytes`, an unlimited level writes
 * the page-counter maximum, ~2^63). A limit on an ANCESTOR binds too, so
 * the walk goes up to the root and keeps the minimum.
 */
export function cgroupMemoryLimitBytes(probe: CgroupProbe = {}): number | undefined {
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
      // v2 (unified): the memory controller lives on the one hierarchy.
      walkUp(path.join(root, cgroupPath), root, 'memory.max', candidates, (raw) =>
        raw === 'max' ? undefined : Number(raw),
      )
    } else if (controllers.split(',').includes('memory')) {
      // v1: the memory controller's own mount point.
      const base = path.join(root, 'memory')
      walkUp(path.join(base, cgroupPath), base, 'memory.limit_in_bytes', candidates, (raw) => {
        const n = Number(raw)
        // An unlimited v1 level reports PAGE_COUNTER_MAX × PAGE_SIZE — far
        // past any real memory; treat everything above 2^60 as no limit.
        return n >= 2 ** 60 ? undefined : n
      })
    }
  }
  return candidates.length === 0 ? undefined : Math.min(...candidates)
}

function walkUp(
  from: string,
  stopAt: string,
  file: string,
  into: number[],
  parse: (raw: string) => number | undefined,
): void {
  let dir = path.resolve(from)
  const stop = path.resolve(stopAt)
  // A path outside the root (a foreign membership file) is not walked.
  if (dir !== stop && !dir.startsWith(stop + path.sep)) return
  for (;;) {
    const p = path.join(dir, file)
    if (existsSync(p)) {
      try {
        const n = parse(readFileSync(p, 'utf8').trim())
        if (n !== undefined && Number.isFinite(n) && n > 0) into.push(n)
      } catch {
        // A level that cannot be read bounds nothing.
      }
    }
    if (dir === stop) return
    dir = path.dirname(dir)
  }
}

/** What this process may use: the machine's total, capped by its cgroup. */
export function machineMemoryBytes(probe: CgroupProbe = {}): number {
  const total = os.totalmem()
  if (process.platform !== 'linux') return total
  const limit = cgroupMemoryLimitBytes(probe)
  return limit === undefined ? total : Math.min(total, limit)
}
