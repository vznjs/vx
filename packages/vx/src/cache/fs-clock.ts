// How far the workspace's file system clock runs behind this process's. A
// racy window (`racyWindowMs`) compares a file's stamp, on the clock of the
// file system that holds it, with a moment vx read from `Date.now()`, as if
// they were one clock. A file system behind it (a WSL2 VM drifted from the
// Windows host that stamps `/mnt/c`, a Docker Desktop bind mount, an NFS
// server) dated an edit made while a command ran before the command, and the
// entry filed the edit's output under the key of the bytes before it. A
// clock ahead only makes a stamp look newer, which every window reads the
// safe way.

import { closeSync, fstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
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
 * reads it: a stamp read off a file written in `dir` (the run's cache
 * dir), and every later write's mtime and ctime is at or after it. Linux before 6.13 stamps from its coarse clock, a tick behind the
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
  return stampIn(dir) ?? Date.now() - lagMs
}

/** The file `stampIn` writes: open, already unlinked, in `dir`. */
let held: { dir: string; fd: number } | undefined
const BYTE = new Uint8Array(1)

/**
 * The stamp of a one-byte write to a file held open in `dir` and unlinked
 * at once, so nothing is left there and a later call is a write and an
 * fstat. A file made, stat'ed and removed per call cost every cached task
 * 91 us of the main thread on a cold 9,603-task run (0.9 s, 2026-11-11):
 * a create and an unlink take the directory's lock beside the tasks'
 * writes. One fd for the last dir asked: a process that runs many
 * workspaces (a test file) holds no more. Undefined when `dir` cannot take
 * the file. Since 6.13 Linux stamps a file whose times were read since its
 * last change from its fine clock, as this one's are, and raises the floor
 * of every coarse stamp after it to that: no later write to another file
 * was stamped before it (0 of 20,000 on 6.18, 2026-11-11).
 */
function stampIn(dir: string): number | undefined {
  try {
    if (held?.dir !== dir) {
      const was = held
      held = undefined
      if (was !== undefined) closeSync(was.fd)
      const name = path.join(dir, `.vx-clock-${process.pid}`)
      const fd = openSync(name, 'w')
      held = { dir, fd }
      unlinkSync(name)
    }
    writeSync(held.fd, BYTE, 0, 1, 0)
    return fstatSync(held.fd).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Measure the lag from a file written and removed in `dir` (the run's cache
 * dir: on the workspace's file system by default, and ignored by git and
 * `vx watch`), and apply it. Once a run, on the file `fsClockNow` then
 * writes too. A directory that cannot take the file measures no lag.
 */
export function measureFsClockLag(dir: string): void {
  let ms = 0
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // unmeasured below: no lag, as before
  }
  const at = stampIn(dir)
  if (at !== undefined) ms = Date.now() - at - stampGrainMs(at)
  setFsClockLag(ms)
}
