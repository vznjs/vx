// One run at a time per workspace, on this machine.
//
// Two vx processes on one workspace race on every task's OUTPUT TREE: one
// run's clean can delete the other's restored `dist/` after it reported green.
// The cache itself is safe (SQLite waits, an artifact lands by rename inside
// its rows' transaction). So a run takes this lock before it schedules and
// releases it with its cache handle, before a persistent task's wait, so a dev
// server never holds it.
//
// Keyed by the workspace, not the cache dir, and kept in this user's directory
// under the temp dir, so a read-only checkout can take it.
//
// The lock is a directory, HELD while not empty. Its one entry,
// `h-<pid>-<start>-<n>`, names the holder and this taking. It is built beside
// its name and renamed in; a rename onto a directory succeeds only if it is
// absent or empty: atomic take-if-free. Leaving or reclaiming unlinks that
// ENTRY by name, which cannot remove another taking's entry, so a reclaim
// judged on one holder never removes the next one's lock. A pid file, `mkdir`
// or `rm -r` lock is briefly visible without its holder, and a waiter reclaims
// it then: two holders at once under stress.
//
// A holder's pid can come back: the temp dir outlives a container restart, and
// the new container's vx got the dead run's pid and waited for itself. So a
// lock naming OUR pid is stale unless this process placed it (`placed`); on
// Linux the entry carries the start time, so a reused pid or a zombie holder
// is stale too. When the lock cannot be made or read for any reason but held,
// the run says so once and proceeds unlocked: a courtesy between runs, and
// refusing would be worse than the race. Machines sharing a workspace over a
// network file system, or shells with different `TMPDIR`, do not share it.
// Under the workspace it would outlive a reboot, and off Linux a reused pid
// would read as live for good.
//
// Runs inside ONE process share the lock: an embedder running two at once
// coordinates them itself (`RunOptions.inflight`). The first takes it, the
// last to release leaves it.

import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { VX_RUN_TASK_ENV, VX_RUN_WORKSPACE_ENV } from '../exec/index.js'
import { isTmpdirRefusal, procfsIsOwn, TMPDIR_HINT, UserError, xxh3hex } from '../util/index.js'

/** Runs in this process currently holding the lock, per lock directory. */
const heldHere = new Map<string, number>()
/** The entry this process's taking of each held lock wrote. */
const takers = new Map<string, string>()
/**
 * Every entry this process has placed and not yet left, listed before its
 * rename: a concurrent taking here reads it before `heldHere` names it, and
 * must wait for it, not reclaim it as a dead run of this pid.
 */
const placed = new Set<string>()
/**
 * Staging directories made and not yet renamed or removed: an exit between
 * the mkdir and the rename left one, randomly named, in the lock root for
 * good, no later taking knowing its name.
 */
const staged = new Set<string>()

/**
 * A signal exit is `process.exit` (signals.ts): no finally runs and nothing is
 * awaited, so a Ctrl-C left this process's entry, and the lock directory, in
 * the temp dir for the next run to reclaim. The process's own `exit` event is
 * the one step every exit path passes, and it runs synchronously.
 */
let exitHooked = false
function releaseOnExit(): void {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    for (const dir of staged) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort on the way out
      }
    }
    for (const [lockDir, entry] of takers) {
      // The entry may be gone already: a release under way unlinked it and was
      // still to remove the directory.
      try {
        unlinkSync(path.join(lockDir, entry))
      } catch {
        // reclaimed already, or released
      }
      try {
        rmdirSync(lockDir)
      } catch {
        // another run took the emptied name: its entry is in it
      }
    }
  })
}

/** Polling cadence while another run holds the lock. */
const POLL_MS = 50
/** How long a wait stays silent before the run says whom it is waiting for. */
const SAY_AFTER_MS = 1_000

/** An older vx's holder file: its pid and, on Linux, its start time. */
const LEGACY_PID = 'pid'

export interface RunLockOptions {
  /** Where the lock directories live; this user's own directory in `os.tmpdir()` unless a test says otherwise. */
  dir?: string
  /** A status line for the unlocked warning, and the waiting notice when `wait` is absent. */
  log: (line: string) => void
  /** The waiting notice: taking turns is normal, not a warning (a run's footer counts those). */
  wait?: (line: string) => void
  /** Abort the wait (Ctrl-C, an embedder's signal). */
  signal?: AbortSignal | undefined
  /**
   * `'lock'`: the workspace's other lock, held by a `vx lock` writing the
   * lock and its review copies, which a run does not take: two at once left
   * a review copy and the lock from different runs.
   */
  of?: 'lock'
}

/** Releases a taken run lock; `path` is its directory (`runLockPath`). */
export type RunLockRelease = (() => Promise<void>) & { readonly path: string }

/**
 * The lock directory for a workspace root: stable across this user's runs,
 * private to this machine. Keyed by the REAL path: a CLI's cwd comes back
 * canonical while a caller may hold a symlinked spelling (macOS's /var ->
 * /private/var), and two spellings of one workspace must meet.
 */
export function runLockPath(workspaceRoot: string, dir = userLockRoot(os.tmpdir())): string {
  const resolved = path.resolve(workspaceRoot)
  let real = resolved
  try {
    real = realpathSync(resolved)
  } catch {
    // A root that is not there yet (a test's placeholder) keys by its spelling.
  }
  return path.join(dir, `vx-run-${xxh3hex(real)}`)
}

/**
 * This user's own directory for locks under `dir`: a lock in the shared temp
 * dir is anyone's to plant, and another user's held lock naming a live pid
 * made every run wait. Two users on one checkout no longer exclude each other.
 */
function userLockRoot(dir: string): string {
  const uid = process.getuid?.()
  return uid === undefined ? dir : path.join(dir, `vx-runs-${uid}`)
}

/** The roots this process has made or checked. */
const ownedRoots = new Set<string>()

/**
 * Make the lock's root, or refuse it when it is not this user's own
 * directory (a link, another owner): a lock read there is anyone's.
 */
function ownLockRoot(lockDir: string): void {
  const root = path.dirname(lockDir)
  const uid = process.getuid?.()
  if (uid === undefined || ownedRoots.has(root)) return
  // Not recursive: a temp directory that is not there is the warning
  // that names TMPDIR, never one vx makes.
  try {
    mkdirSync(root, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const st = lstatSync(root)
  if (!st.isDirectory() || st.uid !== uid) {
    throw new Error(
      `${root} is not this user's own directory (a link or another owner's); remove it`,
    )
  }
  if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700)
  ownedRoots.add(root)
}

interface Holder {
  pid: number
  /** The holder's start time as `procStat` read it; null where the lock names none. */
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
 * `/proc/<pid>/stat` from field 3 on: the state first, and at [19] field
 * 22, the start time in clock ticks since boot, where two processes that
 * wore one pid differ. Null off Linux, where the answer costs a `ps`
 * spawn, under a procfs mounted for another pid namespace, and for a pid
 * procfs does not show.
 */
function procStat(pid: number | 'self'): string[] | null {
  if (!procfsIsOwn()) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Fields after the LAST ')' start at field 3; comm may hold spaces.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  } catch {
    return null
  }
}

/** This process's pid and start time as an entry names them, read once per process. */
let ownId: string | undefined
/** Tells this process's takings of a lock apart, and their staging names. */
let takings = 0
function nextEntry(): string {
  ownId ??= `h-${process.pid}-${procStat('self')?.[19] ?? 'x'}`
  return `${ownId}-${++takings}`
}

/**
 * Is the lock's holder a live run of another process? Read on every poll:
 * a holder killed whose parent does not reap it (a container's pid 1 that
 * never waits) is a zombie, which signal 0 still reaches and whose start
 * time still matches, and a wait that trusted either waited for it until
 * the reaper came, or for good.
 */
function holderLive(h: Holder): boolean {
  if (h.pid === process.pid) return placed.has(h.entry)
  if (!alive(h.pid)) return false
  const stat = procStat(h.pid)
  if (stat === null) return true
  if (stat[0] === 'Z' || stat[0] === 'X') return false
  return h.start === null || stat[19] === h.start
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
  // Listed before the mkdir: the exit hook removes what it lists.
  staged.add(staging)
  releaseOnExit()
  try {
    await mkdir(staging)
  } catch (err) {
    staged.delete(staging)
    throw err
  }
  placed.add(entry)
  try {
    await writeFile(path.join(staging, entry), '')
    await rename(staging, lockDir)
    return entry
  } catch (err) {
    placed.delete(entry)
    await rm(staging, { recursive: true, force: true })
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return null
    throw err
  } finally {
    staged.delete(staging)
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
 * runs it on every exit path. It carries the lock's `path`, so a run's
 * live socket beside it costs no second realpath and hash.
 */
export async function acquireRunLock(
  workspaceRoot: string,
  opts: RunLockOptions,
): Promise<RunLockRelease> {
  const lockDir = `${runLockPath(workspaceRoot, opts.dir)}${opts.of === 'lock' ? '-lock' : ''}`
  const what = opts.of === 'lock' ? 'vx lock' : 'vx run'
  // A task's own process (`vx cache clean` in a task) would wait for the
  // run that started it, which holds the lock until that task ends.
  // Empty is unset: resolved, '' named the cwd.
  const outer = process.env[VX_RUN_WORKSPACE_ENV] || undefined
  if (opts.of === undefined && outer !== undefined && runLockPath(outer, opts.dir) === lockDir) {
    throw new UserError(
      `this vx runs inside task ${process.env[VX_RUN_TASK_ENV] ?? '<unknown>'} of a vx run on this workspace, which holds its run lock until it ends — run it before or after that run, not from one of its tasks`,
    )
  }
  const started = Date.now()
  let said = false
  const release = async (): Promise<void> => {
    const left = (heldHere.get(lockDir) ?? 1) - 1
    if (left > 0) {
      heldHere.set(lockDir, left)
      return
    }
    heldHere.delete(lockDir)
    const taker = takers.get(lockDir)
    // Leaving: a taking here from now on may reclaim it, as before its unlink.
    if (taker !== undefined) placed.delete(taker)
    // Unlinking this taking's own entry proves no later run reclaimed the
    // lock: had one, the entry is gone and nothing else is touched. A run that
    // joined another's taking in this process leaves through the taker's
    // entry, whichever release comes last. The taker stays listed until the
    // directory is gone, or a signal exit between unlink and rmdir left the
    // directory with nothing for the exit hook to remove.
    try {
      if (taker !== undefined) await leave(lockDir, taker)
    } finally {
      if (takers.get(lockDir) === taker) takers.delete(lockDir)
    }
  }
  const held: RunLockRelease = Object.assign(release, { path: lockDir })
  for (;;) {
    if (opts.signal?.aborted === true) return Object.assign(async () => {}, { path: lockDir })
    const here = heldHere.get(lockDir) ?? 0
    if (here > 0) {
      heldHere.set(lockDir, here + 1)
      return held
    }
    let h: Holder | 'free' | null
    try {
      // A caller's own `dir` (a test's) is theirs to vouch for.
      if (opts.dir === undefined) ownLockRoot(lockDir)
      const entry = await place(lockDir)
      if (entry !== null) {
        heldHere.set(lockDir, 1)
        takers.set(lockDir, entry)
        return held
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
      } else if (!holderLive(h)) {
        if (h.entry === LEGACY_PID) await rm(lockDir, { recursive: true, force: true })
        else await leave(lockDir, h.entry)
        continue
      }
    } catch (err) {
      // The lock lives in the temp directory; one that is missing or not
      // writable names its knob (a minimal image).
      const hint = isTmpdirRefusal(err) ? `; ${TMPDIR_HINT}` : ''
      opts.log(
        `[vx] no ${opts.of ?? 'run'} lock for this workspace (${(err as Error).message}${hint}) — another ${what} on it at the same time may race this one`,
      )
      return Object.assign(async () => {}, { path: lockDir })
    }
    if (h !== null && !said && Date.now() - started >= SAY_AFTER_MS) {
      said = true
      // Spelled out: the Troubleshooting page quotes the run's line as printed.
      ;(opts.wait ?? opts.log)(
        opts.of === 'lock'
          ? `[vx] waiting for another vx lock (pid ${h.pid}) on this workspace to finish…`
          : `[vx] waiting for another vx run (pid ${h.pid}) on this workspace to finish…`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}
