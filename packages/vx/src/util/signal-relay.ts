// A parent that relays stop signals to vx (npm-launcher.cjs where Node
// cannot execve, a global vx handing the call off) shares vx's process
// group. Outside a terminal's foreground it passes on every stop, since it
// cannot tell one sent to it alone from one sent to the whole group, and a
// group stop then reaches vx twice: from the kernel and from the parent.
// vx read the copy as a second stop, "now", and SIGKILLed every task
// mid-cleanup (vercel/turborepo#14972). The parent says it relays through
// the environment; vx takes the mark out at start, so no task inherits it.
//
// A parent that sets no mark relays too: Bun's package-bin runner (`bun vx
// run`, the form the docs use) passes on every SIGINT, in a terminal's
// foreground as well, so one Ctrl-C reached vx twice, 0.2 ms apart, and vx
// SIGKILLed every task with no summary. Such a parent is a launcher: it heard
// the same stop, so it sits in vx's process group (a shell's job runs in a
// group of its own), and it ran vx for its own command line, so its arguments
// end with vx's. Its copy follows within a millisecond; a person's second
// Ctrl-C comes a key press later.

import { readFileSync } from 'node:fs'

const SIGNAL_RELAY_ENV = 'VX_SIGNAL_RELAY'

let relayed: boolean | undefined
/** When vx last finished acting on a stop; a relayed copy follows it within `COPY_WINDOW_MS`. */
let stoppedAt = Number.NEGATIVE_INFINITY
// Far above the 0.2 ms a copy took through Bun's runner, under the
// ~80 ms of the fastest deliberate second key press.
const COPY_WINDOW_MS = 40

/** Reads and removes the parent's mark; once, before any task spawns. */
export function takeSignalRelay(): boolean {
  if (relayed === undefined) {
    relayed = process.env[SIGNAL_RELAY_ENV] === '1'
    delete process.env[SIGNAL_RELAY_ENV]
  }
  return relayed
}

/** Marks the end of vx's work on a stop: the window for its copy starts here. */
export function stopActedOn(): void {
  stoppedAt = performance.now()
}

/**
 * Whether `signal`, after `earlier`, is the relayed copy of one stop. A
 * marked parent outside the terminal's foreground relays every stop; any
 * other copy comes from a launcher parent within `COPY_WINDOW_MS`. A repeat
 * after that is the user's own and still means "now"; so is a different
 * signal.
 */
export function relayedCopy(signal: string, earlier: string | undefined): boolean {
  if (signal !== earlier) return false
  if (takeSignalRelay() && !inForeground()) return true
  return performance.now() - stoppedAt < COPY_WINDOW_MS && launchedByParent()
}

function inForeground(): boolean {
  const [pgid, tpgid] = processFields(process.pid, 'pgid', 'tpgid') ?? []
  return pgid !== undefined && pgid === tpgid
}

function launchedByParent(): boolean {
  const own = processFields(process.pid, 'pgid')?.[0]
  if (own === undefined || own !== processFields(process.ppid, 'pgid')?.[0]) return false
  const args = process.argv.slice(2)
  try {
    if (process.platform === 'linux') {
      const parent = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0')
      if (parent.at(-1) === '') parent.pop()
      return parent.length > args.length && args.every((a, i) => parent.at(i - args.length) === a)
    }
    // -ww: never cut to a terminal's width.
    const ps = Bun.spawnSync(['ps', '-ww', '-o', 'args=', '-p', String(process.ppid)], {
      env: { PATH: process.env['PATH'] ?? '' },
    })
    return ` ${ps.stdout.toString().trim()}`.endsWith(['', ...args].join(' '))
  } catch {
    return false
  }
}

/** A process's group and its terminal's foreground group, as `ps` names them. */
function processFields(pid: number, ...names: Array<'pgid' | 'tpgid'>): string[] | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return names.map((n) => (n === 'pgid' ? f[2]! : f[5]!))
    }
    // The tasks run meanwhile and could read vx's env: PATH alone.
    const ps = Bun.spawnSync(['ps', '-o', names.map((n) => `${n}=`).join(','), '-p', String(pid)], {
      env: { PATH: process.env['PATH'] ?? '' },
    })
    const out = ps.stdout.toString().trim().split(/\s+/)
    return out.length === names.length && out[0] !== '' ? out : undefined
  } catch {
    return undefined
  }
}
