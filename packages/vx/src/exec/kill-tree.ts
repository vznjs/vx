// Signal a task and everything it forked. Every task child is spawned
// `detached` — its own session and process group — so the group IS the task's
// tree: the shell, what the shell backgrounded (`server &`), a test runner's
// workers. Signalling the child alone left all of that alive: a timed-out `sh
// -c "x & y"` killed the shell and orphaned `x`, and a Ctrl-C did the same for
// every compound command. A group signal reaches a member whose parent already
// died, too — the group outlives its leader — so the order of death does not
// matter. What still escapes is a daemon that calls setsid itself (the residual
// every non-cgroup runner shares); under a sandbox the pid namespace takes even
// that.

import { closeSync, readdirSync, readFileSync, writeSync } from 'node:fs'
import { helperEnv, procfsIsOwn, taskShell } from '../util/index.js'

export type Child = ReturnType<typeof Bun.spawn>

/**
 * A child whose polite signals go down a pipe instead of to its group: a Linux
 * sandboxed task. The group there is bwrap's, whose monitor dies of a SIGTERM
 * and takes the namespace down with SIGKILL (`--die-with-parent`), so the
 * command's own cleanup never ran; a shell inside reads the signal's name off
 * the pipe and signals the command's group. SIGKILL still goes to the group:
 * bwrap's death is the hard stop.
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

// Three lists: groups (`+`/`-`), single pids (`=`/`_`) and paths to remove
// (`@`/`!`), killed and removed in that order at EOF. A group is listed once
// however often its line arrives: a `-` strikes one entry, and a shell that
// keeps a failed printf buffered (bash as macOS's sh) sends the line again with
// its retry.
const GUARD_SCRIPT = [
  "g=' ' k=' ' f=' '",
  'while IFS= read -r l; do',
  '  p=${l#?}',
  '  case $l in',
  '    +*) case $g in *" $p "*) ;; *) g="$g$p " ;; esac ;;',
  '    -*) case $g in *" $p "*) g="${g%% $p *} ${g#* $p }" ;; esac ;;',
  '    =*) k="$k$p " ;;',
  '    _*) case $k in *" $p "*) k="${k%% $p *} ${k#* $p }" ;; esac ;;',
  '    @*) f="$f$p " ;;',
  '    !*) case $f in *" $p "*) f="${f%%" $p "*} ${f#*" $p "}" ;; esac ;;',
  '  esac',
  'done <&3',
  'for p in $g; do kill -s KILL -- "-$p"; done 2>/dev/null',
  'for p in $k; do kill -s KILL "$p"; done 2>/dev/null',
  'set -f; for p in $f; do rm -rf -- "$p"; done 2>/dev/null',
].join('\n')

/** The guard's process, so a guard vx stops writing to is stopped too. */
let guardProc: Child | undefined

/**
 * How long a write waits on a guard that is behind. Bun opens the pipe
 * nonblocking, and the kernel queues ~280 unread writes whatever their
 * size: a burst of releases, or a guard the scheduler has not yet run,
 * makes a write EAGAIN while the guard lives.
 */
const GUARD_STALL_MS = 1_000

/** Bytes per write to the guard: under a socket's buffer on every platform. */
const GUARD_PIECE = 1024

function startGuard(): void {
  if (guardFd !== undefined) return
  guardFd = null
  try {
    const guard = Bun.spawn([taskShell(), '-c', GUARD_SCRIPT], {
      argv0: 'vx-group-guard',
      env: helperEnv(),
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      // Out of vx's group, so a Ctrl-C at the terminal leaves it to the
      // pipe; vx's own teardown owns that path.
      detached: true,
    })
    guard.unref()
    const fd = guard.stdio[3] as number
    guardFd = fd
    guardProc = guard
    // A clean exit strikes what it released: the EOF kills what is listed.
    process.once('exit', flushGuard)
    // A guard that has died (killed, the OOM killer) is handed to no later
    // spawn: its pipe is broken, and a shell whose printf buffers (bash as
    // macOS's sh) flushed the failed `+<pgid>` line into the task's own stdout,
    // cached replay included.
    void guard.exited.then(() => {
      if (guardFd === fd) stopGuard()
    })
  } catch {
    // The limit as it was: nothing takes the groups down.
  }
}

/**
 * Stop guarding for the rest of the process, and stop the guard with it:
 * a guard that lived on would keep every group whose release it never got
 * and SIGKILL them at vx's clean exit.
 */
function stopGuard(): void {
  const fd = guardFd
  guardFd = null
  pending = ''
  guardProc?.kill('SIGKILL')
  if (typeof fd !== 'number') return
  try {
    closeSync(fd)
  } catch {
    // already closed
  }
}

function guardWrite(line: string): void {
  if (typeof guardFd !== 'number') return
  let deadline = performance.now() + GUARD_STALL_MS
  // A turn's batch can be more than the queue takes at once: it goes in
  // pieces as the guard drains it, and only a guard that takes nothing for
  // the whole stall is gone. With one deadline for the batch, 2000 strikes
  // outlasted it on macOS and the guard was stopped under a live run.
  let bytes = Buffer.from(line)
  for (;;) {
    try {
      const n = writeSync(guardFd, bytes, 0, Math.min(bytes.length, GUARD_PIECE))
      if (n === bytes.length) return
      bytes = bytes.subarray(n)
      deadline = performance.now() + GUARD_STALL_MS
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN' || performance.now() >= deadline) break
      Bun.sleepSync(1)
    }
  }
  stopGuard()
}

/**
 * Lines waiting for this turn's one write: strikes, and the listings of spare
 * shells. Each line was a write of its own and a wake of the guard's shell: on
 * a cold run of 500 tasks, 38 ms of vx's main thread for the strikes and 140 ms
 * of the guard's CPU. If vx dies in the turn a task ended, what that task left
 * in the background dies with it, as when vx dies a moment before the task
 * ends.
 */
let pending = ''
let pendingTimer: ReturnType<typeof setImmediate> | undefined

function queueLine(line: string): void {
  pending += line
  pendingTimer ??= setImmediate(flushGuard)
}

/** Write the lines this turn queued now: before a listed child is handed its work. */
export function flushGuard(): void {
  if (pendingTimer !== undefined) clearImmediate(pendingTimer)
  pendingTimer = undefined
  const lines = pending
  pending = ''
  if (lines !== '') guardWrite(lines)
}

/**
 * List `pid`'s group from vx's side, for a child that runs nothing until
 * vx hands it work (a spare shell waiting on its script): the line goes
 * with the turn's others, and `flushGuard` before the hand-over. A spare
 * vx dies before listing reads the end of its script's pipe and exits,
 * having run nothing. Starts the guard.
 */
export function listGroup(pid: number): void {
  startGuard()
  if (typeof guardFd === 'number' && pid > 0) queueLine(`+${pid}\n`)
}

/**
 * Spawn a task child whose group the guard kills if vx dies holding it. The
 * CHILD lists its own group, before it runs anything: vx wrote the line after
 * the spawn returned, and under load the child ran first, so a `kill -9` of vx
 * in between left its group unlisted and alive (4 of 40 runs at tenfold load).
 * `spawn` gets the guard's pipe, to hand the child at some descriptor `n`, and
 * runs `guardLine(n)` in the child's shell first. The child holds the pipe
 * until it has written, so the guard cannot reach EOF before the line: vx's
 * death alone no longer races it. The guard starts BEFORE the spawn, so there
 * is a pipe to hand. `undefined` when the guard could not start: nothing lists
 * anything.
 */
export function spawnGuarded<C = Child>(spawn: (guard: number | undefined) => C): C {
  startGuard()
  // The turn's lines go first, as they did one write each: a child's own
  // listing behind them, not raced by a batch vx writes once it runs.
  flushGuard()
  if (typeof guardFd !== 'number') return spawn(undefined)
  handingTo = guardProc?.pid
  try {
    return spawn(guardFd)
  } finally {
    handingTo = undefined
  }
}

/**
 * The guard whose pipe `spawnGuarded` is handing over right now. Only a
 * line built for that hand-over retries: its pipe is broken only once
 * the guard has exited, so `kill -0` ends the wait. A line for any other
 * pipe would wait on a guard that has nothing to do with it.
 */
let handingTo: number | undefined

/**
 * The shell line that lists `$$`'s group on the guard's pipe at `fd` and
 * closes it, so the task never holds the guard open. `$$` is the spawned
 * shell, which leads its group (every guarded spawn is `detached`); a
 * program that is not a shell is `exec`'d after it. A write to a guard
 * that has died is ignored rather than a SIGPIPE that kills the task.
 * The pipe is vx's own nonblocking one, so a full queue fails the write
 * (EAGAIN) and the group went unlisted: the write is retried while the
 * guard lives. The shell cannot tell EAGAIN from EPIPE, so the guard's
 * pid ends the wait, and vx SIGKILLs a guard it gives up on.
 */
export function guardLine(fd: number): string {
  const add = `printf '+%s\\n' $$ >&${fd} 2>/dev/null`
  // `kill -0` counts a zombie, and a guard vx has not reaped (its event
  // loop busy, or an init that never reaps an orphan after vx's kill -9)
  // kept the shell spinning. Where /proc is ours, its state says dead;
  // `##*) ` cuts at the LAST ')', as comm may hold one.
  const alive = procfsIsOwn()
    ? `{ read -r vx_g </proc/${handingTo}/stat; } 2>/dev/null && case "\${vx_g##*) }" in [ZX]*) false ;; esac`
    : `kill -0 ${handingTo} 2>/dev/null`
  const retry = handingTo === undefined ? '' : ` || until ${add}; do ${alive} || break; done`
  return `trap '' PIPE; ${add}${retry}; trap - PIPE; exec ${fd}>&-; `
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
  else queueLine(`-${child.pid}\n`)
}

/**
 * List what the guard takes down besides groups if vx dies: the sandbox
 * runtime's session. The runtime spawns its bridge socat as a plain child
 * in vx's OWN group, which the guard must never kill, and a `kill -9`
 * leaves its sockets in the temp directory. So each pid is killed alone
 * and each path removed, by a name only that session carries. The
 * returned function strikes them once the session is down, so a pid the
 * kernel reuses is never killed on its account. Starts the guard: a spawn
 * follows. A path holding whitespace is not listed (the lists split on it).
 */
export function guardSession(pids: readonly number[], paths: readonly string[]): () => void {
  startGuard()
  const listed = paths.filter((p) => !/\s/.test(p))
  guardWrite(pids.map((p) => `=${p}\n`).join('') + listed.map((p) => `@${p}\n`).join(''))
  return () => {
    guardWrite(pids.map((p) => `_${p}\n`).join('') + listed.map((p) => `!${p}\n`).join(''))
  }
}

/** Groups a teardown is still taking down: how many hold each, and whether its runner let it go. */
const holds = new Map<number, { count: number; released: boolean }>()

/**
 * Keep `children`'s groups on the guard's list until the returned function
 * runs. A teardown signals a group and waits out a grace for it, and the runner
 * lets a group go when its LEADER exits: a shell that died on the signal while
 * a child that ignores it ran on released the group mid-grace, and a `kill -9`
 * of vx there left that child to nobody. The caller lets go once its SIGKILL
 * sweep has settled.
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
      if (owed.delete(pid) || hold.released) guardWrite(`-${pid}\n`)
    }
  }
}

/**
 * Children whose group was empty when their leader exited. Its number is free
 * from then on, and the kernel hands it to the next process that needs it: a
 * persistent server stays in the run's registry after it exits (keep-alive
 * reports it), and a teardown that signalled `-pid` there could reach whatever
 * group holds the number now. A group that still had a member keeps its number
 * reserved, and is signalled as before.
 */
const goneGroups = new WeakSet<Child>()

/** Server groups that outlived their leader: struck when a teardown next lets them go. */
const owed = new Set<number>()

/**
 * A persistent child's leader has exited. An empty group is struck and
 * never signalled again. One with a member left stays listed until a
 * teardown lets it go: the run's registry still owns a ready server after
 * its shell exits and stops its group at the end, and struck here, the
 * `server` of a `server & echo up` was left to nobody by a `kill -9` of vx.
 */
export function releaseServerGroup(child: Child): void {
  if (groupAlive(child)) {
    owed.add(child.pid)
    return
  }
  goneGroups.add(child)
  releaseGroup(child)
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

let stoppedTotal = 0
let stoppedSince: number | undefined

/** vx stopped (Ctrl-Z) or continued (`fg`, `bg`): its tasks' clocks stop with it. */
export function markStopped(stopped: boolean): void {
  if (stopped) stoppedSince ??= performance.now()
  else if (stoppedSince !== undefined) {
    stoppedTotal += performance.now() - stoppedSince
    stoppedSince = undefined
  }
}

/**
 * ms vx has spent stopped so far, a stop still open included: a timer due
 * while vx was stopped runs before the SIGCONT handler closes it.
 */
function stoppedMs(): number {
  return stoppedTotal + (stoppedSince === undefined ? 0 : performance.now() - stoppedSince)
}

/** `performance.now()` less the time vx spent stopped: the clock a task's duration reads. */
export function runTime(): number {
  return performance.now() - stoppedMs()
}

/**
 * Stop or continue `child`'s group with vx (Ctrl-Z, `fg`). Straight to
 * the group, never down a sandbox's channel: its watcher passes one
 * signal and is gone. Under a Linux sandbox that stops bwrap, and the
 * command inside blocks once its output pipe fills.
 */
export function pauseTree(child: Child, signal: 'SIGSTOP' | 'SIGCONT'): void {
  if (!(child.pid > 0) || goneGroups.has(child)) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is gone, or not ours: nothing of it to stop.
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
  const deadline = performance.now() + graceMs
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
  while (left.length > 0 && performance.now() < deadline) {
    await Bun.sleep(Math.min(GROUP_POLL_MS, deadline - performance.now()))
    left = left.filter(groupAlive)
  }
  return left
}

/**
 * Does any process of the child's group still run? `kill(-pgid, 0)` answers for
 * the group but counts a zombie, and an orphaned member that died on the
 * SIGTERM waits as one until init reaps it — 1 to 2 s under a container's init
 * (measured) — so on Linux a group the kernel still knows is read from /proc,
 * where a zombie says so — when /proc is this namespace's. One mounted for
 * another reads as no member at all, and a group that ignored the SIGTERM went
 * un-killed; there the group signal is the answer and the grace ends the wait.
 */
export function groupAlive(child: Child): boolean {
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
