// A parent that relays stop signals to vx (npm-launcher.cjs where Node
// cannot execve, a global vx handing the call off) shares vx's process
// group. Outside a terminal's foreground it passes on every stop, since it
// cannot tell one sent to it alone from one sent to the whole group, and a
// group stop then reaches vx twice: from the kernel and from the parent.
// vx read the copy as a second stop, "now", and SIGKILLed every task
// mid-cleanup (vercel/turborepo#14972). The parent says it relays through
// the environment; vx takes the mark out at start, so no task inherits it.

import { readFileSync } from 'node:fs'

const SIGNAL_RELAY_ENV = 'VX_SIGNAL_RELAY'

let relayed: boolean | undefined

/** Reads and removes the parent's mark; once, before any task spawns. */
export function takeSignalRelay(): boolean {
  if (relayed === undefined) {
    relayed = process.env[SIGNAL_RELAY_ENV] === '1'
    delete process.env[SIGNAL_RELAY_ENV]
  }
  return relayed
}

/**
 * Whether `signal`, after `earlier`, is the relayed copy of one stop. In the
 * terminal's foreground the parent relays nothing (a key's signal reached
 * vx already), so a repeat there is the user's own and still means "now".
 */
export function relayedCopy(signal: string, earlier: string | undefined): boolean {
  return signal === earlier && takeSignalRelay() && !inForeground()
}

function inForeground(): boolean {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/self/stat', 'utf8')
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return f[2] === f[5] // pgrp === tpgid
    }
    // The tasks run meanwhile and could read vx's env: PATH alone.
    const ps = Bun.spawnSync(['ps', '-o', 'pgid=,tpgid=', '-p', String(process.pid)], {
      env: { PATH: process.env['PATH'] ?? '' },
    })
    const [pgid, tpgid] = ps.stdout.toString().trim().split(/\s+/)
    return pgid !== undefined && pgid === tpgid
  } catch {
    return false
  }
}
