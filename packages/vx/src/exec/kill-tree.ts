// Signal a task and everything it forked. Each task child is spawned `detached`
// (its own session and group), so the group is the task's tree: the shell, what
// it backgrounded, a runner's workers. Signalling the child alone orphaned `x`
// in `sh -c "x & y"`. A group signal also reaches members whose parent died
// first. Only a daemon that calls setsid itself escapes (every non-cgroup
// runner shares that); a sandbox's pid namespace takes even that.

import { closeSync, readdirSync, readFileSync, writeSync } from 'node:fs'
import { helperEnv, procfsIsOwn, taskShell } from '../util/index.js'

export type Child = ReturnType<typeof Bun.spawn>

/**
 * A child whose polite signals go down a pipe, not to its group: a Linux
 * sandboxed task. Its group is bwrap's, whose monitor dies of SIGTERM and
 * SIGKILLs the namespace, so the command's cleanup never ran; a shell inside
 * reads the signal's name and signals the command's group. SIGKILL still goes
 * to the group.
 */
const channels = new Map<Child, number>()

/** Route `child`'s SIGINT and SIGTERM through `fd`, an end vx owns. */
export function signalThrough(child: Child, fd: number): void {
  channels.set(child, fd)
}

/**
 * Close `child`'s channel once it exited; entry before descriptor, so no later
 * kill writes to a reused number.
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
 * The groups vx must take down if it dies without running a line (`kill -9`,
 * the OOM killer): one `sh` per vx process, its own group, reading a pipe only
 * vx can write. `+<pgid>` and `-<pgid>` keep its list; when vx dies the pipe
 * hits EOF and every listed group is SIGKILLed, as bwrap's `--die-with-parent`
 * does for a sandboxed task. A group signal reaches what the task forked, which
 * `PR_SET_PDEATHSIG` never did (kill-tree.md). Started just before the first
 * spawn, so a warm run never starts it. `undefined` until then, `null` once it
 * failed: best-effort, never a failed task.
 */
let guardFd: number | null | undefined

// Three lists: groups (`+`/`-`), single pids (`=`/`_`), paths to remove
// (`@`/`!`), killed and removed in that order at EOF. A group is listed once
// however often its line arrives: bash as macOS's sh resends a buffered failed
// printf.
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
 * How long a write waits on a lagging guard: Bun opens the pipe nonblocking and
 * the kernel queues ~280 writes, so a burst makes a write EAGAIN while the
 * guard lives.
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
    // A dead guard is handed to no later spawn: its pipe is broken, and bash's
    // buffered printf flushed the failed `+<pgid>` into the task's stdout and
    // its replay.
    void guard.exited.then(() => {
      if (guardFd === fd) stopGuard()
    })
  } catch {
    // The limit as it was: nothing takes the groups down.
  }
}

/**
 * Stop guarding for the rest of the process, and stop the guard: one left alive
 * would SIGKILL every group whose release it missed at vx's clean exit.
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
  // A turn's batch can exceed the queue: it goes in pieces as the guard drains,
  // and only a guard taking nothing for a whole stall is gone. One deadline per
  // batch was outlasted by 2,000 strikes on macOS.
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
 * Lines waiting for this turn's single write: one write each woke the guard's
 * shell per line (500 cold tasks: 38 ms of vx's thread, 140 ms of guard CPU).
 * If vx dies in the turn a task ended, what it left dies too.
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
 * List `pid`'s group from vx's side, for a child running nothing until vx hands
 * it work (a spare shell): the line goes with the turn's others, flushed before
 * the hand-over. A spare whose vx died reads its script pipe's end and exits.
 * Starts the guard.
 */
export function listGroup(pid: number): void {
  startGuard()
  if (typeof guardFd === 'number' && pid > 0) queueLine(`+${pid}\n`)
}

/**
 * Spawn a task child whose group the guard kills if vx dies. The child lists
 * its own group before running anything: listed by vx after the spawn, a `kill
 * -9` in between left it alive (4 of 40 runs under load). `spawn` gets the
 * guard's pipe to hand the child at descriptor `n`, and runs `guardLine(n)`
 * first; the child holds the pipe until written, so the guard cannot hit EOF
 * before the line. `undefined` when the guard could not start.
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
 * The guard whose pipe `spawnGuarded` is handing over now. Only that
 * hand-over's line retries: its pipe breaks only once that guard exits, so
 * `kill -0` ends the wait.
 */
let handingTo: number | undefined

/**
 * The shell line listing `$$`'s group on the guard's pipe at `fd`, then closing
 * it so the task never holds the guard open. `$$` leads its group (every
 * guarded spawn is `detached`); a non-shell program is `exec`'d after. A dead
 * guard's write is ignored, not a task-killing SIGPIPE. A full queue fails with
 * EAGAIN, so the write retries while the guard lives; the shell cannot tell
 * EAGAIN from EPIPE, so the guard's pid ends the wait and vx SIGKILLs a guard
 * it gives up on.
 */
export function guardLine(fd: number): string {
  const add = `printf '+%s\\n' $$ >&${fd} 2>/dev/null`
  // `kill -0` counts a zombie, and an unreaped guard kept the shell spinning.
  // Where /proc is ours its state says dead; `##*) ` cuts at the last ')', as
  // comm may hold one.
  const alive = procfsIsOwn()
    ? `{ read -r vx_g </proc/${handingTo}/stat; } 2>/dev/null && case "\${vx_g##*) }" in [ZX]*) false ;; esac`
    : `kill -0 ${handingTo} 2>/dev/null`
  const retry = handingTo === undefined ? '' : ` || until ${add}; do ${alive} || break; done`
  return `trap '' PIPE; ${add}${retry}; trap - PIPE; exec ${fd}>&-; `
}

/**
 * Strike `child`'s group: vx is done with it, so a reused pid is never killed
 * for the old task. A group a teardown holds is struck when the teardown
 * releases it.
 */
export function releaseGroup(child: Child): void {
  if (!(child.pid > 0)) return
  const hold = holds.get(child.pid)
  if (hold !== undefined) hold.released = true
  else queueLine(`-${child.pid}\n`)
}

/**
 * List what else the guard takes down if vx dies: the sandbox runtime's
 * session. Its bridge socat lives in vx's own group, which the guard must never
 * kill, and a `kill -9` leaves its sockets in the temp dir, so each pid is
 * killed alone and each path removed. The returned function strikes them once
 * the session is down. Starts the guard. A path with whitespace is not listed
 * (lists split on it).
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
 * Keep `children`'s groups listed until the returned function runs. The runner
 * releases a group when its leader exits, and a shell dying on the teardown's
 * signal while a child ignoring it ran on released it mid-grace, leaving that
 * child to nobody after a `kill -9` of vx. Released once the SIGKILL sweep
 * settled.
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
 * Children whose group was empty when their leader exited: the number is free
 * and the kernel reuses it, so a teardown signalling `-pid` (a persistent
 * server stays in the registry after exit) could hit another group. A group
 * with a member left keeps its number and is signalled as before.
 */
const goneGroups = new WeakSet<Child>()

/** Server groups that outlived their leader: struck when a teardown next lets them go. */
const owed = new Set<number>()

/**
 * A persistent child's leader exited. An empty group is struck and never
 * signalled again; one with a member stays listed until a teardown releases it,
 * or the `server` of `server & echo up` was left to nobody by a `kill -9` of
 * vx.
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
 * Stop or continue `child`'s group with vx (Ctrl-Z, `fg`), always straight to
 * the group: a sandbox's watcher passes one signal and is gone. Under a Linux
 * sandbox that stops bwrap, and the command blocks once its pipe fills.
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
 * Wait until every child's group is gone or `graceMs` passes; resolves with
 * those still alive, to SIGKILL. A leader's exit is not the tree's end (a
 * `server & wait` shell dies on SIGTERM while the server keeps the group and
 * pipe), so groups are polled after leaders, only while one is left.
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
 * Does any process of the group still run? `kill(-pgid, 0)` counts a zombie,
 * and an orphan dead of SIGTERM waits 1-2 s for a container's init to reap it,
 * so on Linux /proc decides, when it is this namespace's. Another namespace's
 * /proc reads as no members, so there the group signal answers and the grace
 * ends the wait.
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
