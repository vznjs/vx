// A sandboxed task's own temp files: its TMPDIR under a root only this
// user owns, and the logs and sockets the process's `exit` removes if the
// task's own end never came.

import path from 'node:path'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { UserError } from '../util/index.js'

/**
 * The temp directory SRT hands every sandboxed task. It overrides `TMPDIR`
 * so temp-file writers land somewhere its filesystem policy already allows,
 * and it deliberately does NOT create the directory — its own comment says
 * "/tmp/claude may not exist". Nobody else does either, so on any machine
 * that is not Claude Code's own, every sandboxed task that writes a temp
 * file died with ENOENT. Resolution mirrors SRT's exactly.
 */
export function sandboxTmpdir(): string {
  // `process.env`, not `Bun.env`: a caller that REPLACES the env object
  // (two tests here do, and an embedder may) leaves `Bun.env` pointing at
  // the original, so a late assignment would be invisible.
  const named = process.env['CLAUDE_CODE_TMPDIR'] ?? process.env['CLAUDE_TMPDIR']
  return named !== undefined && named !== '' ? named : '/tmp/claude'
}

/**
 * The temp files of tasks still running: strace logs and port-bridge
 * sockets. A signal exit is `process.exit` (orchestrator/signals.ts),
 * which never reaches a task's own unlink, so a Ctrl-C left one log per
 * sandboxed task in the temp dir (item 848); the process's `exit` event
 * removes what is still listed.
 */
export const liveTempFiles = new Set<string>()

export const liveTaskTmpdirs = new Set<string>()

let exitHooked = false

function hookExit(): void {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    for (const f of liveTempFiles) {
      try {
        unlinkSync(f)
      } catch {
        // never written, or gone
      }
    }
    for (const d of liveTaskTmpdirs) removeTaskTmpdir(d)
  })
}

export function unlinkOnExit(file: string): void {
  liveTempFiles.add(file)
  hookExit()
}

/**
 * A task's own temp directory, `TMPDIR` inside its sandbox. SRT points
 * every sandboxed task at ONE host directory (`sandboxTmpdir`), bound
 * read-write and kept across runs, so a file one task wrote there was
 * another's undeclared input: a cached reader replayed the first value it
 * saw after the writer changed it (item 965). Created for the task, removed
 * with its bridges at its end (and at exit, as the logs are); a `kill -9`
 * leaves it. No sweep by the owner's pid: a nested vx sees another pid
 * namespace, where the outer vx's pid reads as dead, and a sweep there
 * removed the outer task's own TMPDIR mid-run (the gate, item 965). The shared
 * directory itself stays writable, since SRT's policy grants it: a command
 * that names it outright still reaches it.
 */
export function taskTmpdir(tag: string): string {
  return path.join(taskTmpRoot(), `vx-task-${process.pid}-${tag}`)
}

/**
 * The parent of every task's own temp directory, walled off from every
 * sandboxed task, each granted its own directory inside: SRT binds its
 * whole temp dir writable into every task, so a task listed and read what
 * a concurrent one kept in its TMPDIR, or replaced its port bridge's
 * socket (L-10).
 */
export function taskTmpRoot(): string {
  return path.join(sandboxTmpdir(), 'vx-tasks')
}

/**
 * `taskTmpRoot()`, made or checked as this user's own before a task's
 * directory goes in it. It sits in a shared temp dir: a user who made it
 * first owned the parent of every task's TMPDIR and bridge socket, and
 * renamed a running task's directory to plant their own under its name
 * (probed, L-13) — the path the host bridge dials and the write grant is
 * resolved from. A symlink, another owner, or a parent another user may
 * rewrite is refused; one of ours left open to others is closed.
 */
export function ownTaskTmpRoot(): string {
  const root = taskTmpRoot()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const uid = process.getuid?.()
  if (uid === undefined) return root
  const st = lstatSync(root)
  const parent = statSync(path.dirname(root))
  // Group write is a umask-002 box's default; others' write is the hole,
  // unless the sticky bit keeps them to their own entries (`/tmp`).
  const parentShared = (parent.mode & 0o002) !== 0 && (parent.mode & 0o1000) === 0
  if (
    !st.isDirectory() ||
    st.uid !== uid ||
    (parent.uid !== uid && parent.uid !== 0) ||
    parentShared
  ) {
    throw new UserError(
      `sandbox: ${root} is not this user's own directory (a link, another owner, or a parent others may write); remove it, or point CLAUDE_CODE_TMPDIR at a private directory`,
    )
  }
  if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700)
  return root
}

export function trackTaskTmpdir(dir: string): void {
  liveTaskTmpdirs.add(dir)
  hookExit()
}

/**
 * Remove a task's temp directory; never throws. The task may leave it
 * unremovable: a read-only directory in it (EACCES), or a straggler still
 * writing (ENOTEMPTY). Thrown, either failed a task that had passed, as a
 * worker fault under dte. A read-only one is made writable and the remove
 * retried; what still stands is left to the exit hook's last try.
 */
export function removeTaskTmpdir(dir: string): boolean {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      if (attempt === 2) return false
      ownerWritable(dir)
    }
  }
}

/** Give the owner write and search on every directory under `dir`, which a recursive remove needs. */
function ownerWritable(dir: string): void {
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory()) return
    if ((st.mode & 0o700) !== 0o700) chmodSync(dir, (st.mode & 0o7777) | 0o700)
    for (const name of readdirSync(dir)) ownerWritable(path.join(dir, name))
  } catch {
    // gone, or not this user's: the retry says
  }
}
