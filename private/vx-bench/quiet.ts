// What else ran beside a timed rep. A ratio taken in one job is not enough
// on a shared machine: on #4323's CI the check shared its worker with
// check.perf and two test shards, and vx's noop read 468 ms where its
// rerun read 292 (vx/turbo 1.25 against 0.97, one commit). Neighbours
// hurt vx more than Turbo, one JS thread against Go's many under a fair
// share (four busy loops moved the noop ratio from 0.90 to 1.28), so a
// slower box does not cancel out. Each rep pair is judged by the CPU
// other processes used while it ran, and the ratio comes from the
// quietest pairs.
import { readFileSync } from 'node:fs'

/** A clock tick of /proc/stat: USER_HZ is 100 on every Linux build. */
const TICK_MS = 10

/** Busy CPU time over all cores, in ms, from /proc/stat's `cpu` line: all but idle and iowait. */
export function busyMs(stat: string): number {
  const fields = stat.slice(0, stat.indexOf('\n')).trim().split(/\s+/).slice(1).map(Number)
  // user nice system idle iowait irq softirq steal; guest time is inside user.
  const [user = 0, nice = 0, system = 0, , , irq = 0, softirq = 0, steal = 0] = fields
  return (user + nice + system + irq + softirq + steal) * TICK_MS
}

/**
 * The machine's busy ms now, or undefined off Linux, where pairs are not
 * judged (no baseline is recorded there). On Linux an unreadable
 * /proc/stat throws: every pair would read as quiet.
 */
export function machineBusyMs(): number | undefined {
  if (process.platform !== 'linux') return undefined
  return busyMs(readFileSync('/proc/stat', 'utf8'))
}

/** A process's CPU ms from its /proc/<pid>/stat line: utime and stime, past the parenthesised name. */
export function procCpuMs(stat: string): number {
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return (Number(f[11]) + Number(f[12])) * TICK_MS
}

/**
 * The CPU ms the process tracing this one has used: vx's Linux sandbox
 * runs a task under strace, whose work on the bench's own syscalls is
 * the bench's, not a neighbour's (0.5 cores of it read every pair as
 * busy). 0 when nothing traces it.
 */
export function tracerCpuMs(): number {
  if (process.platform !== 'linux') return 0
  const pid = /^TracerPid:\s*(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]
  if (pid === undefined || pid === '0') return 0
  return procCpuMs(readFileSync(`/proc/${pid}/stat`, 'utf8'))
}

/** One rep of an arm: vx's and Turbo's ms, back to back, and the cores others kept busy meanwhile. */
export interface Pair {
  vx: number
  /** The base commit's vx, when the job times one. */
  base?: number
  turbo: number
  others: number
}

/** The `keep` pairs others disturbed least, in the order they ran. */
export function quietest(pairs: readonly Pair[], keep: number): Pair[] {
  const ranked = pairs
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.others - b.p.others || a.i - b.i)
  return ranked
    .slice(0, keep)
    .sort((a, b) => a.i - b.i)
    .map((r) => r.p)
}

/** Whether enough pairs ran with the machine to themselves. */
export function enoughQuiet(pairs: readonly Pair[], keep: number, quietCores: number): boolean {
  return pairs.filter((p) => p.others <= quietCores).length >= keep
}
