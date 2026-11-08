// How far the workspace's file system clock runs behind this process's. A
// racy window (`racyWindowMs`) compares a file's stamp, on the clock of the
// file system that holds it, with a moment vx read from `Date.now()`, as if
// they were one clock. A file system behind it (a WSL2 VM drifted from the
// Windows host that stamps `/mnt/c`, a Docker Desktop bind mount, an NFS
// server) dated an edit made while a command ran before the command, and the
// entry filed the edit's output under the key of the bytes before it. A
// clock ahead only makes a stamp look newer, which every window reads the
// safe way.

import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A lag at or under this is the kernel's coarse tick, which stamps a write
 * up to ~10 ms behind `Date.now()` on every box and which each window
 * already holds; widening by it withheld saves after a fast upstream.
 */
const FS_CLOCK_TICK_MS = 20

let lagMs = 0

/** The lag every racy window is widened by: 0 unless measured past the tick. */
export function fsClockLag(): number {
  return lagMs
}

/** Widen every racy window by `ms`, when it is past the tick. */
export function setFsClockLag(ms: number): void {
  lagMs = ms > FS_CLOCK_TICK_MS ? ms : 0
}

/**
 * What a stamp's own precision may hide (see `racyWindowMs`): a stamp with
 * no sub-second part stands for any moment in its second, an even one for
 * FAT's two.
 */
export function stampGrainMs(stampMs: number): number {
  if (stampMs % 2000 === 0) return 2000
  return stampMs % 1000 === 0 ? 1000 : 0
}

/**
 * "Now" as the file system will stamp the next write, not as `Date.now()`
 * reads it: a stamp read off a file written and removed in `dir` (the
 * run's cache dir), and every later write's mtime and ctime is at or after
 * it. Linux before 6.13 stamps from its coarse clock, a tick behind the
 * fine clock `Date.now()` reads — on the Linux bench box 2026-09-11, 2 of
 * 3,000 tight writes carried an mtime 5.8 ms EARLIER than a `Date.now()`
 * taken before the write, and more under CPU load. That lag is under the
 * one `measureFsClockLag` applies, so a window that asks "written after
 * this moment?" takes the moment from here: `vx watch`'s arm and cycle
 * start (an edit right after the ready line was dropped as "before the
 * arm"), and the re-check's command start. A dir that cannot take the
 * file falls back to `Date.now()` less the measured lag.
 */
export function fsClockNow(dir: string): number {
  const stamp = path.join(dir, `.vx-clock-${process.pid}`)
  try {
    writeFileSync(stamp, '')
    const at = statSync(stamp).mtimeMs
    unlinkSync(stamp)
    return at
  } catch {
    return Date.now() - lagMs
  }
}

/**
 * Measure the lag from a file written and removed in `dir` (the run's cache
 * dir: on the workspace's file system by default, and ignored by git and
 * `vx watch`), and apply it. Once a run: one write, one stat, one unlink. A
 * directory that cannot take the file measures no lag.
 */
export function measureFsClockLag(dir: string): void {
  const stamp = path.join(dir, `.vx-clock-${process.pid}`)
  let ms = 0
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(stamp, '')
    const at = statSync(stamp).mtimeMs
    ms = Date.now() - at - stampGrainMs(at)
    unlinkSync(stamp)
  } catch {
    // unmeasured: no lag, as before
  }
  setFsClockLag(ms)
}
