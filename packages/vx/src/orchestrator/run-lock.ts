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
// read-only checkout can take it.
//
// The lock is a directory, HELD exactly while it is not empty. It holds
// one entry, `h-<pid>-<start>-<n>`, naming the holder and unique to this
// taking of it. It is built beside its name and renamed into place, and a
// rename onto a directory succeeds only where that directory is absent or
// empty: the atomic "take it if it is free". Leaving it, or reclaiming it
// from a holder that died, unlinks that one ENTRY by name, and an unlink
// of an entry another taking wrote cannot succeed, so a reclaim judged on
// one holder never removes the next one's lock. The empty directory left
// behind is free, and goes with a best-effort rmdir that fails on anything
// holding an entry.
//
// It was a bare `mkdir`, then a `pid` file, left as an unlink of the file
// and then the rmdir, and reclaimed by `rm -r`: visible without its pid
// for a moment each way, and a waiter that had waited past its grace
// removed that moment as abandoned. Four processes contending for four
// seconds held it two at once 22 times, and a release threw ENOENT out of
// `run()`. Moving a dead holder's lock aside and putting back what was not
// it only narrowed that: a third run could take the name in between, and
// with holders killed mid-hold it did in four stress runs of ten (item
// 759). A `pid` file an older vx wrote is still read and reclaimed; an
// older vx does not read this entry, so the two versions exclude each
// other only as far as the older one's own lock did.
//
// A holder's pid can come back: the temp directory outlives a container
// restart, and the restarted container's vx got the dead run's pid (1) and
// waited for itself forever (nx#36473 reproduced on vx, 2026-09-24). So a
// lock naming OUR pid is stale — a run of this process would be in
// `heldHere` — and on Linux the entry also carries the holder's start
// time, so a pid another process now wears is stale too. Where the lock
// cannot be made or read for any reason but "held" (a temp directory this
// user cannot write), the run says so once and proceeds unlocked: the
// lock is a courtesy between cooperating runs, and refusing to run would
// be worse than the race. Machines sharing a workspace over a network file
// system do not share `/tmp`, so they do not share this.
//
// Runs inside ONE process share the lock: an embedder that runs two at
// once coordinates them itself (`RunOptions.inflight` joins duplicate
// tasks across them), and making them wait for each other would only
// serialize what it chose to overlap. The lock is taken by the first of
// them and left by the last to release.

import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isTmpdirRefusal, procfsIsOwn, TMPDIR_HINT, xxh3hex } from '../util/index.js'

/** Runs in this process currently holding the lock, per lock directory. */
const heldHere = new Map<string, number>()
/** The entry this process's taking of each held lock wrote. */
const takers = new Map<string, string>()

/** Polling cadence while another run holds the lock. */
const POLL_MS = 50
/** How long a wait stays silent before the run says whom it is waiting for. */
const SAY_AFTER_MS = 1_000

/** An older vx's holder file: its pid and, on Linux, its start time. */
const LEGACY_PID = 'pid'

export interface RunLockOptions {
  /** Where the lock directories live; `os.tmpdir()` unless a test says otherwise. */
  dir?: string
  /** A status line for the waiting notice and the unlocked warning. */
  log: (line: string) => void
  /** Abort the wait (Ctrl-C, an embedder's signal). */
  signal?: AbortSignal | undefined
}

/**
 * The lock directory for a workspace root: stable across runs and users,
 * private to this machine. Keyed by the REAL path: a CLI's cwd comes back
 * canonical while a caller may hold a symlinked spelling (macOS's /var ->
 * /private/var), and two spellings of one workspace must meet.
 */
export function runLockPath(workspaceRoot: string, dir = os.tmpdir()): string {
  const resolved = path.resolve(workspaceRoot)
  let real = resolved
  try {
    real = realpathSync(resolved)
  } catch {
    // A root that is not there yet (a test's placeholder) keys by its spelling.
  }
  return path.join(dir, `vx-run-${xxh3hex(real)}`)
}

interface Holder {
  pid: number
  /** The holder's start time as `startTime` read it; null where the lock names none. */
  start: string | null
  /** The entry in the lock directory that names it. */
  entry: string
}

const ENTRY = /^h-(\d+)-(\d+|x)-\d+$/

/**
 * Who holds the lock: 'free' when there is no lock or an empty one, null
 * when it holds nothing read as a holder (an older vx between its mkdir
 * and its pid write).
 */
async function holder(lockDir: string): Promise<Holder | 'free' | null> {
  let entries: string[]
  try {
    entries = await readdir(lockDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'free'
    throw err
  }
  if (entries.length === 0) return 'free'
  for (const entry of entries) {
    const m = ENTRY.exec(entry)
    if (m !== null) return { pid: Number(m[1]), start: m[2] === 'x' ? null : m[2]!, entry }
  }
  if (!entries.includes(LEGACY_PID)) return null
  try {
    const text = await readFile(path.join(lockDir, LEGACY_PID), 'utf8')
    const [pidText, start] = text.trim().split(' ')
    const pid = Number.parseInt(pidText ?? '', 10)
    return Number.isInteger(pid) && pid > 0
      ? { pid, start: start ?? null, entry: LEGACY_PID }
      : null
  } catch {
    return null
  }
}

/**
 * When a process started, in clock ticks since boot: field 22 of
 * `/proc/<pid>/stat`. Two processes that wore one pid differ here. Null
 * off Linux, where the answer costs a `ps` spawn per run, under a procfs
 * mounted for another pid namespace, and for a pid procfs does not show.
 */
function startTime(pid: number | 'self'): string | null {
  if (!procfsIsOwn()) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Fields after the LAST ')' start at field 3; comm may hold spaces.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

/** This process's pid and start time as an entry names them, read once per process. */
let ownId: string | undefined
/** Tells this process's takings of a lock apart, and their staging names. */
let takings = 0
function nextEntry(): string {
  ownId ??= `h-${process.pid}-${startTime('self') ?? 'x'}`
  return `${ownId}-${++takings}`
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
 * Take the lock if it is free: built complete beside its name, then renamed
 * onto it. Resolves to the entry that names this taking, or null when
 * another run holds it.
 */
async function place(lockDir: string): Promise<string | null> {
  const entry = nextEntry()
  // Random too: where procfs is not this namespace's the entry names no
  // start time, and a restarted container's pid 1 would meet the staging
  // directory a killed pid 1 left, and refuse every run after it.
  const staging = `${lockDir}.${entry}.${Math.random().toString(36).slice(2)}`
  await mkdir(staging)
  try {
    await writeFile(path.join(staging, entry), '')
    await rename(staging, lockDir)
    return entry
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return null
    throw err
  }
}

/**
 * Unlink one taking's entry, then the directory if that left it empty.
 * Gone already is not an error (another waiter reclaimed it first); a
 * refusal is (another user's lock), and the caller runs unlocked.
 */
async function leave(lockDir: string, entry: string): Promise<void> {
  try {
    await unlink(path.join(lockDir, entry))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  // A run that took the emptied name already holds it: ENOTEMPTY, and it stays.
  await rmdir(lockDir).catch(() => {})
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
    const taker = takers.get(lockDir)
    takers.delete(lockDir)
    // The unlink of this taking's own entry is the proof no later run
    // reclaimed the lock: had one, the entry is gone and nothing else is
    // touched. A run that joined another's taking in this process leaves
    // through the taker's entry, whichever release comes last.
    if (taker !== undefined) await leave(lockDir, taker)
  }
  for (;;) {
    if (opts.signal?.aborted === true) return async () => {}
    const here = heldHere.get(lockDir) ?? 0
    if (here > 0) {
      heldHere.set(lockDir, here + 1)
      return release
    }
    let h: Holder | 'free' | null
    try {
      const entry = await place(lockDir)
      if (entry !== null) {
        heldHere.set(lockDir, 1)
        takers.set(lockDir, entry)
        return release
      }
      h = await holder(lockDir)
      if (h === 'free') continue
      if (h === null) {
        // An older vx's lock with no pid yet: one poll of this wait, then
        // abandoned, and reclaimed whole as that vx did.
        if (Date.now() - started >= POLL_MS) {
          await rm(lockDir, { recursive: true, force: true })
          continue
        }
      } else if (!holderLive(h, lastLive?.entry === h.entry && lastLive.start === h.start)) {
        if (h.entry === LEGACY_PID) await rm(lockDir, { recursive: true, force: true })
        else await leave(lockDir, h.entry)
        continue
      }
    } catch (err) {
      // The lock lives in the temp directory; one that is missing or not
      // writable names its knob (a minimal image, 2026-09-16).
      const hint = isTmpdirRefusal(err) ? `; ${TMPDIR_HINT}` : ''
      opts.log(
        `[vx] no run lock for this workspace (${(err as Error).message}${hint}) — another vx run on it at the same time may race this one`,
      )
      return async () => {}
    }
    if (h !== null) {
      lastLive = h
      if (!said && Date.now() - started >= SAY_AFTER_MS) {
        said = true
        opts.log(`[vx] waiting for another vx run (pid ${h.pid}) on this workspace to finish…`)
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}
