// Which settled paths are changes: `vx watch`'s judgement, run one debounce
// window after events stop, on what the tree settled to. The loop in
// watch.ts owns when to judge and what to run; this owns what counts.

import fs from 'node:fs'
import path from 'node:path'
import { FILE_HASH_RACY_MS, racyWindowMs } from '../memo/index.js'
import { filesBehind } from '../cache/index.js'
import { commandWindows, type CommandWindows } from '../orchestrator/index.js'
import { printable, xxh3 } from '../util/index.js'
import * as ui from '../ui/index.js'
import { gitIgnored, gitSpeller, gitTracks } from './watch-filter.js'
import { modifiedBefore } from './watch-fs.js'

const ABSENT = -1n
/** A state no judgement saw (`unseen`): equal to none, since a digest is never negative. */
const UNSEEN = -2n
/** `settledState` of a directory with no entries. */
const EMPTY_DIR = xxh3(Buffer.from(''))

function settledState(abs: string): bigint {
  let st: fs.Stats
  try {
    // A link is its target string and what it points to, as the key folds
    // it: following it alone saw a retarget to equal bytes as "the same".
    if (fs.lstatSync(abs).isSymbolicLink())
      return xxh3(`link:${fs.readlinkSync(abs)}\0${behindState(abs)}`)
    st = fs.statSync(abs)
  } catch {
    return ABSENT
  }
  if (!st.isDirectory()) {
    // The mode too: the key reads it (an executable bit can change what a
    // task does), and with the bytes alone a judged file's `chmod -x`
    // settled to "the same" and ran nothing.
    try {
      return xxh3(`${xxh3(fs.readFileSync(abs))}:${st.mode & 0o7777}`)
    } catch {
      return ABSENT
    }
  }
  const entries: string[] = []
  try {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      let size = 0
      if (e.isFile()) {
        try {
          size = fs.statSync(path.join(abs, e.name)).size
        } catch {
          size = -1
        }
      }
      entries.push(`${e.name}\0${e.isDirectory() ? 'd' : size}`)
    }
  } catch {
    return ABSENT
  }
  entries.sort()
  return xxh3(Buffer.from(entries.join('\n')))
}

function isDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory()
  } catch {
    return false
  }
}

/**
 * What a link points to, as change detection reads it: a file's bytes and
 * mode, a directory's files by size and times (cache/linked-inputs.ts keys
 * their bytes), nothing for a dangling link.
 */
function behindState(link: string): string {
  let real: string
  let st: fs.Stats
  try {
    real = fs.realpathSync(link)
    st = fs.statSync(real)
  } catch {
    return ''
  }
  if (st.isFile()) return `${xxh3(fs.readFileSync(real))}:${st.mode & 0o7777}`
  if (!st.isDirectory()) return ''
  return filesBehind(real)
    .map((rel) => {
      try {
        const f = fs.statSync(path.join(real, rel))
        return `${rel}\0${f.size}\0${f.mtimeMs}\0${f.ctimeMs}`
      } catch {
        return rel
      }
    })
    .join('\n')
}

/** What the judgement reads from the loop, which owns it and may replace it. */
export interface JudgeContext {
  workspaceRoot: string
  /** The instant the watchers went live, on the mtime clock (`fsClockNow`). */
  armedAt: number
  /** Whether a persistent server the last cycle started is still running. */
  held(): boolean
  /** The project directories of the servers `held` says run; absent, a server may write anywhere. */
  serverDirs?(): readonly string[]
  /** Projects whose uncached task may read a git-ignored file. */
  uncached(): ReadonlySet<string>
  /** Paths a task's inputs name outright: a git-ignored file at or under one is an input. */
  namedIgnored?(): readonly string[]
  /** Whether `abs`, under the project at `ownDir`, lies in a project nested there (`makeFence`). */
  fenced?(ownDir: string, abs: string): boolean
  /** Whether a watch waits on `abs` itself: a project's directory, or one above it. */
  awaited?(abs: string): boolean
  /** The files git listed at the arm; absent when git could not answer. */
  existedAtArm?: ReadonlySet<string>
  /** "Now" on the mtime clock (`fsClockNow`); `Date.now()` when absent. */
  clock?(): number
  /** The files git tracked at the arm; absent when git could not answer. */
  trackedAtArm?: ReadonlySet<string>
}

export class ChangeJudge {
  // Paths that fired since the last judgement, first label wins. The state
  // check runs when the timer fires, on SETTLED state: per event it is wrong on
  // Linux, where a shell redirect truncates the file (one event, empty) and
  // then writes it (another, full), so consecutive events never agree and a
  // self-write loops anyway (CI: 9 re-runs where macOS, which coalesces the
  // two, saw 2). While a cycle runs, nothing is judged: the run's own writes
  // are mid-flight (a `dist` deleted and not yet rebuilt is a state the tree
  // will not keep), so the paths wait and are judged one window after the run
  // ends, all together — an edit made meanwhile still differs from what the
  // loop last saw and re-runs.
  readonly pending = new Map<string, string>()
  /** The paths the last judgement found changed. */
  changed: readonly string[] = []
  /** The last cycle's window, its start on the mtime clock (`fsClockNow`); a write inside it is the run's own. */
  lastCycle: { start: number; end: number } | undefined
  /**
   * The cycle the last change-finding judgement started: from that
   * judgement on the mtime clock, until the loop sets `to` when its run
   * ends, with the run's command windows (`RunHandoff.commandWindows`).
   */
  cycle: { from: number; to: number; windows: CommandWindows } | undefined
  // Declared outputs are ignored by PATH above. A task with no `cache` block
  // declares none and still writes into its project, and the watcher sees the
  // write: run 1 writes dist/x, the event re-runs, run 2 writes the same bytes,
  // the event re-runs — forever (the init walkthrough: every fresh workspace,
  // since `init` emits no cache block). An undeclared write is caught by STATE,
  // judged on what has settled (see `trigger`): a path whose settled state
  // equals what this loop last saw for it is not a change. A file's state is
  // its bytes; a directory's is its entries' names and sizes (a nested edit
  // arrives as that path's own event); a path that is gone is one more state. A
  // real edit changes the state; a first sighting passes through. So `rm -rf
  // dist && tsc` — the shape of most build scripts — settles to the same `dist`
  // it left and is one redundant cycle, not a loop (780 executions in two
  // minutes from one edit, when a deletion and a directory each passed the gate
  // unconditionally).
  private readonly lastState = new Map<string, bigint>()
  // A path that starts cycle after cycle from the run's own writes is a task
  // rewriting a file with different bytes every run (a pid file, a timestamped
  // log): the state gate cannot settle it, and nothing here can tell the third
  // such write from a user's third save mid-run — so watch names it once, with
  // the remedy, and keeps going. "The run's own write" is read off the path
  // itself: its mtime falls inside the previous cycle's window. Not off which
  // judgement started the cycle: macOS delivers a run's writes late, after the
  // loop's own post-run judgement found nothing and broke out, so there every
  // such cycle starts from the idle timer (CI: the storm ran, the notice never
  // came).
  private readonly streak = { abs: '', n: 0 }
  private readonly noticed = new Set<string>()
  /** Files git came to track after the arm (`tracked`). */
  private readonly trackedSince = new Set<string>()

  constructor(private readonly ctx: JudgeContext) {}

  /**
   * Record a path's state as it is, if this loop has not: a link armed for
   * what it points to, whose own times say "before the arm" whatever
   * changed behind it, so its first sighting compares against this.
   */
  seed(abs: string): void {
    if (!this.lastState.has(abs)) this.lastState.set(abs, settledState(abs))
  }

  /**
   * An event on `abs`. A write that lands after the judgement that started
   * a cycle and before its run ends, where no command of the run may write
   * (`CommandWindows.writerDuring`) and no server the loop holds may have,
   * is the user's: the run may have keyed its bytes, so the path is a
   * change at its next judgement whatever it settles to. Judged against
   * the state that judgement recorded, an edit landing before the keys and
   * put back while the cycle ran settled to "the same", and the outputs
   * stood built from bytes the tree no longer held. A write inside a
   * command's window is judged by state as before: a task rewriting a file
   * with the same bytes every run is no change, and so is a user's write
   * there, which the run cannot tell from its own. Read when the event
   * comes, not at the judgement: the edit's own time, before a revert
   * stamps over it. The stamp runs up to a tick behind `Date.now()`, which
   * dates the windows: a task's write was dated before its window opened,
   * and every such write re-ran the loop, so the window widens by the racy
   * window, as the hash memo judges a stamp.
   */
  sawEvent(abs: string): void {
    const c = this.cycle
    if (c === undefined) return
    let t: number
    try {
      t = fs.lstatSync(abs).ctimeMs
    } catch {
      return
    }
    if (t < c.from || t > c.to) return
    if (c.windows.writerDuring('', abs, t, t + racyWindowMs(t, FILE_HASH_RACY_MS)) !== undefined)
      return
    if (this.serverMayHaveWritten(abs)) return
    this.lastState.set(abs, UNSEEN)
  }

  /**
   * The inputs a run read in a state no judgement saw (`TaskOutcome.cache.driftedInput`):
   * edited and put back while the task ran, a file settles to the state this
   * loop last saw, and judged against it, the output built from the other
   * state stood with no cycle after it. Each is a change at its next
   * judgement; null (the input unnamed) makes every pending path one.
   */
  unseen(moved: readonly (string | null)[]): void {
    for (const abs of moved)
      for (const p of abs === null ? [...this.pending.keys()] : [abs]) this.lastState.set(p, UNSEEN)
  }

  // A path this loop has never judged is a change only if it moved since the
  // watchers went live (its mtime or ctime, `modifiedBefore`). macOS delivers
  // the initial run's own writes AFTER the arm (CI: `app dist; re-running...`
  // with no edit made — FSEvents hands a stream what landed just before it
  // started), and a first sighting used to pass unconditionally; the path's
  // mtime says which side of the arm it belongs to. A path already gone is a
  // change: a deletion has no date to read. One exception: a path git did not
  // list at the arm, and gone now, was born and removed since (vim's `4913`
  // write probe, a tool's lock file), unless a nested repository holds it
  // (`inNestedRepo`); it started a cycle with nothing changed. One born during
  // a cycle where no command of it may write is a change all the same
  // (`sawEvent`): the run may have read it. The blind spot left: one gone again
  // before its event is read, which has no time to judge by. Git lists no
  // ignored path, so one of those is a deletion as before.
  private sameState(abs: string, ignored: boolean, spell: (p: string) => string): boolean {
    const state = settledState(abs)
    const prev = this.lastState.get(abs)
    this.lastState.set(abs, state)
    // A name not valid UTF-8 reaches a watcher with U+FFFD for its bad
    // bytes, a path no file has: read as gone, its edit started no cycle,
    // where `vx run` refuses the key. The run names it.
    if (state === ABSENT && abs.includes('\uFFFD')) return false
    if (prev !== undefined) return prev === state
    // A new empty directory holds nothing a key reads: a file made in it
    // is the edit.
    // One a watch waits on (a project directory made again) is a change:
    // its cycle re-arms the project.
    if (state === EMPTY_DIR && isDirectory(abs) && this.ctx.awaited?.(abs) !== true) return true
    if (state === ABSENT) {
      const listed = this.ctx.existedAtArm
      return !ignored && listed !== undefined && !listed.has(spell(abs)) && !this.inNestedRepo(abs)
    }
    return modifiedBefore(abs, this.ctx.armedAt)
  }

  // Git lists a nested repository (a submodule, a vendored clone) as one
  // entry, never the files in it, and keys read them: under one, a gone
  // path the arm did not list may have existed, so it is a deletion.
  private inNestedRepo(abs: string): boolean {
    const root = this.ctx.workspaceRoot
    for (let dir = path.dirname(abs); dir !== root && dir.startsWith(root); dir = path.dirname(dir))
      if (fs.existsSync(path.join(dir, '.git'))) return true
    return false
  }

  /**
   * Whether git tracks `abs`: at the arm, or since (a commit, a checkout),
   * asked of git then; false when git could not answer at the arm.
   */
  tracked(abs: string): boolean {
    const atArm = this.ctx.trackedAtArm
    if (atArm === undefined) return false
    const spelled = gitSpeller(this.ctx.workspaceRoot)(abs)
    if (atArm.has(spelled) || this.trackedSince.has(spelled)) return true
    if (!gitTracks(this.ctx.workspaceRoot, spelled)) return false
    this.trackedSince.add(spelled)
    return true
  }

  /**
   * Whether a server still running may have written `abs`: a file in its own
   * project (not one nested there) that git does not track. A file git tracks
   * is the user's: three saves of one source file were told to.gitignore it as
   * a server's write, and so were a file committed since the arm and a new file
   * in another project.
   */
  private serverMayHaveWritten(abs: string): boolean {
    if (!this.ctx.held()) return false
    const dirs = this.ctx.serverDirs?.()
    if (
      dirs !== undefined &&
      !dirs.some((d) => abs.startsWith(d + path.sep) && this.ctx.fenced?.(d, abs) !== true)
    )
      return false
    return !this.tracked(abs)
  }

  /** `byServer`: a server the last cycle left running counts as that cycle (`serverMayHaveWritten`). */
  private writtenDuringLastCycle(abs: string, byServer = false): boolean {
    // A server the last cycle left running is still that cycle's: its writes
    // land after the cycle ended, and with a closed window a dev server that
    // rewrites a log in its project restarted itself forever with no word of
    // it, 12 restarts in 8 s. The initial run's server is one too, from the arm
    // on.
    const last = this.lastCycle
    if (last === undefined && !(byServer && this.ctx.held())) return false
    let m: number
    try {
      // The later of the two clocks: a cache hit restores an output with the
      // mtime it was saved with, and read by mtime alone the restore was the
      // user's edit and ran one more cycle (solid). The restore's write moves
      // the ctime.
      const st = fs.statSync(abs)
      m = Math.max(st.mtimeMs, st.ctimeMs)
    } catch {
      return false
    }
    if (m < (last?.start ?? this.ctx.armedAt)) return false
    if (last !== undefined && m <= last.end) return true
    // Last: it may ask git.
    return byServer && this.serverMayHaveWritten(abs)
  }

  judge(): string | undefined {
    // Before any state is read: a write after this is one the judgement may not have seen.
    const at = this.ctx.clock?.() ?? Date.now()
    const ignored = gitIgnored(this.ctx.workspaceRoot, [...this.pending.keys()])
    const spell = gitSpeller(this.ctx.workspaceRoot)
    let first: string | undefined
    let firstAbs: string | undefined
    let firstIsFile = false
    // `sameState` before the `first` test, never after it: it is what RECORDS a
    // path's settled state, and every path this judgement saw must be recorded
    // even though only the first change names the cycle. Short-circuiting after
    // the winner leaves the rest unjudged, and their next event is a first
    // sighting stamped after the arm — so a batch edit (a `git checkout`) makes
    // the same bytes written to any of the others a change. A git-ignored path
    // keys nothing, but a task with no cache has no key: it reads what it
    // likes, and its `.env.local` edit re-ran nothing. Under such a project an
    // ignored path is judged when the user wrote it; one the last cycle wrote
    // (the pid file an uncached task rewrites every run, the loop the filter
    // exists for) stays out, as does one in a project nested under it, which it
    // does not own. So is one a task's inputs name outright (`.env.local`,
    // `dist/**`). A write `sawEvent` found no command of the cycle could have
    // made is the user's though it lies in the cycle: taken for the run's own,
    // an edit to `node_modules/.gen/**` after its task ran never re-ran.
    const editForUncached = (p: string): boolean =>
      ([...this.ctx.uncached()].some(
        (dir) => p.startsWith(dir + path.sep) && this.ctx.fenced?.(dir, p) !== true,
      ) ||
        (this.ctx.namedIgnored?.() ?? []).some((n) => p === n || p.startsWith(n + path.sep))) &&
      (this.lastState.get(p) === UNSEEN || !this.writtenDuringLastCycle(p))
    // A path still there names the cycle before a gone one: an editor or
    // `sed -i` saving through a temporary file fires that file first, and
    // the cycle was announced by a name already renamed away.
    let gone: [label: string, abs: string] | undefined
    // "+N more" counts the changes of the winner's kind: an edit's count
    // leaves out the editor's temporary file renamed away.
    let live = 0
    let goneCount = 0
    const changed: string[] = []
    for (const [p, l] of this.pending) {
      if (ignored.has(p) && !editForUncached(p)) continue
      if (this.sameState(p, ignored.has(p), spell)) continue
      changed.push(p)
      if (!fs.existsSync(p)) {
        goneCount++
        if (gone === undefined || p < gone[1]) gone = [l, p]
        continue
      }
      live++
      // A file names the cycle before a directory: `mkdir -p` and a write
      // in it fire the directory first, and the cycle was named by it.
      // Within a kind the least path does, never the first event: macOS
      // FSEvents does not keep a batch's order, and the same edits were
      // named apart on Linux and a Mac.
      const isFile = !isDirectory(p)
      if (
        first !== undefined &&
        ((firstIsFile && !isFile) || (firstIsFile === isFile && p > firstAbs!))
      )
        continue
      first = l
      firstAbs = p
      firstIsFile = isFile
    }
    if (first === undefined && gone !== undefined) [first, firstAbs] = gone
    // A path is anyone's bytes, and a file named `ESC ]0;…` printed raw
    // in `changed …` retitled the terminal.
    if (first !== undefined) first = printable(first)
    this.pending.clear()
    this.changed = changed
    const more = (live > 0 ? live : goneCount) - 1
    const named = more > 0 ? `${first} (+${more} more)` : first
    // A judgement that found nothing starts no cycle, so it breaks no streak. A
    // server's log stamped to the second rewrites the same bytes between its
    // changes, and an event can land after the judgement that read its write;
    // resetting on either, the storm ran on unnamed (macOS CI).
    if (firstAbs === undefined) return named
    this.cycle = { from: at, to: Infinity, windows: commandWindows() }
    const byServer = this.ctx.held()
    if (!this.writtenDuringLastCycle(firstAbs, true)) {
      this.streak.n = 0
      return named
    }
    this.streak.n = this.streak.abs === firstAbs ? this.streak.n + 1 : 1
    this.streak.abs = firstAbs
    if (this.streak.n >= 3 && !this.noticed.has(firstAbs)) {
      this.noticed.add(firstAbs)
      ui.say(
        'warn',
        byServer
          ? `vx watch: ${first} has started 3 cycles in a row, written while a server was running — a persistent task rewrites it. Add it to .gitignore (a git-ignored path never starts a cycle); until then every write starts a cycle.\n`
          : `vx watch: ${first} has started 3 cycles in a row, written by the cycle before each — a task rewrites it every run. Declare it in outputs (an output never starts a cycle) or add it to .gitignore (a git-ignored path never does); until then every run re-runs.\n`,
        'out',
      )
    }
    return named
  }
}
