// Which settled paths are changes: `vx watch`'s judgement, run one debounce
// window after events stop, on what the tree settled to. The loop in
// watch.ts owns when to judge and what to run; this owns what counts.

import fs from 'node:fs'
import path from 'node:path'
import { xxh3 } from '../util/index.js'
import { gitIgnored } from './watch-filter.js'
import { modifiedBefore } from './watch-fs.js'

const ABSENT = -1n

function settledState(abs: string): bigint {
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return ABSENT
  }
  if (!st.isDirectory()) {
    try {
      return xxh3(fs.readFileSync(abs))
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

/** What the judgement reads from the loop, which owns it and may replace it. */
export interface JudgeContext {
  workspaceRoot: string
  /** The instant the watchers went live, on the mtime clock (`fsClockNow`). */
  armedAt: number
  /** Whether a persistent server the last cycle started is still running. */
  held(): boolean
  /** Projects whose uncached task may read a git-ignored file. */
  uncached(): ReadonlySet<string>
  /** The files git listed at the arm; absent when git could not answer. */
  existedAtArm?: ReadonlySet<string>
}

export class ChangeJudge {
  // Paths that fired since the last judgement, first label wins. The state
  // check runs when the timer fires, on SETTLED state: per event it is
  // wrong on Linux, where a shell redirect truncates the file (one event,
  // empty) and then writes it (another, full), so consecutive events never
  // agree and a self-write loops anyway (CI, 2026-09-04: 9 re-runs where
  // macOS, which coalesces the two, saw 2). While a cycle runs, nothing is
  // judged: the run's own writes are mid-flight (a `dist` deleted and not
  // yet rebuilt is a state the tree will not keep), so the paths wait and
  // are judged one window after the run ends, all together — an edit made
  // meanwhile still differs from what the loop last saw and re-runs.
  readonly pending = new Map<string, string>()
  /** The last cycle's wall window; a write inside it is the run's own. */
  lastCycle: { start: number; end: number } | undefined
  // Declared outputs are ignored by PATH above. A task with no `cache`
  // block declares none and still writes into its project, and the
  // watcher sees the write: run 1 writes dist/x, the event re-runs, run 2
  // writes the same bytes, the event re-runs — forever (the init
  // walkthrough, 2026-09-04: every fresh workspace, since `init` emits no
  // cache block). An undeclared write is caught by STATE, judged on what
  // has settled (see `trigger`): a path whose settled state equals what
  // this loop last saw for it is not a change. A file's state is its
  // bytes; a directory's is its entries' names and sizes (a nested edit
  // arrives as that path's own event); a path that is gone is one more
  // state. A real edit changes the state; a first sighting passes through.
  // So `rm -rf dist && tsc` — the shape of most build scripts — settles
  // to the same `dist` it left and is one redundant cycle, not a loop
  // (2026-09-10: 780 executions in two minutes from one edit, when a
  // deletion and a directory each passed the gate unconditionally).
  private readonly lastState = new Map<string, bigint>()
  // A path that starts cycle after cycle from the run's own writes is a
  // task rewriting a file with different bytes every run (a pid file, a
  // timestamped log): the state gate cannot settle it, and nothing here
  // can tell the third such write from a user's third save mid-run — so
  // watch names it once, with the remedy, and keeps going. "The run's
  // own write" is read off the path itself: its mtime falls inside the
  // previous cycle's window. Not off which judgement started the cycle:
  // macOS delivers a run's writes late, after the loop's own post-run
  // judgement found nothing and broke out, so there every such cycle
  // starts from the idle timer (CI, 2026-09-16: the storm ran, the
  // notice never came).
  private readonly streak = { abs: '', n: 0 }
  private readonly noticed = new Set<string>()

  constructor(private readonly ctx: JudgeContext) {}

  // A path this loop has never judged is a change only if it moved since
  // the watchers went live (its mtime or ctime, `modifiedBefore`). macOS delivers the initial run's own writes
  // AFTER the arm (CI, 2026-09-11: `app dist; re-running...` with no edit
  // made — FSEvents hands a stream what landed just before it started),
  // and a first sighting used to pass unconditionally; the path's mtime
  // says which side of the arm it belongs to. A path already gone is a
  // change: a deletion has no date to read.
  // One exception: a path git did not list at the arm, and gone now, was
  // born and removed since (vim's `4913` write probe, a tool's lock file);
  // it started a cycle with nothing changed. The blind spot: one born in
  // the moment between a judgement and that cycle's keys, and gone by the
  // next judgement, was read and its deletion re-runs nothing. Git lists
  // no ignored path, so one of those is a deletion as before.
  private sameState(abs: string, ignored = false): boolean {
    const state = settledState(abs)
    const prev = this.lastState.get(abs)
    this.lastState.set(abs, state)
    if (prev !== undefined) return prev === state
    if (state === ABSENT) {
      const listed = this.ctx.existedAtArm
      return !ignored && listed !== undefined && !listed.has(abs)
    }
    return modifiedBefore(abs, this.ctx.armedAt)
  }

  private writtenDuringLastCycle(abs: string, openWhileHeld = false): boolean {
    // A server the last cycle left running is still that cycle's: its
    // writes land after the cycle ended, and with a closed window a dev
    // server that rewrites a log in its project restarted itself forever
    // with no word of it, 12 restarts in 8 s (item 948). The initial run's
    // server is one too, from the arm on.
    const open = openWhileHeld && this.ctx.held()
    if (this.lastCycle === undefined && !open) return false
    try {
      const m = fs.statSync(abs).mtimeMs
      const start = this.lastCycle?.start ?? this.ctx.armedAt
      return m >= start && (open || m <= this.lastCycle!.end)
    } catch {
      return false
    }
  }

  judge(): string | undefined {
    const ignored = gitIgnored(this.ctx.workspaceRoot, [...this.pending.keys()])
    let first: string | undefined
    let firstAbs: string | undefined
    // `sameState` before the `first` test, never after it: it is what
    // RECORDS a path's settled state, and every path this judgement saw
    // must be recorded even though only the first change names the cycle.
    // Short-circuiting after the winner leaves the rest unjudged, and
    // their next event is a first sighting stamped after the arm — so a
    // batch edit (a `git checkout`) makes the same bytes written to any
    // of the others a change.
    // A git-ignored path keys nothing, but a task with no cache has no key:
    // it reads what it likes, and its `.env.local` edit re-ran nothing
    // (item 947). Under such a project an ignored path is judged when the
    // user wrote it; one the last cycle wrote (the pid file an uncached
    // task rewrites every run, the loop the filter exists for) stays out.
    const editForUncached = (p: string): boolean =>
      [...this.ctx.uncached()].some((dir) => p.startsWith(dir + path.sep)) &&
      !this.writtenDuringLastCycle(p)
    // A path still there names the cycle before a gone one: an editor or
    // `sed -i` saving through a temporary file fires that file first, and
    // the cycle was announced by a name already renamed away.
    let gone: [label: string, abs: string] | undefined
    for (const [p, l] of this.pending) {
      if (ignored.has(p) && !editForUncached(p)) continue
      if (this.sameState(p, ignored.has(p)) || first !== undefined) continue
      if (!fs.existsSync(p)) {
        gone ??= [l, p]
        continue
      }
      first = l
      firstAbs = p
    }
    if (first === undefined && gone !== undefined) [first, firstAbs] = gone
    this.pending.clear()
    const byServer = firstAbs !== undefined && this.ctx.held()
    if (firstAbs === undefined || !this.writtenDuringLastCycle(firstAbs, true)) {
      this.streak.n = 0
      return first
    }
    this.streak.n = this.streak.abs === firstAbs ? this.streak.n + 1 : 1
    this.streak.abs = firstAbs
    if (this.streak.n >= 3 && !this.noticed.has(firstAbs)) {
      this.noticed.add(firstAbs)
      process.stdout.write(
        byServer
          ? `vx watch: ${first} has started 3 cycles in a row, written while a server the cycle before started was running — a persistent task rewrites it. Add it to .gitignore (a git-ignored path never starts a cycle); until then every write restarts the server.\n`
          : `vx watch: ${first} has started 3 cycles in a row, written by the cycle before each — a task rewrites it every run. Declare it in cache.outputs (an output never starts a cycle) or add it to .gitignore (a git-ignored path never does); until then every run re-runs.\n`,
      )
    }
    return first
  }
}
