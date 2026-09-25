// Signal a task and everything it forked. Every task child is spawned
// `detached` — its own session and process group — so the group IS the
// task's tree: the shell, what the shell backgrounded (`server &`), a
// test runner's workers. Signalling the child alone left all of that
// alive: a timed-out `sh -c "x & y"` killed the shell and orphaned `x`,
// and a Ctrl-C did the same for every compound command (2026-09-16). A
// group signal reaches a member whose parent already died, too — the
// group outlives its leader — so the order of death does not matter.
// What still escapes is a daemon that calls setsid itself (the residual
// every non-cgroup runner shares); under a sandbox the pid namespace
// takes even that.

import { closeSync, readdirSync, readFileSync, writeSync } from 'node:fs'
import { procfsIsOwn } from '../util/index.js'

export type Child = ReturnType<typeof Bun.spawn>

/**
 * A child whose polite signals go down a pipe instead of to its group: a
 * Linux sandboxed task. The group there is bwrap's, whose monitor dies of
 * a SIGTERM and takes the namespace down with SIGKILL (`--die-with-parent`),
 * so the command's own cleanup never ran; a shell inside reads the
 * signal's name off the pipe and signals the command's group (item 752).
 * SIGKILL still goes to the group: bwrap's death is the hard stop.
 */
const channels = new Map<Child, number>()

/** Route `child`'s SIGINT and SIGTERM through `fd`, an end vx owns. */
export function signalThrough(child: Child, fd: number): void {
  channels.set(child, fd)
}

/**
 * Close `child`'s channel once it has exited. The entry goes before the
 * descriptor, so a later kill never writes to a number the process has
 * since reused.
 */
export function closeSignalChannel(child: Child): void {
  const fd = channels.get(child)
  if (fd === undefined) return
  channels.delete(child)
  try {
    closeSync(fd)
  } catch {
    // already closed
  }
}

export function killTree(child: Child, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
  // A pid of 0 would name OUR group (kill(0)): a child that never
  // spawned has nothing to kill.
  if (!(child.pid > 0)) return
  const fd = signal === 'SIGKILL' ? undefined : channels.get(child)
  if (fd !== undefined) {
    try {
      writeSync(fd, `${signal.slice(3)}\n`)
      return
    } catch {
      // The reader is gone (EPIPE): so is the command. The group signal
      // below finds what is left, or nothing.
    }
  }
  try {
    process.kill(-child.pid, signal)
  } catch (err) {
    // ESRCH: the whole group is gone. Anything else (a group that is not
    // ours to signal): the child itself, as before.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return
    child.kill(signal)
  }
}

/**
 * How often a group whose leader has exited is asked again whether any
 * member is left. Only a group that outlived its leader is polled.
 */
const GROUP_POLL_MS = 20

/**
 * Wait until every child's process group is gone, or `graceMs` passes.
 * Resolves with the children whose group still has a live member: the
 * ones to SIGKILL. The leader's exit is not the end of the tree — a
 * `server & wait` shell dies on SIGTERM while a server that ignores it
 * keeps the group, and the task's pipe, alive — so after the leaders the
 * groups themselves are polled, and only while one is left.
 */
export async function untilGroupsGone(
  children: readonly Child[],
  graceMs: number,
): Promise<Child[]> {
  const deadline = Date.now() + graceMs
  let timer: ReturnType<typeof setTimeout> | undefined
  // Not unref'd: it is what guarantees progress when every other handle
  // has drained, and the grace is bounded either way.
  await Promise.race([
    Promise.allSettled(children.map((c) => c.exited)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  let left = children.filter(groupAlive)
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(Math.min(GROUP_POLL_MS, deadline - Date.now()))
    left = left.filter(groupAlive)
  }
  return left
}

/**
 * Does any process of the child's group still run? `kill(-pgid, 0)`
 * answers for the group but counts a zombie, and an orphaned member that
 * died on the SIGTERM waits as one until init reaps it — 1 to 2 s under a
 * container's init (measured 2026-09-24) — so on Linux a group the kernel
 * still knows is read from /proc, where a zombie says so — when /proc is
 * this namespace's. One mounted for another reads as no member at all,
 * and a group that ignored the SIGTERM went un-killed; there the group
 * signal is the answer and the grace ends the wait.
 */
function groupAlive(child: Child): boolean {
  if (!(child.pid > 0)) return false
  try {
    process.kill(-child.pid, 0)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
  return !procfsIsOwn() || groupHasLiveMember(child.pid)
}

function groupHasLiveMember(pgid: number): boolean {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return true
  }
  for (const entry of entries) {
    const first = entry.charCodeAt(0)
    if (first < 48 || first > 57) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    // `<pid> (<comm>) <state> <ppid> <pgrp> …` — comm may hold spaces and
    // parens, so the fields start after the LAST ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ', 3)
    if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true
  }
  return false
}
