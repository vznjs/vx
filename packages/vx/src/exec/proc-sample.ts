// What a running task's process tree uses right now: CPU time and resident
// memory summed over a root pid and every descendant. `resourceUsage()`
// answers only at exit, so a task's curve needs a look while it runs.
//
// A tree, not a process group: a sandboxed task runs under bwrap in a
// session of its own, so its processes carry another group, but each still
// has its parent. A process that left the tree (re-parented to init) is not
// counted; nor is the CPU of a descendant that already exited.

import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { helperEnv, procfsIsOwn } from '../util/index.js'

export interface TreeUsage {
  /** CPU time of the live tree, user + system, in ms. */
  cpuMs: number
  /** Resident memory of the live tree, in bytes. */
  rssBytes: number
}

interface Proc {
  ppid: number
  /** Its own CPU and, on Linux, what its reaped children used (`cutime`, `cstime`). */
  cpuMs: number
  /** The executable's name; Linux only. */
  comm?: string
  /** Resident KiB when the table carries it; Linux reads it per tree member. */
  rssKiB?: number
}

/**
 * Linux's `/proc/<pid>/stat` counts CPU in USER_HZ ticks, fixed at 100 by
 * the ABI on every architecture; `tests/proc-sample.unsafe.test.ts` pins it by
 * burning a known span and reading it back.
 */
const TICK_MS = 10

/** Each root's tree usage; a root no longer alive has no entry. */
export async function sampleTrees(
  roots: readonly number[],
  /** Members not counted (their children still are): the sandbox's own tracer. */
  skip?: ReadonlySet<string>,
): Promise<Map<number, TreeUsage>> {
  const out = new Map<number, TreeUsage>()
  if (roots.length === 0) return out
  if (process.platform === 'linux' && procfsIsOwn() && childrenListed()) {
    for (const root of roots) {
      const usage = linuxTree(root, skip)
      if (usage !== undefined) out.set(root, usage)
    }
    return out
  }
  const table = process.platform === 'linux' ? await linuxTable() : await psTable()
  if (table === undefined) return out
  const children = new Map<number, number[]>()
  for (const [pid, p] of table) {
    const list = children.get(p.ppid)
    if (list === undefined) children.set(p.ppid, [pid])
    else list.push(pid)
  }
  for (const root of roots) {
    if (!table.has(root)) continue
    const tree: number[] = []
    const stack = [root]
    while (stack.length > 0) {
      const pid = stack.pop()!
      const comm = table.get(pid)!.comm
      if (skip === undefined || comm === undefined || !skip.has(comm)) tree.push(pid)
      for (const c of children.get(pid) ?? []) stack.push(c)
    }
    let cpuMs = 0
    let rssKiB = 0
    for (const pid of tree) {
      const p = table.get(pid)!
      cpuMs += p.cpuMs
      rssKiB += p.rssKiB ?? linuxRssKiB(pid)
    }
    out.set(root, { cpuMs, rssBytes: rssKiB * 1024 })
  }
  return out
}

/**
 * A `/proc` file's start, read in one call into one buffer: a look reads
 * every process's `stat` on the machine, and a promise per file cost ~16 µs
 * of vx's thread each (1.3 ms a look at 84 processes, 4 looks a second while
 * any task runs; 0.44 ms read this way). Undefined when it is gone.
 */
const procBuf = Buffer.allocUnsafe(4096)
function readProc(file: string): string | undefined {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return undefined // exited between the listing and the read
  }
  try {
    const n = readSync(fd, procBuf, 0, procBuf.length, 0)
    return n === 0 ? undefined : procBuf.toString('latin1', 0, n)
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * `<pid> (<comm>) <state> <ppid> …`: comm may hold spaces and parens, so the
 * fields start after the LAST ')': state is [0], ppid [1], utime [11], stime
 * [12], cutime [13], cstime [14]. The reaped children's share keeps a tree's
 * sum from dropping when a member exits: what a task's short-lived
 * processes used stays counted. Undefined for a zombie or a dead one.
 */
function parseStat(stat: string): Proc | undefined {
  const close = stat.lastIndexOf(')')
  const f = stat.slice(close + 2).split(' ')
  if (f[0] === 'Z' || f[0] === 'X') return undefined
  return {
    ppid: Number(f[1]),
    cpuMs: (Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14])) * TICK_MS,
    comm: stat.slice(stat.indexOf('(') + 1, close),
  }
}

/** Whether this kernel lists a thread's children (`CONFIG_PROC_CHILDREN`); asked once. */
let listsChildren: boolean | undefined
function childrenListed(): boolean {
  if (listsChildren === undefined) {
    const self = String(process.pid)
    try {
      closeSync(openSync(`/proc/${self}/task/${self}/children`, 'r'))
      listsChildren = true
    } catch {
      listsChildren = false
    }
  }
  return listsChildren
}

/**
 * One tree's use, read from its own members: the root's stat, then each
 * thread's `children` down the tree. A look used to read every process's
 * stat on the machine to find the few under its roots, four times a second
 * for a whole run (~90 on an idle container, more on a CI runner).
 */
function linuxTree(root: number, skip?: ReadonlySet<string>): TreeUsage | undefined {
  let cpuMs = 0
  let rssKiB = 0
  let found = false
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop()!
    const stat = readProc(`/proc/${pid}/stat`)
    const p = stat === undefined ? undefined : parseStat(stat)
    if (p === undefined) continue
    found = true
    if (skip === undefined || p.comm === undefined || !skip.has(p.comm)) {
      cpuMs += p.cpuMs
      rssKiB += linuxRssKiB(pid)
    }
    let tids: string[]
    try {
      tids = readdirSync(`/proc/${pid}/task`)
    } catch {
      continue // exited since its stat
    }
    for (const tid of tids) {
      const kids = readProc(`/proc/${pid}/task/${tid}/children`)
      if (kids === undefined) continue
      for (const c of kids.split(' ')) if (c !== '' && c !== '\n') stack.push(Number(c))
    }
  }
  return found ? { cpuMs, rssBytes: rssKiB * 1024 } : undefined
}

async function linuxTable(): Promise<Map<number, Proc> | undefined> {
  // Another namespace's /proc is a table of strangers: no answer beats a wrong one.
  if (!procfsIsOwn()) return undefined
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return undefined
  }
  const table = new Map<number, Proc>()
  for (const entry of entries) {
    const first = entry.charCodeAt(0)
    if (first < 48 || first > 57) continue
    const stat = readProc(`/proc/${entry}/stat`)
    const p = stat === undefined ? undefined : parseStat(stat)
    if (p !== undefined) table.set(Number(entry), p)
  }
  return table
}

/** `VmRSS` carries its unit (kB); 0 for a process gone or a kernel thread. */
function linuxRssKiB(pid: number): number {
  const status = readProc(`/proc/${pid}/status`)
  const m = status === undefined ? null : /^VmRSS:\s+(\d+) kB$/m.exec(status)
  return m === null ? 0 : Number(m[1])
}

/** macOS (and any non-Linux): one `ps` for the whole table. */
async function psTable(): Promise<Map<number, Proc> | undefined> {
  let text: string
  try {
    // It runs beside the tasks, readable by them (`ps eww`): PATH alone.
    const ps = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,rss=,time='], {
      env: helperEnv(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    text = await new Response(ps.stdout).text()
    if ((await ps.exited) !== 0) return undefined
  } catch {
    return undefined
  }
  const table = new Map<number, Proc>()
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    const cpuMs = psTimeMs(f[3]!)
    if (cpuMs === undefined) continue
    table.set(Number(f[0]), { ppid: Number(f[1]), rssKiB: Number(f[2]), cpuMs })
  }
  return table
}

/**
 * `ps`'s `time`: `[[dd-]hh:]mm:ss[.cc]`, macOS printing hundredths after
 * the locale's decimal point — `0:01,50` under a German or French locale.
 */
export function psTimeMs(s: string): number | undefined {
  const dash = s.indexOf('-')
  const days = dash === -1 ? 0 : Number(s.slice(0, dash))
  const parts = s
    .slice(dash + 1)
    .replace(',', '.')
    .split(':')
    .map(Number)
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n)) || !Number.isFinite(days)) {
    return undefined
  }
  let seconds = 0
  for (const n of parts) seconds = seconds * 60 + n
  return Math.round((days * 86_400 + seconds) * 1000)
}

/** How often a watched tree is looked at; one timer serves every tree. */
const WATCH_EVERY_MS = 250

const watched = new Map<number, TreeUsage & { looks: number }>()
let watchTimer: ReturnType<typeof setInterval> | undefined
let looking = false
const SKIP = new Set(['strace'])

async function look(): Promise<void> {
  if (looking) return
  looking = true
  try {
    const usage = await sampleTrees([...watched.keys()], SKIP)
    for (const [pid, u] of usage) {
      const w = watched.get(pid)
      if (w === undefined) continue
      w.cpuMs = Math.max(w.cpuMs, u.cpuMs)
      w.rssBytes = Math.max(w.rssBytes, u.rssBytes)
      w.looks++
    }
  } catch {
    // A failed look is a missing point.
  } finally {
    looking = false
  }
}

/** How many trees are watched: none once every task has ended, or the timer never stops. */
export function watchedTrees(): number {
  return watched.size
}

/**
 * Watch a running tree until `stop`, which answers the most CPU and the
 * peak resident memory any look saw; none when no look landed (a task
 * shorter than one interval). The sandbox's answer on Linux, where the
 * wait never sees what bwrap's pid namespace used.
 */
export function watchTree(pid: number): { stop(): TreeUsage | undefined } {
  const w = { cpuMs: 0, rssBytes: 0, looks: 0 }
  watched.set(pid, w)
  watchTimer ??= setInterval(() => void look(), WATCH_EVERY_MS)
  watchTimer.unref?.()
  return {
    stop() {
      if (watched.get(pid) === w) watched.delete(pid)
      if (watched.size === 0 && watchTimer !== undefined) {
        clearInterval(watchTimer)
        watchTimer = undefined
      }
      return w.looks === 0 ? undefined : { cpuMs: w.cpuMs, rssBytes: w.rssBytes }
    },
  }
}
