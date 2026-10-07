// What a running task's process tree uses right now: CPU time and resident
// memory summed over a root pid and every descendant. `resourceUsage()`
// answers only at exit, so a task's curve needs a look while it runs.
//
// A tree, not a process group: a sandboxed task runs under bwrap in a
// session of its own, so its processes carry another group, but each still
// has its parent. A process that left the tree (re-parented to init) is not
// counted; nor is the CPU of a descendant that already exited.

import { readdir, readFile } from 'node:fs/promises'
import { procfsIsOwn } from '../util/index.js'

export interface TreeUsage {
  /** CPU time of the live tree, user + system, in ms. */
  cpuMs: number
  /** Resident memory of the live tree, in bytes. */
  rssBytes: number
}

interface Proc {
  ppid: number
  cpuMs: number
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
export async function sampleTrees(roots: readonly number[]): Promise<Map<number, TreeUsage>> {
  const out = new Map<number, TreeUsage>()
  if (roots.length === 0) return out
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
      tree.push(pid)
      for (const c of children.get(pid) ?? []) stack.push(c)
    }
    let cpuMs = 0
    let rssKiB = 0
    const rss = await Promise.all(tree.map((pid) => table.get(pid)!.rssKiB ?? linuxRssKiB(pid)))
    for (const [i, pid] of tree.entries()) {
      cpuMs += table.get(pid)!.cpuMs
      rssKiB += rss[i]!
    }
    out.set(root, { cpuMs, rssBytes: rssKiB * 1024 })
  }
  return out
}

async function linuxTable(): Promise<Map<number, Proc> | undefined> {
  // Another namespace's /proc is a table of strangers: no answer beats a wrong one.
  if (!procfsIsOwn()) return undefined
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return undefined
  }
  const table = new Map<number, Proc>()
  await Promise.all(
    entries.map(async (entry) => {
      const first = entry.charCodeAt(0)
      if (first < 48 || first > 57) return
      let stat: string
      try {
        stat = await readFile(`/proc/${entry}/stat`, 'utf8')
      } catch {
        return // exited between the listing and the read
      }
      // `<pid> (<comm>) <state> <ppid> …` — comm may hold spaces and parens,
      // so the fields start after the LAST ')': state is [0], ppid [1],
      // utime [11], stime [12].
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (f[0] === 'Z' || f[0] === 'X') return
      table.set(Number(entry), {
        ppid: Number(f[1]),
        cpuMs: (Number(f[11]) + Number(f[12])) * TICK_MS,
      })
    }),
  )
  return table
}

/** `VmRSS` carries its unit (kB); 0 for a process gone or a kernel thread. */
async function linuxRssKiB(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const m = /^VmRSS:\s+(\d+) kB$/m.exec(status)
    return m === null ? 0 : Number(m[1])
  } catch {
    return 0
  }
}

/** macOS (and any non-Linux): one `ps` for the whole table. */
async function psTable(): Promise<Map<number, Proc> | undefined> {
  let text: string
  try {
    const ps = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,rss=,time='], {
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

/** `ps`'s `time`: `[[dd-]hh:]mm:ss[.cc]`, macOS printing hundredths. */
export function psTimeMs(s: string): number | undefined {
  const dash = s.indexOf('-')
  const days = dash === -1 ? 0 : Number(s.slice(0, dash))
  const parts = s
    .slice(dash + 1)
    .split(':')
    .map(Number)
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n)) || !Number.isFinite(days)) {
    return undefined
  }
  let seconds = 0
  for (const n of parts) seconds = seconds * 60 + n
  return Math.round((days * 86_400 + seconds) * 1000)
}
