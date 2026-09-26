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
import { executablePath, procfsIsOwn } from '../util/index.js'

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

/**
 * The groups vx must take down if it dies without running a line: a
 * `kill -9`, the OOM killer. Nothing in vx runs then, so the kill has to
 * live outside it — one `sh` per vx process, its own group, reading a
 * pipe only vx holds the write end of. `+<pgid>` and `-<pgid>` lines keep
 * its list; when vx dies the kernel closes the pipe, the read hits EOF,
 * and every group still listed is SIGKILLed — what bwrap's
 * `--die-with-parent` does for a Linux sandboxed task, extended to the
 * rest. A group signal reaches what the task forked, which
 * `PR_SET_PDEATHSIG` never did (kill-tree.md). Started just before the
 * first spawn, so a run that spawns nothing (a warm run) never starts
 * it; a normal exit leaves the list empty, so the EOF then kills nothing.
 * `undefined` until then, `null` once it could not start or write: the
 * guard is best-effort, and its failure is the documented limit, never a
 * failed task.
 */
let guardFd: number | null | undefined

const GUARD_SCRIPT = [
  "g=' '",
  'while IFS= read -r l; do',
  '  case $l in',
  '    +*) g="$g${l#+} " ;;',
  '    -*) p=${l#-}; case $g in *" $p "*) g="${g%% $p *} ${g#* $p }" ;; esac ;;',
  '  esac',
  'done <&3',
  'for p in $g; do kill -s KILL -- "-$p"; done 2>/dev/null',
].join('\n')

function startGuard(): void {
  if (guardFd !== undefined) return
  guardFd = null
  try {
    const guard = Bun.spawn([executablePath('sh'), '-c', GUARD_SCRIPT], {
      argv0: 'vx-group-guard',
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      // Out of vx's group, so a Ctrl-C at the terminal leaves it to the
      // pipe; vx's own teardown owns that path.
      detached: true,
    })
    guard.unref()
    guardFd = guard.stdio[3] as number
  } catch {
    // The limit as it was: nothing takes the groups down.
  }
}

function guardWrite(line: string): void {
  if (typeof guardFd !== 'number') return
  try {
    writeSync(guardFd, line)
  } catch {
    guardFd = null
  }
}

/**
 * Spawn a task child and list its group for the guard to kill if vx dies
 * holding it. The guard starts BEFORE the spawn: started after it, the
 * guard's own spawn was a window in which the task ran and a `kill -9`
 * of vx found its group unlisted — under a traced sandbox, a third of
 * the kills landed there. What is left is the step from the spawn's
 * return to one pipe write.
 */
export function spawnGuarded(spawn: () => Child): Child {
  startGuard()
  const child = spawn()
  if (child.pid > 0) guardWrite(`+${child.pid}\n`)
  return child
}

/**
 * Strike `child`'s group from the guard's list: vx is done with it. What
 * it left running is left as before, and a pid the kernel reuses is
 * never killed on the old task's account. A group a teardown holds is
 * struck when the teardown lets it go.
 */
export function releaseGroup(child: Child): void {
  if (!(child.pid > 0)) return
  const hold = holds.get(child.pid)
  if (hold !== undefined) hold.released = true
  else guardWrite(`-${child.pid}\n`)
}

/** Groups a teardown is still taking down: how many hold each, and whether its runner let it go. */
const holds = new Map<number, { count: number; released: boolean }>()

/**
 * Keep `children`'s groups on the guard's list until the returned
 * function runs. A teardown signals a group and waits out a grace for it,
 * and the runner lets a group go when its LEADER exits: a shell that died
 * on the signal while a child that ignores it ran on released the group
 * mid-grace, and a `kill -9` of vx there left that child to nobody (item
 * 865). The caller lets go once its SIGKILL sweep has settled.
 */
export function holdGroups(children: readonly Child[]): () => void {
  const pids = children.map((c) => c.pid).filter((pid) => pid > 0)
  for (const pid of pids) {
    const hold = holds.get(pid)
    if (hold === undefined) holds.set(pid, { count: 1, released: false })
    else hold.count++
  }
  return () => {
    for (const pid of pids) {
      const hold = holds.get(pid)
      if (hold === undefined) continue
      if (--hold.count > 0) continue
      holds.delete(pid)
      if (hold.released) guardWrite(`-${pid}\n`)
    }
  }
}

/**
 * Children whose group was empty when their leader exited. Its number is
 * free from then on, and the kernel hands it to the next process that
 * needs it: a persistent server stays in the run's registry after it
 * exits (keep-alive reports it), and a teardown that signalled `-pid`
 * there could reach whatever group holds the number now (item 874). A
 * group that still had a member keeps its number reserved, and is
 * signalled as before.
 */
const goneGroups = new WeakSet<Child>()

/** Note, as `child`'s leader exits, whether its group went with it. */
export function markGroupIfGone(child: Child): void {
  if (!groupAlive(child)) goneGroups.add(child)
}

export function killTree(child: Child, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
  // A pid of 0 would name OUR group (kill(0)): a child that never
  // spawned has nothing to kill.
  if (!(child.pid > 0) || goneGroups.has(child)) return
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
  if (!(child.pid > 0) || goneGroups.has(child)) return false
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
