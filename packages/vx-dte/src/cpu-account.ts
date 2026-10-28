// Where a worker's machine spent its CPU while the worker served a run,
// said once as it leaves, in its own log: its tasks, the worker itself, its
// other children, and the processes that used the most besides. The run's
// summary showed machines busier than their tasks (2.8 cores against 2.0,
// 2026-10-24) and nothing said what the rest was.

import { readFileSync } from 'node:fs'

/** Each process's CPU so far by pid, with its name, from one `ps`. */
export type ProcTable = Map<number, { name: string; ms: number }>

export interface CpuAccount {
  readonly onlineMs: number
  /** Busy core-time of the whole machine over `onlineMs`, any process's. */
  readonly machineMs: number
  readonly tasksMs: number
  readonly selfMs: number
  /** Its reaped children's, less its tasks': Linux only. */
  readonly childrenMs?: number | undefined
  /** The processes that used the most while it served, its own tree aside. */
  readonly top: readonly { name: string; ms: number }[]
}

/** `ps`'s `time`, `[[dd-]hh:]mm:ss[.cc]`, in ms; macOS may print a comma for the point. */
export function psTime(s: string): number | undefined {
  const dash = s.indexOf('-')
  const days = dash === -1 ? 0 : Number(s.slice(0, dash))
  const parts = s
    .slice(dash + 1)
    .replace(',', '.')
    .split(':')
    .map(Number)
  if (parts.length < 2 || !Number.isFinite(days) || parts.some((n) => !Number.isFinite(n))) {
    return undefined
  }
  return Math.round((days * 86_400 + parts.reduce((a, n) => a * 60 + n, 0)) * 1000)
}

export interface Ps {
  readonly table: ProcTable
  readonly parents: Map<number, number>
}

/** `ps -A -o pid=,ppid=,time=,comm=`, read. */
export function parsePs(text: string): Ps {
  const table: ProcTable = new Map()
  const parents = new Map<number, number>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (m === null) continue
    const ms = psTime(m[3]!)
    if (ms === undefined) continue
    // macOS prints the path it ran; Linux a name, a kernel thread's with a
    // slash in it (`kworker/0:1`).
    const name = /^[./]/.test(m[4]!) ? m[4]!.split('/').pop()! : m[4]!
    table.set(Number(m[1]), { name, ms })
    parents.set(Number(m[1]), Number(m[2]))
  }
  return { table, parents }
}

/** One `ps` of every process. Undefined where it fails. */
export function readPs(): Ps | undefined {
  try {
    const r = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,time=,comm='], { stderr: 'ignore' })
    return r.exitCode === 0 ? parsePs(r.stdout.toString()) : undefined
  } catch {
    // quiet: no `ps`, no list of the rest
    return undefined
  }
}

/**
 * The CPU each process used between two tables, by name, the most first:
 * `self`'s tree left out (its tasks and itself are counted apart). A
 * process gone by the second table is not seen.
 */
export function topBetween(
  before: ProcTable,
  after: Ps,
  self: number,
  n = 5,
): { name: string; ms: number }[] {
  const mine = (pid: number): boolean => {
    // `self` asked before the stop at pid 1: docker() execs the worker as
    // its container's init.
    for (let p: number | undefined = pid, hops = 0; p !== undefined && hops < 64; hops++) {
      if (p === self) return true
      if (p <= 1) break
      p = after.parents.get(p)
    }
    return false
  }
  const byName = new Map<string, number>()
  for (const [pid, p] of after.table) {
    if (mine(pid)) continue
    const was = before.get(pid)
    const ms = was !== undefined && was.name === p.name ? p.ms - was.ms : p.ms
    if (ms > 0) byName.set(p.name, (byName.get(p.name) ?? 0) + ms)
  }
  return [...byName]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n)
}

/** The CPU its reaped children used, from `/proc/self/stat` (`cutime`, `cstime`); undefined off Linux. */
export function childrenCpuMs(
  read: () => string = () => readFileSync('/proc/self/stat', 'utf8'),
): number | undefined {
  try {
    const stat = read()
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // USER_HZ is 100 on every Linux ABI.
    return (Number(f[13]) + Number(f[14])) * 10
  } catch {
    // quiet: not Linux
    return undefined
  }
}

const cores = (ms: number, over: number): string => `${(ms / over).toFixed(2)} cores`

export function describeCpu(a: CpuAccount): string {
  const over = Math.max(1, a.onlineMs)
  const parts = [
    `machine ${cores(a.machineMs, over)}`,
    `tasks ${cores(a.tasksMs, over)}`,
    `this worker ${cores(a.selfMs, over)}`,
    ...(a.childrenMs === undefined ? [] : [`its other children ${cores(a.childrenMs, over)}`]),
  ]
  const rest = a.top.map((p) => `${p.name} ${cores(p.ms, over)}`).join(', ')
  return `cpu over ${(over / 1000).toFixed(1)}s: ${parts.join(' · ')}${rest === '' ? '' : ` · most besides: ${rest}`}`
}
