// The process umask, read when a restore starts: Bun reads it by setting 0
// and putting it back in one synchronous call (project-loader.ts
// `currentUmask`), so no spawn on this thread sees the 0, and a run
// evaluates no config in a worker.
const proc = globalThis.process as { umask?: () => number } | undefined
let umask = 0

/** Read the umask again: a restore's modes follow the process's as it is now. */
export function readUmask(): void {
  if (typeof proc?.umask === 'function') umask = proc.umask()
}
readUmask()

/**
 * The permission bits a restore gives a stored `mode`: minus the umask, as
 * tar gives a non-root user and Turbo does. A hit under `umask 077` gave
 * back 0644 / 0755 where the build left 0600 / 0700, readable by every
 * user on the machine (Growth's parity run, 2026-10-16).
 */
export function restoredMode(mode: number): number {
  return mode & 0o777 & ~umask
}

/** A file on disk holds the stored `mode`: as saved, or as a restore here leaves it. */
export function modeMatches(disk: number, stored: number): boolean {
  const d = disk & 0o777
  return d === (stored & 0o777) || d === restoredMode(stored)
}
