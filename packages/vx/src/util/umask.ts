// The process umask, read when a restore starts.
import { readFileSync } from 'node:fs'

let umask = 0

/**
 * The umask as it is now. Bun's `process.umask()` reads it by setting 0 and
 * putting it back: a directory a parallel restore made on a pool thread in
 * that window landed 0777. Linux states it in /proc without touching it.
 */
export function peekUmask(): number {
  if (process.platform === 'linux') {
    const m = /^Umask:\s*([0-7]+)$/m.exec(readFileSync('/proc/self/status', 'latin1'))
    if (m !== null) return parseInt(m[1]!, 8)
  }
  return process.umask()
}

/** Read the umask again: a restore's modes follow the process's as it is now. */
export function readUmask(): void {
  umask = peekUmask()
}
readUmask()

/**
 * The permission bits a restore gives a stored `mode`: minus the umask, as
 * tar gives a non-root user and Turbo does. A hit under `umask 077` gave
 * back 0644 / 0755 where the build left 0600 / 0700, readable by every
 * user on the machine.
 */
export function restoredMode(mode: number): number {
  return mode & 0o777 & ~umask
}

/** A file on disk holds the stored `mode`: as saved, or as a restore here leaves it. */
export function modeMatches(disk: number, stored: number): boolean {
  const d = disk & 0o777
  return d === (stored & 0o777) || d === restoredMode(stored)
}
