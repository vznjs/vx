// `vx watch`'s file-system side: the OS watcher and the proof it delivers,
// the stat poller that stands in where it cannot, and the clock both are
// judged against. Nothing here knows about tasks, cycles or the cache.

import fs from 'node:fs'
import path from 'node:path'

/** Paths whose changes never trigger a re-run. */
export const IGNORED_SEGMENTS = ['node_modules', '.git', '.vx']

/**
 * The file `armWatcher` writes under a watched directory to prove the
 * watcher delivers. Intercepted by name before any other handling, so it
 * can never trigger a cycle, and removed before "watching" is printed.
 */
export const WATCH_PROBE = '.vx-watch-probe'

/** How long a watcher gets to report its own probe before the loop goes on without proof. */
export const WATCH_PROBE_TIMEOUT_MS = 2_000
/** The file `fsClockNow` writes and removes, under the cache dir the watchers ignore. */
const WATCH_CLOCK_STAMP = '.vx-watch-clock'

/** Anything the loop needs to shut down at exit. */
export interface WatchHandle {
  close(): void
}

export interface ArmedWatcher {
  watcher: WatchHandle
  /** Resolves `true` once the watcher reported the probe, `false` on timeout. */
  ready: Promise<boolean>
}

/** How often the fallback re-walks a watched tree. */
const POLL_INTERVAL_MS = 250

/**
 * Directory names the fallback never descends into WHEN no better filter is
 * supplied. The justification is that `makeWatchIgnore` already drops their
 * EVENTS, so the walk buys nothing — a poller pays for it either way, and
 * `node_modules` is the difference between a cheap fallback and one that
 * re-stats 40 000 files four times a second.
 *
 * That justification is exactly `IGNORED_SEGMENTS`, so this IS that set.
 * It used to carry a fourth name, `dist`, which the justification does NOT
 * cover: `dist` is dropped only when a project DECLARES it as an output, and
 * a project that does not declare it had its `dist/` sources silently
 * invisible to `vx watch` on every host the poller exists for — a macOS
 * sandbox, a network mount, a container bind — while the native watcher
 * delivered them. Two watchers disagreeing about what an edit is (item 482).
 * The real per-project answer is the caller's `skipDir`, below.
 */
const POLL_SKIP = new Set(IGNORED_SEGMENTS)

/**
 * A watcher built from `stat`, for when the OS one cannot deliver.
 *
 * `fs.watch` on macOS is FSEvents, which needs `mach-lookup` on
 * `com.apple.FSEvents`; inside a sandbox that does not grant it the call
 * SUCCEEDS and then never fires (measured 2026-09-05: 0 events recursive,
 * 0 non-recursive, against 3 and 2 for the same writes outside — while
 * `fs.watchFile` polling delivered in both). A network filesystem or a
 * container bind mount fails the same way. Polling is slower and coarser,
 * and it is the difference between `vx watch` working there and silently
 * doing nothing.
 */
export function pollWatcher(
  dir: string,
  recursive: boolean,
  onEvent: (filename: string) => void,
  intervalMs = POLL_INTERVAL_MS,
  /**
   * Directories not worth descending into, by their path relative to `dir`.
   * The watch loop passes its own event filter, so the poller skips exactly
   * what the filter would drop anyway — every declared output container, not
   * a hard-coded name. The default covers the unconditional segments alone.
   */
  skipDir: (rel: string) => boolean = (rel) => POLL_SKIP.has(path.basename(rel)),
): WatchHandle {
  let previous = new Map<string, number>()
  let first = true
  const scan = (): void => {
    const current = new Map<string, number>()
    const walk = (abs: string, rel: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return // vanished or unreadable: its files simply stop appearing
      }
      for (const e of entries) {
        if (e.name === WATCH_PROBE) continue
        const childRel = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isDirectory()) {
          if (recursive && !skipDir(childRel)) walk(path.join(abs, e.name), childRel)
          continue
        }
        if (!e.isFile()) continue
        try {
          // The later of the two clocks, as `modifiedBefore` reads them: a
          // replacement that carries the old file's mtime (`cp -p`, `rsync
          // -a`, `mv` of a file stamped the same) moved nothing under mtime
          // alone, and the poller never ran it where the native watcher did.
          // A rename or a write moves ctime, and no process can set it.
          const st = fs.statSync(path.join(abs, e.name))
          current.set(childRel, Math.max(st.mtimeMs, st.ctimeMs))
        } catch {
          // raced with a delete; the next scan settles it
        }
      }
    }
    walk(dir, '')
    if (!first) {
      for (const [rel, mtime] of current) {
        if (previous.get(rel) !== mtime) onEvent(rel)
      }
      for (const rel of previous.keys()) {
        if (!current.has(rel)) onEvent(rel)
      }
    }
    previous = current
    first = false
  }
  scan()
  // Deliberately NOT unref'd: once the native watcher is closed this timer
  // is the only thing keeping `vx watch` alive.
  const timer = setInterval(scan, intervalMs)
  return {
    close(): void {
      clearInterval(timer)
    },
  }
}

/**
 * `fs.watch` plus proof of delivery. On macOS a recursive watcher is an
 * FSEvents stream that another thread schedules AFTER the call returns, and
 * a change landing in that gap is never delivered — MEASURED 2026-09-03: a
 * write made immediately after `fs.watch` was lost 5 times in 30 under CPU
 * load (0 in 30 idle, 0 in 30 after a 50 ms pause). The gap has no fixed
 * width, so no pause is the answer and no timeout on the waiting side ever
 * was (the e2e flake this closes had one of 45 s). A probe file written
 * under the watcher and waited for is: once ITS event arrives, the stream
 * is live for everything after it.
 *
 * `onEvent` never sees the probe (create or unlink), and the probe is
 * removed before `ready` resolves.
 */
export function armWatcher(
  dir: string,
  recursive: boolean,
  onEvent: (filename: string) => void,
  timeoutMs = WATCH_PROBE_TIMEOUT_MS,
): ArmedWatcher {
  let markReady: (ok: boolean) => void = () => {}
  let arrived = false
  const seen = new Promise<boolean>((resolve) => {
    markReady = resolve
  })
  const listener = (filename: string | null): void => {
    if (filename == null || typeof filename !== 'string') return
    // An event naming the watched directory itself (macOS reports the
    // directory a write landed in as its own item) carries nothing a key
    // can see; the write's own event names the file.
    if (filename === '' || filename === '.') return
    if (filename === WATCH_PROBE) {
      arrived = true
      markReady(true)
      return
    }
    // Another arm's probe, seen by this recursive watcher under a nested
    // directory (a nested project's, a member base inside a project): no
    // key sees it, and passing it on ran a cycle, and restarted a dev
    // server, with no edit made (item 1016). Only the watcher's own probe
    // proves this stream live.
    if (path.basename(filename) === WATCH_PROBE) return
    onEvent(filename)
  }
  const watcher: WatchHandle =
    recursive && process.platform === 'linux'
      ? treeWatcher(dir, listener)
      : fs.watch(dir, { recursive, persistent: true }, (_event, filename) => listener(filename))
  const probe = path.join(dir, WATCH_PROBE)
  const ready = (async (): Promise<boolean> => {
    // The probe is subject to the very race it detects: a write that lands
    // in the gap is lost like any other (1 in 20 under a full gate's load,
    // measured 2026-09-03, with every delivered event under 60 ms). So it is
    // re-written on a short backoff until its event arrives — the first write
    // after the stream goes live is the one that proves it.
    const deadline = Date.now() + timeoutMs
    let ok = false
    let step = 50
    while (!ok) {
      try {
        fs.writeFileSync(probe, String(Date.now()))
      } catch {
        break // an unwritable dir gets no proof; the watcher is kept
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        // The write itself can outlast the budget (a loaded macOS runner:
        // 261 ms against 100, E-87), and the loop has not yielded yet: let
        // an event already queued in before giving up on it.
        await new Promise((resolve) => setTimeout(resolve, 0))
        ok = arrived
        break
      }
      const pause = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), Math.min(step, remaining)).unref()
      })
      ok = await Promise.race([seen, pause])
      step = Math.min(step * 2, 400)
    }
    try {
      fs.unlinkSync(probe)
    } catch {
      // already gone
    }
    return ok
  })()
  return { watcher, ready }
}

/**
 * A recursive watch on Linux, built from one non-recursive watch per
 * directory, that never enters `IGNORED_SEGMENTS`. Bun's recursive form is
 * the same inotify watch per directory and descended into all of them:
 * this repo's root arm held 4,657 watches where 438 directories can
 * matter, 40–55 ms of the arm, and a monorepo's `node_modules` met the OS
 * watch limit (8,192 on many distros) and fell back to polling — for
 * events the loop drops by name. A directory that appears is watched, and
 * what it already holds is reported (it may have landed before its watch);
 * one that goes, or moves, is dropped with everything under it, since an
 * inotify watch follows the inode and would report the old name. The
 * arming walk throws at the watch limit, so the pool's fallback still
 * applies; a subdirectory that vanished mid-walk is simply not watched.
 */
function treeWatcher(root: string, listener: (filename: string) => void): WatchHandle {
  const watchers = new Map<string, fs.FSWatcher>()
  // Which directory each watch holds: inotify follows the inode, so a name
  // removed and made again before its event is handled stats as a
  // directory still, and the watch on the deleted one heard nothing more.
  // The birth time too: a freed inode number goes to the next directory.
  const held = new Map<string, string>()
  const idOf = (st: fs.Stats): string => `${st.dev}:${st.ino}:${st.birthtimeMs}`
  let closed = false
  let armed = false
  let warned = false
  const drop = (rel: string): void => {
    // A directory is watched before anything under it, so a path with no
    // watch of its own has none below: a deleted file costs one lookup,
    // not a walk of every watch (an `rm -rf` of 10,000 files).
    if (!watchers.has(rel)) return
    for (const [key, w] of watchers) {
      if (key !== rel && !key.startsWith(rel + '/')) continue
      w.close()
      watchers.delete(key)
      held.delete(key)
    }
  }
  const watchDir = (rel: string, report: boolean): void => {
    if (closed || watchers.has(rel)) return
    const abs = rel === '' ? root : path.join(root, rel)
    let w: fs.FSWatcher
    try {
      w = fs.watch(abs, { persistent: true }, (_event, name) => {
        if (name == null || typeof name !== 'string' || name === '' || name === '.') return
        const child = rel === '' ? name : `${rel}/${name}`
        listener(child)
        if (IGNORED_SEGMENTS.includes(name)) return
        let st: fs.Stats
        try {
          st = fs.statSync(path.join(abs, name))
        } catch {
          drop(child)
          return
        }
        if (!st.isDirectory()) return
        if (watchers.has(child)) {
          if (held.get(child) === idOf(st)) return
          drop(child)
        }
        watchDir(child, true)
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const limit = code === 'ENOSPC' || code === 'EMFILE'
      // The walk that arms is all or nothing at the watch limit, as the
      // recursive form was, so the pool's fallback polls instead of a
      // tree half watched without a word.
      if (rel === '' || (limit && !armed)) throw err
      if (limit && !warned) {
        warned = true
        process.stderr.write(
          `vx watch: ${abs}: the OS watch limit is reached (${code}); directories made from here on are not watched — raise it (Linux: sysctl fs.inotify.max_user_watches)\n`,
        )
      }
      return
    }
    w.on('error', () => drop(rel))
    watchers.set(rel, w)
    try {
      held.set(rel, idOf(fs.statSync(abs)))
    } catch {
      held.set(rel, '')
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!IGNORED_SEGMENTS.includes(e.name)) watchDir(child, report)
      } else if (report) listener(child)
    }
  }
  try {
    watchDir('', false)
  } catch (err) {
    for (const w of watchers.values()) w.close()
    throw err
  }
  armed = true
  return {
    close(): void {
      closed = true
      for (const w of watchers.values()) w.close()
      watchers.clear()
      held.clear()
    },
  }
}

/** True when `abs` was last modified before `t` (epoch ms); false when it cannot be read. */
export function modifiedBefore(abs: string, t: number): boolean {
  try {
    // The later of the two clocks: `mv`, `cp -p`, `rsync -a` and `tar x`
    // carry a file's OLD mtime onto the new one, and judged by mtime alone
    // such an edit was "before the arm" and never ran (item 945). No
    // process can set a ctime, and a rename or a write moves it.
    const st = fs.statSync(abs)
    return Math.max(st.mtimeMs, st.ctimeMs) < t
  } catch {
    return false
  }
}

/**
 * "Now" as the filesystem will stamp the next write, not as `Date.now()`
 * reads it. A file's mtime comes from the kernel's coarse clock, which
 * runs up to a tick behind the fine clock `Date.now()` reads — measured
 * on the Linux bench box 2026-09-11: 2 of 3,000 tight writes carried an
 * mtime 5.8 ms EARLIER than a `Date.now()` taken before the write, and
 * more under CPU load, where the tick is skipped. An `armedAt` from the
 * fine clock then judged an edit made right after the ready line as
 * "modified before the arm" and dropped it (the watch e2e flake, three
 * shard runs that day; traced: raw event, trigger, `same=true`). A stamp
 * read off a file written here is on the mtime clock itself, and every
 * later write's mtime is at or after it.
 */
export function fsClockNow(dir: string): number {
  const stamp = path.join(dir, WATCH_CLOCK_STAMP)
  try {
    fs.writeFileSync(stamp, '')
    const at = fs.statSync(stamp).mtimeMs
    fs.unlinkSync(stamp)
    return at
  } catch {
    return Date.now()
  }
}

/** A handle that watches nothing: a slot a drop emptied, an arm not made. */
export const CLOSED: WatchHandle = { close() {} }

/**
 * Every watcher `vx watch` arms. Each OS watcher proves delivery or is
 * swapped for the poller in its slot; an OS watch limit (ENOSPC, EMFILE)
 * goes straight to the poller; `VX_WATCH_POLL=1` polls from the start.
 * `skip` is what the poller leaves unsampled, asked on each walk.
 */
export class WatcherPool {
  private readonly watchers: WatchHandle[] = []
  private readonly proofs: Promise<void>[] = []
  // `VX_WATCH_POLL=1` skips the OS watcher entirely. Where it is known not
  // to work — a sandbox with no `machLookup` for `com.apple.FSEvents`, a
  // network mount, a container bind — the attempt costs a denied syscall
  // and a two-second wait before the fallback takes over anyway.
  private readonly forcePoll = (process.env['VX_WATCH_POLL'] ?? '') !== ''

  constructor(private readonly skip: (dir: string, rel: string) => boolean) {
    if (this.forcePoll)
      process.stderr.write(`vx watch: polling every ${POLL_INTERVAL_MS} ms (VX_WATCH_POLL)\n`)
  }

  private poll(dir: string, recursive: boolean, onEvent: (filename: string) => void): WatchHandle {
    return pollWatcher(dir, recursive, onEvent, POLL_INTERVAL_MS, (rel) => this.skip(dir, rel))
  }

  // By slot, not by handle: an OS watcher that never proves delivery is
  // swapped for a poller in place, and a drop must close what is there.
  arm(dir: string, recursive: boolean, onEvent: (filename: string) => void): WatchHandle {
    const watchers = this.watchers
    const at = watchers.length
    const handle: WatchHandle = {
      close: () => {
        watchers[at]?.close()
        watchers[at] = CLOSED
      },
    }
    if (this.forcePoll) {
      watchers.push(this.poll(dir, recursive, onEvent))
      return handle
    }
    let armed: ArmedWatcher
    try {
      armed = armWatcher(dir, recursive, onEvent)
    } catch (err) {
      // The OS's watch limit, not the directory: the loop said "watching"
      // and never fired. The poller needs no watch slot.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOSPC' && code !== 'EMFILE') throw err
      watchers.push(this.poll(dir, recursive, onEvent))
      process.stderr.write(
        `vx watch: ${dir}: the OS watch limit is reached (${code}); polling every ${POLL_INTERVAL_MS} ms instead — raise it (Linux: sysctl fs.inotify.max_user_watches) to watch natively\n`,
      )
      return handle
    }
    watchers.push(armed.watcher)
    this.proofs.push(
      armed.ready.then((ok) => {
        if (ok) return
        armed.watcher.close()
        // Dropped by a rearm before its proof settled: nothing to swap in.
        if (watchers[at] !== armed.watcher) return
        // The watcher never proved delivery, so it is not one: an FSEvents
        // stream the OS refused, a filesystem that reports nothing. Swap in
        // the poller rather than run a loop that silently never fires.
        watchers[at] = this.poll(dir, recursive, onEvent)
        process.stderr.write(
          `vx watch: ${dir}: no OS watch events within ${WATCH_PROBE_TIMEOUT_MS} ms; polling every ${POLL_INTERVAL_MS} ms instead\n`,
        )
      }),
    )
    return handle
  }

  /** Settles once every arm so far has proved delivery or fallen back. */
  async proved(): Promise<void> {
    await Promise.all(this.proofs)
  }

  closeAll(): void {
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
  }
}
