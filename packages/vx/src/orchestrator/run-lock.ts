// One run at a time per workspace, on this machine.
//
// Two vx processes on one workspace race on every task's OUTPUT TREE: both
// clean and restore the same `dist/`, and a clean landing while the other
// run's restore is staging takes its files out from under it (item 215).
// The cache itself is safe (SQLite waits, artifacts land by rename); the
// tree is not, and a run that finished "green" can have had its restored
// outputs deleted by the other run's clean a moment later. So a run takes
// this lock before it schedules and releases it with its cache handle —
// before a persistent task's wait, so a dev server never holds it.
//
// Keyed by the workspace, not the cache directory (`--cache-dir` must not
// make two runs strangers), and kept under the temp directory so a
// read-only checkout can take it. An atomic `mkdir` is the lock; a `pid`
// file inside names the holder, so a lock a killed run left behind is
// reclaimed when its pid is gone. A pid can come back: the temp directory
// outlives a container restart, and the restarted container's vx got the
// dead run's pid (1) and waited for itself forever (nx#36473 reproduced
// on vx, 2026-09-24). So a lock naming OUR pid is stale — a run of this
// process would be in `heldHere` — and on Linux the file also carries the
// holder's start time, so a pid another process now wears is stale too.
// Where the directory cannot be made for
// any reason but "exists" (another user's stale lock, a temp directory
// this user cannot write), the run says so once and proceeds unlocked:
// the lock is a courtesy between cooperating runs, and refusing to run
// would be worse than the race. Machines sharing a workspace over a
// network file system do not share `/tmp`, so they do not share this.
//
// Runs inside ONE process share the lock: an embedder that runs two at
// once coordinates them itself (`RunOptions.inflight` joins duplicate
// tasks across them), and making them wait for each other would only
// serialize what it chose to overlap. The directory is taken by the first
// of them and removed by the last to release.

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isTmpdirRefusal, TMPDIR_HINT, xxh3hex } from '../util/index.js'

/** Runs in this process currently holding the lock, per lock directory. */
const heldHere = new Map<string, number>()

/** Polling cadence while another run holds the lock. */
const POLL_MS = 50
/** How long a wait stays silent before the run says whom it is waiting for. */
const SAY_AFTER_MS = 1_000

export interface RunLockOptions {
  /** Where the lock directories live; `os.tmpdir()` unless a test says otherwise. */
  dir?: string
  /** A status line for the waiting notice and the unlocked warning. */
  log: (line: string) => void
  /** Abort the wait (Ctrl-C, an embedder's signal). */
  signal?: AbortSignal | undefined
}

/** The lock directory for a workspace root: stable across runs and users, private to this machine. */
export function runLockPath(workspaceRoot: string, dir = os.tmpdir()): string {
  return path.join(dir, `vx-run-${xxh3hex(path.resolve(workspaceRoot))}`)
}

interface Holder {
  pid: number
  /** The holder's start time as `startTime` read it; null where the file names none. */
  start: string | null
}

async function holder(lockDir: string): Promise<Holder | null> {
  try {
    const [pidText, start] = (await readFile(path.join(lockDir, 'pid'), 'utf8')).trim().split(' ')
    const pid = Number.parseInt(pidText ?? '', 10)
    return Number.isInteger(pid) && pid > 0 ? { pid, start: start ?? null } : null
  } catch {
    return null
  }
}

/**
 * When a process started, in clock ticks since boot: field 22 of
 * `/proc/<pid>/stat`. Two processes that wore one pid differ here. Null
 * off Linux, where the answer costs a `ps` spawn per run, and for a pid
 * procfs does not show.
 */
function startTime(pid: number | 'self'): string | null {
  if (process.platform !== 'linux') return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Fields after the LAST ')' start at field 3; comm may hold spaces.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

/** This process's own line for the pid file, read once per process. */
let ownLine: string | undefined
function ownPidLine(): string {
  if (ownLine === undefined) {
    const start = startTime('self')
    ownLine = start === null ? `${process.pid}\n` : `${process.pid} ${start}\n`
  }
  return ownLine
}

/**
 * Is the lock's holder a live run of another process? `sameAsLast`: this
 * holder's start time already matched on an earlier poll, so a wait reads
 * procfs once per holder, not once per poll.
 */
function holderLive(h: Holder, sameAsLast: boolean): boolean {
  if (h.pid === process.pid) return false
  if (!alive(h.pid)) return false
  if (h.start === null || sameAsLast) return true
  const now = startTime(h.pid)
  return now === null || now === h.start
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but is another user's — alive, not ours to
    // reclaim. ESRCH: gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Take the workspace's run lock, waiting for a live holder in another
 * process to release it. Resolves to the release function; the caller
 * runs it on every exit path.
 */
export async function acquireRunLock(
  workspaceRoot: string,
  opts: RunLockOptions,
): Promise<() => Promise<void>> {
  const lockDir = runLockPath(workspaceRoot, opts.dir)
  const pidFile = path.join(lockDir, 'pid')
  const started = Date.now()
  let said = false
  let lastLive: Holder | undefined
  const release = async (): Promise<void> => {
    const left = (heldHere.get(lockDir) ?? 1) - 1
    if (left > 0) {
      heldHere.set(lockDir, left)
      return
    }
    heldHere.delete(lockDir)
    // Only the holder removes it: a reclaim by a later run must not be
    // undone by the run that lost the directory. The read is that proof,
    // not a repeat of the write: another run may have rewritten the file.
    // What this run made holds the pid file and nothing else, so it goes
    // as two calls where `rm -r` spent an unlink that fails EISDIR, an
    // open and a listing first.
    if ((await holder(lockDir))?.pid === process.pid) {
      await unlink(pidFile)
      await rmdir(lockDir)
    }
  }
  for (;;) {
    if (opts.signal?.aborted === true) return async () => {}
    const here = heldHere.get(lockDir) ?? 0
    if (here > 0) {
      heldHere.set(lockDir, here + 1)
      return release
    }
    try {
      await mkdir(lockDir)
      await writeFile(pidFile, ownPidLine())
      heldHere.set(lockDir, 1)
      return release
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        // The lock lives in the temp directory; one that is missing or not
        // writable names its knob (a minimal image, 2026-09-16).
        const hint = isTmpdirRefusal(err) ? `; ${TMPDIR_HINT}` : ''
        opts.log(
          `[vx] no run lock for this workspace (${(err as Error).message}${hint}) — another vx run on it at the same time may race this one`,
        )
        return async () => {}
      }
    }
    const h = await holder(lockDir)
    const sameAsLast = h !== null && lastLive?.pid === h.pid && lastLive.start === h.start
    if (h === null || !holderLive(h, sameAsLast)) {
      // A killed run's lock (or a directory with no pid yet: give the
      // holder one poll to write it, then treat it as abandoned).
      if (h !== null || Date.now() - started >= POLL_MS) {
        await rm(lockDir, { recursive: true, force: true })
        continue
      }
    } else {
      lastLive = h
      if (!said && Date.now() - started >= SAY_AFTER_MS) {
        said = true
        opts.log(`[vx] waiting for another vx run (pid ${h.pid}) on this workspace to finish…`)
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}
