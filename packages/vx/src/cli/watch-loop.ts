// The watch loop: the watchers over the workspace, the judgement of what
// they hear, and the cycles it runs. `vx watch` (watch.ts) starts it after
// the initial run.

import fs from 'node:fs'
import path from 'node:path'
import { FILE_HASH_RACY_MS, fsClockNow, racyWindowMs } from '../memo/index.js'
import { namedIgnoredReach, repoFacts } from '../cache/index.js'
import {
  type CommandWindows,
  forwardedSignal,
  runCore as runOrchestrator,
  type HeldPersistent,
  type CoreRunOptions,
} from '../orchestrator/index.js'
import {
  LOCKFILE_NAME,
  NO_LOCK,
  type ProjectMeta,
  WORKSPACE_CONFIG_FILENAMES,
} from '../workspace/index.js'
import { resolveSetting } from '../settings.js'
import {
  isProjectConfigFile,
  isWorkspaceConfigFile,
  gitFiles,
  makeFence,
  makeRootEventFilter,
  makeWatchIgnore,
  shapesWatchedSet,
} from './watch-filter.js'
import { CLOSED, type WatchHandle, WatcherPool } from './watch-fs.js'
import { ChangeJudge } from './watch-judge.js'
import { type WatchCycle, watchCycle } from './watch-cycle.js'
import { maskedLine, printable, restartTimings } from '../util/index.js'
import * as ui from '../ui/index.js'
import { sayNotice } from '../ui/index.js'
import { isCacheHit } from '../graph/index.js'
import { resolveOutputView } from '../report/index.js'

/** One line for a watcher or re-read the OS refused; the loop goes on without it. */
function sayCannot(what: string, err: unknown): void {
  sayNotice('warn', 'vx watch', `${what}: ${err instanceof Error ? err.message : String(err)}`)
}

/**
 * One line for an all-hit cycle, where hits print no row and watch prints no
 * footer: it said nothing, and the previous cycle's failure stayed the last
 * outcome on screen.
 */
export function sayAllCached(opts: CoreRunOptions, outcomes: readonly { status: string }[]): void {
  if (outcomes.length === 0 || !outcomes.every((o) => isCacheHit(o.status))) return
  const mode = resolveOutputView(opts).mode
  if (mode !== 'broad' && mode !== 'errors-only' && mode !== 'none') return
  const n = outcomes.length
  ui.print('out', ui.line(' ', n === 1 ? '1 task' : `${n} tasks`, ' cached, nothing ran'))
}

function isDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory()
  } catch {
    return false
  }
}

/** Wait this long after the last filesystem event before re-running. */
const DEBOUNCE_MS = 150
/**
 * ...but no longer than this after the first: a writer that never pauses (a dev
 * server logging every 50 ms) reset the timer forever.
 */
const DEBOUNCE_MAX_MS = 1_000

/** What the initial run's own writes are told from an edit by: no watcher was armed. */
export interface InitialRun {
  /** Its start, on the mtime clock (`fsClockNow`). */
  readonly from: number
  /** Its commands' windows: a write inside one may be the run's own. */
  readonly windows: CommandWindows
  /** The lock as it read it (`lockStamp`). */
  readonly lock: string
}

/** The initial run, when the loop arms while it is still in flight. */
export interface InitialCycle {
  readonly cycle: WatchCycle
  /** What the run leaves running once it returns. */
  held: Promise<HeldPersistent | undefined>
  /** The loop's readiness hook, once the loop has armed. */
  onWaiting?: () => void
}

interface WatchLoopArgs {
  opts: CoreRunOptions
  /** The persistent tasks the initial run left running; the next cycle stops them before it starts. */
  held: HeldPersistent | undefined
  /** The initial run, still in flight: the loop's first cycle. */
  initial: InitialCycle | undefined
  initialRun: InitialRun
  /** The initial run's task count, once it has started. */
  tasks: () => number | undefined
  /** A task the initial run left unsaved because its inputs moved under it (`TaskOutcome.cache.unkeyed`). */
  drifted: string | undefined
  /** Aborted by the SIGINT/SIGTERM handlers `watchCmd` installed; the loop drains its cycle and resolves. */
  stop: AbortSignal
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  workspaceWide: boolean
  /** Every project's directory, in scope or not — under the root watcher an edit there is an edit. */
  projectDirs: readonly string[]
  /** Every declared `inputs.workspaceFiles` glob, root-relative. */
  workspaceInputs: readonly string[]
  /** Absolute, already-resolved — the loop must never re-derive it. */
  cacheDir: string
  /** Declared output globs per directory they are relative to (project dir, or the root for `workspaceFiles`). */
  outputs: ReadonlyMap<string, readonly string[]>
  /** Declared input globs per directory: never ignored as another task's output. */
  inputs: ReadonlyMap<string, ReadonlyArray<readonly string[]>>
  /** Projects whose uncached task may read a git-ignored file: such a path there is still an edit. */
  uncached: ReadonlySet<string>
  /** Paths a task's inputs name outright: a git-ignored one there is still an edit. */
  namedIgnored: readonly string[]
  /** Files the configs import: an edit to one outside the watched projects is a cycle that re-reads them. */
  configImports: readonly string[]
  /** Files the workspace config imports: loaded once per process, so an edit is named, not run. */
  workspaceConfigImports: readonly string[]
  /**
   * Root files plugins claim (`VxPlugin.fingerprint`): a lockfile, or a file
   * their stages read. The workspace config loads once per process, so the set
   * is fixed.
   */
  claimedRootFiles: ReadonlySet<string>
  /** The files a claimed file's recorded digests read besides it (`lockedExtras`), absolute. */
  extraFiles: ReadonlySet<string>
  /** Every project, in scope or not: a project's key leaves out what lies in one nested under it. */
  fenceDirs: readonly string[]
  /** The watched set again, after a cycle that followed an event which can change it. */
  rediscover: () => Promise<Rediscovered>
  /** `watch.poll`: poll from the start instead of the OS watcher. */
  poll: boolean
}

export const fenceDirs = (all: readonly ProjectMeta[]): string[] => all.map((p) => p.dir)

/** The input globs that name a `node_modules` segment, per directory: what the tree watcher enters. */
const modulesNamed = (inputs: ReadonlyMap<string, ReadonlyArray<readonly string[]>>): string =>
  JSON.stringify(
    [...inputs].map(([dir, tasks]) => [
      dir,
      tasks.flat().filter((g) => g.split('/').includes('node_modules')),
    ]),
  )

interface Rediscovered {
  projects: readonly ProjectMeta[]
  cacheDir: string
  claimedRootFiles: ReadonlySet<string>
  extraFiles: ReadonlySet<string>
  workspaceWide: boolean
  workspaceInputs: readonly string[]
  outputs: ReadonlyMap<string, readonly string[]>
  inputs: ReadonlyMap<string, ReadonlyArray<readonly string[]>>
  uncached: ReadonlySet<string>
  namedIgnored: readonly string[]
  configImports: readonly string[]
  workspaceConfigImports: readonly string[]
  fenceDirs: readonly string[]
}

export async function runWatchLoop(args: WatchLoopArgs): Promise<void> {
  return new WatchLoop(args).run()
}

/** One project the one stream hands events to, by its real directory. */
interface Streamed {
  proj: ProjectMeta
  real: string
}

/** The loop's state between events, and the steps that arm, judge and run. */
class WatchLoop {
  private readonly opts: CoreRunOptions
  private readonly stop: AbortSignal
  private readonly workspaceRoot: string
  // The watched set as of the last cycle: `rearm` replaces these after an
  // event that can change it, and every filter below reads the current one.
  private cacheDir: string
  private workspaceWide: boolean
  private projectDirs: readonly string[]
  private workspaceInputs: readonly string[]
  private outputs: ReadonlyMap<string, readonly string[]>
  private inputs: ReadonlyMap<string, ReadonlyArray<readonly string[]>>
  private uncached: ReadonlySet<string>
  private namedIgnored: readonly string[]
  private claimedRootFiles: ReadonlySet<string>
  private extraFiles: ReadonlySet<string>
  private configImportFiles: readonly string[]
  private wsConfigImportFiles: readonly string[]
  // A dev server stays up while the loop idles and across cycles; a cycle that
  // must restart it stops it before its graph, so the new one never meets the
  // old one's port.
  private held: HeldPersistent | undefined
  /** The watched projects: `rearm` replaces them. */
  private watched: readonly ProjectMeta[]

  // Never two runs in flight. Events landing meanwhile wait in
  // `changes.pending`, judged on settled bytes one debounce window after it
  // ends.
  private running: boolean
  /** The cycle in flight, so the stop path can wait for its teardown before resolving. */
  private inFlight: Promise<void> = Promise.resolve()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** The run in flight, while one is. */
  private current: WatchCycle | undefined
  /** What stopped a cycle that waited on a server's readiness; the loop runs it next. */
  private interruptedBy: string | undefined
  private interruptTimer: ReturnType<typeof setTimeout> | null = null
  /** The server's own writes among the paths that stopped the last cycle waiting on readiness. */
  private stoppedLast = new Set<string>()
  private windowOpened = 0
  /** The lock as the last cycle found it: a config edit with no re-lock since changes no command. */
  private lockSeen: string

  // Drop events for paths that do not matter: a `node_modules` write under a
  // project fired on every save of `bun install`, and vx's own cache writes
  // would loop.
  /** What existed and was tracked at the arm, so a file born and gone since is no deletion and a tracked one is the user's edit (watch-judge.ts). */
  private readonly atArm: ReturnType<typeof gitFiles>
  private isIgnoredPath: ReturnType<typeof makeWatchIgnore>
  private fenced: ReturnType<typeof makeFence>
  private matters: ReturnType<typeof makeRootEventFilter>
  /** Since the last cycle, a member came or went, or a file that shapes the watched set changed (`shapesWatchedSet`). */
  private reread = false
  private readonly pool: WatcherPool
  // Only entries a key reads ignored files under: a dev server's ignored
  // `src/dev.log` started ~3 cycles a second. Reckoned per sweep.
  private reachOf: readonly string[] | undefined
  private reach: readonly string[] = []
  /** Which settled paths are changes (watch-judge.ts); `pending` holds what fired since. */
  private readonly changes: ChangeJudge
  /** Per-project arms by directory, so `rearm` can add and drop them. */
  private readonly perProject = new Map<string, WatchHandle>()
  // Each FSEvents stream goes live slower than the last: per project, 751 of
  // 3,000 missed their 2 s proof on macOS CI and fell back to polling (a full
  // core at idle); one root stream went live in 8 ms. Polling keeps per-project
  // walks.
  private readonly oneStream: boolean
  private readonly treeArms: boolean
  /** The projects the one stream hands events to, by their real directory. */
  private streamed: Streamed[] = []
  private readonly realRoot: string
  // An OS watch holds the directory's inode, not its path: one removed and
  // recreated keeps reporting for the deleted one. Each arm notes its
  // directory, and a re-arm replaces any whose path now names another.
  private readonly armedAs = new Map<string, string>()
  /** The ancestor and import directories the one stream serves (`inStream`). */
  private streamedAncestors = new Set<string>()
  private streamedImports = new Set<string>()
  /** The projects the workspace-wide arm names an event by. */
  private wide: readonly ProjectMeta[] = []
  /** The root arm: recursive when workspace-wide or the one stream, else the root's own files only. */
  private rootArm: WatchHandle = CLOSED
  private dotVxArm: WatchHandle = CLOSED
  private readonly importArms = new Map<string, WatchHandle>()
  private importNames = new Map<string, Set<string>>()
  private readonly staleNamed = new Map<string, number>()
  private readonly linkArms = new Map<string, { target: string; handle: WatchHandle }>()
  private links: Set<string>
  private readonly extraArms = new Map<string, { at: string; handle: WatchHandle }>()
  private readonly excludeFile: string | undefined
  // Said once, at the first arm: a re-arm repeated it between task rows.
  // `debug.watch` reports each arm on stderr.
  private lastTasks: number | undefined
  private readonly debugArms: boolean
  // A project directory (or one a config imports from) removed and recreated is
  // no event to its own watch, which holds the deleted directory, nor to the
  // root arm: silence until a restart. So each is watched from its nearest
  // existing directory for the next name down, and every directory above it to
  // the root too: on macOS FSEvents reports nothing for a watched directory's
  // children when the directory goes with them.
  private readonly ancestorArms = new Map<string, WatchHandle>()
  private ancestorNames = new Map<string, Set<string>>()
  /** Each project directory below the root as these arms first saw it (`inodeOf`). */
  private heldDirs = new Map<string, string>()

  constructor(private readonly args: WatchLoopArgs) {
    this.opts = args.opts
    this.stop = args.stop
    const workspaceRoot = args.workspaceRoot
    this.workspaceRoot = workspaceRoot
    this.cacheDir = args.cacheDir
    this.workspaceWide = args.workspaceWide
    this.projectDirs = args.projectDirs
    this.workspaceInputs = args.workspaceInputs
    this.outputs = args.outputs
    this.inputs = args.inputs
    this.uncached = args.uncached
    this.namedIgnored = args.namedIgnored
    this.claimedRootFiles = args.claimedRootFiles
    this.extraFiles = args.extraFiles
    this.configImportFiles = args.configImports
    this.wsConfigImportFiles = args.workspaceConfigImports
    this.held = args.held
    this.watched = args.projects
    this.running = args.initial !== undefined
    this.lockSeen = args.initialRun.lock

    this.atArm = gitFiles(workspaceRoot, true)
    this.isIgnoredPath = makeWatchIgnore(
      this.cacheDir,
      this.outputs,
      this.inputs,
      this.atArm?.tracked,
    )
    this.fenced = makeFence(args.fenceDirs)
    this.matters = makeRootEventFilter(
      workspaceRoot,
      this.projectDirs,
      this.workspaceInputs,
      this.claimedRootFiles,
      this.fenced,
    )
    // The poller skips what the event filter drops: the fixed segments and this
    // run's output containers. Read through `isIgnoredPath`, since `rearm`
    // replaces the filter.
    this.pool = new WatcherPool((dir, rel) => this.isIgnoredPath(dir, rel, true), args.poll)
    /** The instant the watchers go live, on the mtime clock (see `fsClockNow`): a path last modified before it is the initial run's, not an edit. */
    const armedAt = fsClockNow(this.cacheDir)
    this.changes = new ChangeJudge({
      workspaceRoot,
      armedAt,
      clock: () => fsClockNow(this.cacheDir),
      held: () => this.held !== undefined,
      serverDirs: () => {
        const names = new Set(this.held?.ids.map((id) => id.slice(0, id.lastIndexOf('#'))))
        return this.watched.filter((p) => names.has(p.name)).map((p) => p.dir)
      },
      uncached: () => this.uncached,
      namedIgnored: () => {
        if (this.reachOf !== this.namedIgnored) {
          this.reachOf = this.namedIgnored
          this.reach =
            this.atArm === undefined
              ? this.namedIgnored
              : namedIgnoredReach(workspaceRoot, this.namedIgnored, this.atArm.listed)
        }
        return this.reach
      },
      fenced: (ownDir, abs) => this.fenced(ownDir, abs),
      awaited: (abs) => this.ancestorNames.get(path.dirname(abs))?.has(path.basename(abs)) === true,
      ...(this.atArm !== undefined
        ? { existedAtArm: this.atArm.listed, trackedAtArm: this.atArm.tracked }
        : {}),
    })
    this.oneStream = process.platform === 'darwin' && !args.poll
    this.treeArms = process.platform === 'linux' && !args.poll
    this.realRoot = ((): string => {
      try {
        return fs.realpathSync(workspaceRoot)
      } catch {
        return path.resolve(workspaceRoot)
      }
    })()
    this.links = this.atArm?.links ?? new Set<string>()
    /**
     * `info/exclude` ignores as a `.gitignore` does, and keys are
     * gitignore-aware, so its edit is a cycle; the filter drops everything else
     * under `.git/`. Armed once, from the run's memoised git dir.
     */
    const commonDir = repoFacts(workspaceRoot)?.commonDir
    this.excludeFile =
      commonDir === undefined
        ? undefined
        : path.resolve(workspaceRoot, commonDir, 'info', 'exclude')
    this.debugArms = resolveSetting('debug.watch', undefined).value === true
  }

  async run(): Promise<void> {
    const args = this.args
    const projects = args.projects
    this.armMode(projects)
    this.armAncestors()
    this.armImports()
    this.armLinks()
    this.armExtras()
    this.armExclude()

    // The run's own writes never kick the loop: the ignore closes over the
    // resolved cache dir and the declared outputs.

    // "watching" is a promise that an edit from now on is seen; every
    // watcher has proved (or been given 2 s to prove) delivery first.
    await this.pool.proved()
    if (args.initial !== undefined) {
      this.current = args.initial.cycle
      args.initial.onWaiting = this.interruptIfWaiting
      this.inFlight = this.runCycle(undefined, args.initial)
      this.interruptIfWaiting()
    }

    this.lastTasks = args.tasks()
    this.sayWatching(projects.length)
    this.sayArmed(projects.length)
    // An edit made during the initial run predates the arm, so no event finds
    // it, and watch idled over stale output. One to a task the run was running
    // its re-check found; any other is heard here.
    const heard = this.heardSinceRun()
    if (args.drifted !== undefined && !heard)
      void this.cycle(`${args.drifted} inputs, edited during the first run`)

    return await new Promise<void>((resolve) => {
      const cleanup = async (): Promise<void> => {
        this.pool.closeAll()
        if (this.debounceTimer) clearTimeout(this.debounceTimer)
        if (this.interruptTimer) clearTimeout(this.interruptTimer)
        // The aborted cycle is tearing its children down; resolve only once
        // it has returned, so the process never exits over a live child.
        await this.inFlight
        await this.held?.stop(forwardedSignal(this.stop.reason))
        resolve()
      }
      if (this.stop.aborted) {
        void cleanup()
        return
      }
      this.stop.addEventListener('abort', () => void cleanup(), { once: true })
    })
  }

  // Judged on settled state one window later, as an idle edit is, and only
  // if the cycle still waits on readiness alone by then.
  private readonly interruptIfWaiting = (): void => {
    const changes = this.changes
    if (changes.pending.size === 0 || this.current?.waitsOnReadiness() !== true) return
    if (this.interruptTimer) clearTimeout(this.interruptTimer)
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null
      const c = this.current
      if (c === undefined || c.interrupted || !c.waitsOnReadiness() || this.stop.aborted) return
      const label = changes.judge()
      if (label === undefined) return
      // What a server writes in its project as it boots (a timestamped bundle,
      // a route tree) is an edit: it stopped the cycle and the loop restarted
      // the server forever. A path that stopped the last such cycle, untracked
      // and in a waiting server's project, is the server's own write.
      const dirs = c.serverDirs()
      const own = changes.changed.filter(
        (p) => dirs.some((d) => p.startsWith(d + path.sep)) && !changes.tracked(p),
      )
      const again =
        own.length === changes.changed.length && own.every((p) => this.stoppedLast.has(p))
      this.stoppedLast = new Set(own)
      if (again) return
      this.interruptedBy = label
      c.interrupt()
    }, DEBOUNCE_MS)
  }

  private hasWorkspaceFile(): boolean {
    return WORKSPACE_CONFIG_FILENAMES.some((n) => fs.existsSync(path.join(this.workspaceRoot, n)))
  }

  // Every cycle's configs are the lock's, so a config edit alone ran a cycle
  // that printed `changed` and nothing else. A config gone is the run's own
  // refusal.
  private sayUnlocked(paths: readonly string[]): void {
    for (const abs of paths)
      if ((isProjectConfigFile(abs) || this.configImportFiles.includes(abs)) && fs.existsSync(abs))
        sayNotice(
          'warn',
          'vx watch',
          `${printable(path.relative(this.workspaceRoot, abs))} changed; runs read the lock, so run \`vx lock\` to apply it`,
        )
  }

  private trigger(label: string, abs: string): void {
    const changes = this.changes
    if (!changes.pending.has(abs)) changes.pending.set(abs, label)
    changes.sawEvent(abs)
    if (this.running) return this.interruptIfWaiting()
    if (this.debounceTimer) {
      if (performance.now() - this.windowOpened >= DEBOUNCE_MAX_MS) return
      clearTimeout(this.debounceTimer)
    } else this.windowOpened = performance.now()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (this.running) return
      const first = changes.judge()
      if (first !== undefined) void this.cycle(first)
    }, DEBOUNCE_MS)
  }

  private async cycle(label: string): Promise<void> {
    if (this.stop.aborted || this.running) return
    this.running = true
    const done = (this.inFlight = this.runCycle(label))
    await done
  }

  private async runCycle(first: string | undefined, initial?: InitialCycle): Promise<void> {
    const changes = this.changes
    try {
      let label: string | undefined = first
      /** The lock this cycle's run read; none for the initial run. */
      let lockAtRun: string | undefined
      // The initial run is collected even after a stop: its server is the
      // loop's to stop.
      while (initial !== undefined || (label !== undefined && !this.stop.aborted)) {
        /** This cycle's failure, as said: a re-read failing on the same cause says nothing more. */
        let failed: string | undefined
        /** The judged cycle this run is (`ChangeJudge.cycle`): its window closes when the run ends. */
        const judged = changes.cycle
        if (initial !== undefined) {
          this.held = await initial.held
          initial = undefined
        } else
          try {
            // A member came or went: armed before the run keys it, so an edit
            // in a new package during its first cycle queues; armed after, it
            // fell in the gap. The re-read after the run stays.
            lockAtRun = lockStamp(this.workspaceRoot)
            const relocked = lockAtRun !== this.lockSeen
            this.lockSeen = lockAtRun
            if ((await this.runOnce(label!, relocked, judged)) === 'stopped') break
          } catch (err) {
            // A re-run can fail when the workspace moved out from under us (the
            // dir deleted, the repo gone). Show the message but keep the loop:
            // the next event retries, and dispose() on SIGINT is the exit. A
            // config's throw may quote a secret.
            failed = err instanceof Error ? err.message : String(err)
            sayNotice('error', 'vx watch', `cycle failed: ${maskedLine(failed)}`)
          }
        if (judged !== undefined) judged.to = Math.min(judged.to, Date.now())
        await this.afterCycle(failed, lockAtRun)
        // What landed mid-run is judged on settled state, one window
        // after the run, under the label of what actually arrived.
        this.current = undefined
        if (this.stop.aborted) break
        if (this.interruptedBy === undefined) this.stoppedLast = new Set()
        if (this.interruptedBy !== undefined) {
          label = this.interruptedBy
          this.interruptedBy = undefined
          continue
        }
        if (changes.pending.size === 0) break
        await Bun.sleep(DEBOUNCE_MS)
        label = changes.judge()
      }
    } finally {
      this.running = false
      // Anything that landed after the last judgement waits for a timer
      // like any other event.
      const next = pendingAfterCycle(changes.pending, this.stop.aborted)
      if (next !== undefined) this.trigger(next[1], next[0])
    }
  }

  /** One judged cycle's run: `'stopped'` when the stop came before it began. */
  private async runOnce(
    label: string,
    relocked: boolean,
    judged: ChangeJudge['cycle'],
  ): Promise<'stopped' | undefined> {
    const { changes, workspaceRoot, opts } = this
    // The file marks the root and `vx run` refuses without it; a cycle ran on
    // with no workspace config and no plugins.
    if (!this.hasWorkspaceFile()) {
      ui.print('out', ui.gap())
      ui.say('info', `changed ${label}`, 'out')
      throw new Error(`no .vx/workspace.ts in ${workspaceRoot}; restore it, or stop vx watch`)
    }
    // A failed re-read is said once, by the re-read after the
    // cycle: said here too, it printed above the cycle's header.
    if (this.reread) await this.rearm(false)
    ui.print('out', ui.gap())
    ui.say('info', `changed ${label}`, 'out')
    if (!relocked) this.sayUnlocked(changes.changed)
    if (this.stop.aborted) return 'stopped'
    // A file a `.gitignore` edit stops ignoring is an input from now, not on
    // the arm's inventory: its deletion read as born and gone, and ran nothing.
    if (
      this.atArm !== undefined &&
      changes.changed.some((p) => path.basename(p) === '.gitignore' || p === this.excludeFile)
    ) {
      for (const p of gitFiles(workspaceRoot)?.listed ?? []) this.atArm.listed.add(p)
      this.reachOf = undefined
    }
    restartTimings()
    // On the mtime clock, as the arm is: from `Date.now()` the run's own write
    // within a tick read as an edit.
    const start = fsClockNow(this.cacheDir)
    // A server whose task is unchanged stays up: the cycle rebuilds its deps
    // and the dev tool reloads. The run stops the others before its graph.
    const before = this.held
    const current = watchCycle(
      {
        ...opts,
        handoff: {
          ...opts.handoff,
          ...(before ? { keep: before } : {}),
          ...(judged ? { commandWindows: judged.windows } : {}),
        },
      },
      this.stop,
      this.interruptIfWaiting,
    )
    this.current = current
    const cycle = await runOrchestrator(current.opts)
    changes.unseen(
      cycle.outcomes.flatMap((o) =>
        o.cache?.driftedInput === undefined ? [] : [o.cache.driftedInput],
      ),
    )
    sayAllCached(opts, cycle.outcomes)
    this.lastTasks = current.tasks ?? this.lastTasks
    this.current = undefined
    this.held = cycle.persistent
    // What this cycle did not take (a server whose task did not run).
    await before?.stop()
    if (cycle.refused !== undefined) sayNotice('error', 'vx watch', cycle.refused)
    changes.lastCycle = { start, end: Date.now() }
    return undefined
  }

  /** After a cycle: re-read the watched set if an event asked, and hear a re-lock made meanwhile. */
  private async afterCycle(
    failed: string | undefined,
    lockAtRun: string | undefined,
  ): Promise<void> {
    // After a failed cycle too: a new package whose config does not load yet
    // fails its cycle, and unarmed, the fix was never an event.
    if (this.reread && !this.stop.aborted && this.hasWorkspaceFile()) {
      this.reread = false
      const err = await this.rearm()
      // No lock is the cycle's own failure to say; said here too, it was two lines.
      const why = err instanceof Error ? err.message : String(err)
      if (err !== undefined && why !== NO_LOCK && why !== failed)
        sayCannot(`cannot re-read the workspace`, err)
    }
    // A re-lock since this cycle began: the re-arm can close the watcher its
    // event was on its way to (FSEvents latency, a poller tick), and a cycle
    // that read a half-written lock failed. Asked after the re-arm: a lock
    // written in between became the new pollers' baseline and was never an
    // event.
    if (lockAtRun !== undefined && lockStamp(this.workspaceRoot) !== lockAtRun)
      this.rootFileEvent(LOCKFILE_NAME)
  }

  private arm(dir: string, recursive: boolean, onEvent: (filename: string) => void): WatchHandle {
    return this.pool.arm(dir, recursive, onEvent)
  }

  // The stream names a file by its real place under the root, so a project
  // whose real directory lies outside the root keeps its own arm.
  private toStream(all: readonly ProjectMeta[]): Streamed[] {
    const out: Streamed[] = []
    for (const proj of all) {
      let real: string
      try {
        real = fs.realpathSync(proj.dir)
      } catch {
        continue
      }
      const rel = path.relative(this.realRoot, real)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      out.push({ proj, real })
    }
    return out
  }

  private stale(dir: string): boolean {
    return this.armedAs.get(dir) !== inodeOf(dir)
  }

  // Bun keeps one FSEvents stream per process and rebuilds it from "now" on
  // every watch opened or closed: what lands meanwhile is lost to every watch.
  // A re-arm that swapped `apps/`'s arms lost `apps/` recreated, and the edit
  // after it. So inside the root the one stream serves the ancestor and import
  // arms too, and a re-arm opens or closes none.
  /** Whether the one stream hears `dir`'s children: under the root by its real path. */
  private inStream(dir: string): boolean {
    if (!this.oneStream) return false
    const rel = path.relative(this.workspaceRoot, dir)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false
    try {
      return fs.realpathSync(dir) === path.join(this.realRoot, rel)
    } catch {
      return false
    }
  }

  private heardInStream(filename: string): void {
    const abs = path.join(this.workspaceRoot, filename)
    const dir = path.dirname(abs)
    if (this.streamedAncestors.has(dir)) this.ancestorEvent(dir, path.basename(abs))
    if (this.streamedImports.has(dir)) this.importEvent(dir, path.basename(abs))
  }

  // The deepest, as a nested project's file is its own.
  private ownerOf(abs: string): ProjectMeta | undefined {
    let best: ProjectMeta | undefined
    for (const proj of this.wide)
      if (
        abs.startsWith(proj.dir + path.sep) &&
        (best === undefined || proj.dir.length > best.dir.length)
      )
        best = proj
    return best
  }

  private projectEvent(proj: ProjectMeta, filename: string): void {
    const abs = path.join(proj.dir, filename)
    if (this.isIgnoredPath(proj.dir, filename) || this.fenced(proj.dir, abs)) return
    // A module the config imports from inside the project is the config
    // too: its edit can add an output or a `workspaceFiles` input.
    if (shapesWatchedSet(filename) || this.configImportFiles.includes(abs) || this.linkChanged(abs))
      this.reread = true
    // Inside a project (any repo whose root is one) no import arm hears it.
    if (this.wsConfigImportFiles.includes(abs)) this.sayStaleImport(abs)
    this.trigger(`${proj.name} ${filename}`, abs)
  }

  private armProject(proj: ProjectMeta): void {
    // Gone for now: its ancestor's arm (`armAncestors`) hears it return.
    if (inodeOf(proj.dir) === undefined) return
    try {
      const handle = this.arm(proj.dir, true, (filename) => this.projectEvent(proj, filename))
      this.perProject.set(proj.dir, handle)
      this.armedAs.set(proj.dir, inodeOf(proj.dir) ?? '')
    } catch (err) {
      sayCannot(`cannot watch ${proj.dir}`, err)
    }
  }

  private rootFileEvent(filename: string): void {
    const claimed = this.claimedRootFiles
    if (!isWorkspaceConfigFile(filename) && filename !== '.gitignore' && !claimed.has(filename))
      return
    if (shapesWatchedSet(filename) || filename === LOCKFILE_NAME || claimed.has(filename))
      this.reread = true
    this.trigger(`root ${filename}`, path.join(this.workspaceRoot, filename))
  }

  private dotVxEvent(filename: string): void {
    const rel = `.vx/${filename}`
    if (!isWorkspaceConfigFile(rel) && !this.claimedRootFiles.has(rel)) return
    this.reread = true
    this.trigger(`root ${rel}`, path.join(this.workspaceRoot, rel))
  }

  /**
   * The one stream's events, handed out as each per-project arm would have
   * heard them: an event lies in every watched project holding it (a nested
   * project's fence drops it from the outer).
   */
  private streamEvent(filename: string): void {
    this.heardInStream(filename)
    const rel = filename.split(path.sep).join('/')
    if (!rel.includes('/')) this.rootFileEvent(rel)
    else if (rel.startsWith('.vx/') && rel.indexOf('/', 4) < 0) this.dotVxEvent(rel.slice(4))
    const abs = path.join(this.realRoot, filename)
    for (const { proj, real } of this.streamed) {
      if (abs.startsWith(real + path.sep)) this.projectEvent(proj, path.relative(real, abs))
    }
  }

  private wideEvent(filename: string): void {
    if (!this.matters(filename) || this.isIgnoredPath(this.workspaceRoot, filename)) return
    const abs = path.join(this.workspaceRoot, filename)
    if (
      shapesWatchedSet(filename) ||
      filename === LOCKFILE_NAME ||
      this.claimedRootFiles.has(filename) ||
      this.configImportFiles.includes(abs)
    )
      this.reread = true
    if (this.wsConfigImportFiles.includes(abs)) this.sayStaleImport(abs)
    const owner = this.ownerOf(abs)
    this.trigger(
      owner === undefined ? `root ${filename}` : `${owner.name} ${path.relative(owner.dir, abs)}`,
      abs,
    )
  }

  private armRoot(): void {
    const workspaceRoot = this.workspaceRoot
    try {
      this.rootArm = this.workspaceWide
        ? // workspaceFiles inputs in play: a root-relative glob can name a
          // file anywhere, so one recursive root watcher replaces the
          // per-project ones (it also covers claimed root files). `matters`
          // keeps the events a key can see — project trees, claimed root files,
          // the declared globs — and drops the rest of the tree; the ignore
          // filter then keeps node_modules /.git /.vx and declared outputs out
          // of what remains.
          this.arm(workspaceRoot, true, (filename) => {
            if (this.oneStream) this.heardInStream(filename)
            this.wideEvent(filename)
          })
        : this.oneStream
          ? this.arm(workspaceRoot, true, (filename) => this.streamEvent(filename))
          : // The root itself, non-recursive, beside the per-project arms, so
            // claimed root files (a lockfile) trigger re-runs even when no
            // project dir saw the change.
            this.arm(workspaceRoot, false, (filename) => this.rootFileEvent(filename))
    } catch (err) {
      sayCannot(`cannot watch workspace root`, err)
    }
    // The workspace config and the lock sit in `.vx/`, which the root's
    // non-recursive arm does not see into.
    if (this.workspaceWide || this.oneStream) return
    try {
      this.dotVxArm = this.arm(path.join(workspaceRoot, '.vx'), false, (filename) =>
        this.dotVxEvent(filename),
      )
    } catch (err) {
      sayCannot(`cannot watch ${path.join(workspaceRoot, '.vx')}`, err)
    }
  }

  // One recursive watcher per project, unless workspace-wide; never the root
  // recursively for them (it would cover node_modules and caches). On macOS one
  // root stream stands for all (`oneStream`).
  private armMode(watched: readonly ProjectMeta[]): void {
    this.wide = this.workspaceWide ? watched : []
    if (!this.workspaceWide) {
      this.streamed = this.oneStream ? this.toStream(watched) : []
      const inStream = new Set(this.streamed.map((s) => s.proj))
      for (const proj of watched) if (!inStream.has(proj)) this.armProject(proj)
    }
    this.armRoot()
  }

  private dropMode(): void {
    this.streamed = []
    for (const handle of this.perProject.values()) handle.close()
    this.perProject.clear()
    this.rootArm.close()
    this.rootArm = CLOSED
    this.dotVxArm.close()
    this.dotVxArm = CLOSED
  }

  /**
   * A config's imports from outside watched projects
   * (`../../shared/preset.mjs`): one non-recursive arm per directory holding
   * one. A project config's import re-reads and runs; a workspace config's is
   * loaded once per process, so its edit is named with the restart it needs.
   */
  private sayStaleImport(abs: string): void {
    // One line per save, not per event: a save is often two.
    const now = Date.now()
    if (now - (this.staleNamed.get(abs) ?? 0) < 1_000) return
    this.staleNamed.set(abs, now)
    ui.say(
      'warn',
      `vx watch: ${printable(path.relative(this.workspaceRoot, abs))} changed; the workspace config imports it, and this process loaded it at start — restart vx watch to apply the edit\n`,
      'out',
    )
  }

  private importEvent(dir: string, filename: string): void {
    if (!(this.importNames.get(dir)?.has(filename) ?? false)) return
    const abs = path.join(dir, filename)
    const rel = path.relative(this.workspaceRoot, abs)
    if (this.configImportFiles.includes(abs)) {
      this.reread = true
      this.trigger(`config import ${rel}`, abs)
      return
    }
    this.sayStaleImport(abs)
  }

  private armImports(): void {
    const inProject = (f: string): boolean =>
      this.projectDirs.some((d) => f.startsWith(d + path.sep))
    const want = new Map<string, Set<string>>()
    for (const f of new Set([...this.configImportFiles, ...this.wsConfigImportFiles])) {
      if (inProject(f)) continue
      const names = want.get(path.dirname(f)) ?? new Set<string>()
      names.add(path.basename(f))
      want.set(path.dirname(f), names)
    }
    this.importNames = want
    this.streamedImports = new Set([...want.keys()].filter((d) => this.inStream(d)))
    for (const [dir, handle] of this.importArms) {
      if (want.has(dir) && !this.streamedImports.has(dir) && !this.stale(dir)) continue
      handle.close()
      this.importArms.delete(dir)
    }
    for (const dir of want.keys()) {
      if (this.importArms.has(dir) || this.streamedImports.has(dir)) continue
      // Gone for now: its ancestor's arm (`armAncestors`) hears it return.
      if (inodeOf(dir) === undefined) continue
      try {
        this.importArms.set(
          dir,
          this.arm(dir, false, (filename) => this.importEvent(dir, filename)),
        )
        this.armedAs.set(dir, inodeOf(dir) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${dir}`, err)
      }
    }
    this.armAncestors()
  }

  /** A link came, went or moved: the set `armLinks` reads is stale. */
  private linkChanged(abs: string): boolean {
    if (this.links.has(abs)) return true
    try {
      return fs.lstatSync(abs).isSymbolicLink()
    } catch {
      return false
    }
  }

  /**
   * What each symlink under a watched project points to: the key reads it
   * wherever it lies (cache/linked-inputs.ts), and the project's arm hears only
   * the link. A file target's directory non-recursively, a directory target
   * recursively; each event names the link. Re-read when a link comes or goes.
   */
  private armLinks(): void {
    const want = new Map<string, { proj: ProjectMeta; real: string; dir: boolean }>()
    for (const link of this.links) {
      let proj: ProjectMeta | undefined
      for (const p of this.watched)
        if (
          link.startsWith(p.dir + path.sep) &&
          (proj === undefined || p.dir.length > proj.dir.length)
        )
          proj = p
      if (proj === undefined) continue
      try {
        const real = fs.realpathSync(link)
        want.set(link, { proj, real, dir: fs.statSync(real).isDirectory() })
      } catch {
        // Dangling: its target string is all the key reads, and the link's own arm hears that.
      }
    }
    for (const [link, armed] of this.linkArms) {
      if (want.get(link)?.real === armed.target) continue
      armed.handle.close()
      this.linkArms.delete(link)
    }
    for (const [link, { proj, real, dir }] of want) {
      if (this.linkArms.has(link)) continue
      const name = path.basename(real)
      const label = `${proj.name} ${path.relative(proj.dir, link)}`
      try {
        const handle = this.arm(dir ? real : path.dirname(real), dir, (filename) => {
          if (!dir && filename !== name) return
          this.trigger(label, link)
        })
        this.linkArms.set(link, { target: real, handle })
        this.changes.seed(link)
      } catch (err) {
        sayCannot(`cannot watch ${real}`, err)
      }
    }
  }

  /**
   * The files a claimed file's recorded digests read besides it (a `file:`
   * directory, a patch): keyed, and outside any project arm. Re-armed when a
   * re-lock changes the set.
   */
  private armExtras(): void {
    const want = new Map<string, { at: string; dir: boolean }>()
    for (const abs of this.extraFiles) {
      const dir = isDirectory(abs)
      want.set(abs, { at: dir ? abs : path.dirname(abs), dir })
    }
    for (const [abs, armed] of this.extraArms) {
      if (want.get(abs)?.at === armed.at && !this.stale(armed.at)) continue
      armed.handle.close()
      this.extraArms.delete(abs)
    }
    for (const [abs, { at, dir }] of want) {
      if (this.extraArms.has(abs) || inodeOf(at) === undefined) continue
      const name = path.basename(abs)
      try {
        const handle = this.arm(at, dir, (filename) => {
          if (!dir && filename !== name) return
          const changed = dir ? path.join(abs, filename) : abs
          // A directory made where a file or nothing was armed: armed again, recursively.
          if (!dir && isDirectory(abs)) this.reread = true
          this.trigger(`root ${path.relative(this.workspaceRoot, changed)}`, changed)
        })
        this.extraArms.set(abs, { at, handle })
        this.armedAs.set(at, inodeOf(at) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${at}`, err)
      }
    }
  }

  private armExclude(): void {
    const excludeFile = this.excludeFile
    if (excludeFile === undefined || inodeOf(path.dirname(excludeFile)) === undefined) return
    try {
      this.arm(path.dirname(excludeFile), false, (filename) => {
        if (filename === 'exclude')
          this.trigger(`root ${path.relative(this.workspaceRoot, excludeFile)}`, excludeFile)
      })
    } catch (err) {
      sayCannot(`cannot watch ${path.dirname(excludeFile)}`, err)
    }
  }

  private sayWatching(count: number): void {
    const tasks = this.lastTasks === undefined ? '' : ` · ${plural(this.lastTasks, 'task')}`
    ui.say('info', `watching ${plural(count, 'project')}${tasks}`, 'out')
  }

  private sayArmed(count: number): void {
    const open = this.pool.open
    if (this.debugArms)
      ui.say(
        'info',
        `vx watch: armed ${plural(count, 'project')} (${open} watch${open === 1 ? '' : 'es'})`,
      )
  }

  /** Re-read the workspace and re-arm on it; a failed re-read is returned, for the caller to say. */
  private async rearm(say = true): Promise<unknown> {
    let next: Rediscovered
    try {
      next = await this.args.rediscover()
    } catch (err) {
      return err
    }
    this.cacheDir = next.cacheDir
    this.projectDirs = next.projects.map((p) => p.dir)
    this.workspaceInputs = next.workspaceInputs
    this.outputs = next.outputs
    // Linux's tree watcher picks the `node_modules` it enters when it arms
    // (watch-fs.ts): an input newly named there needs the trees armed again.
    const modulesRenamed = this.treeArms && modulesNamed(next.inputs) !== modulesNamed(this.inputs)
    this.inputs = next.inputs
    this.uncached = next.uncached
    this.namedIgnored = next.namedIgnored
    this.claimedRootFiles = next.claimedRootFiles
    this.extraFiles = next.extraFiles
    this.configImportFiles = next.configImports
    this.wsConfigImportFiles = next.workspaceConfigImports
    this.armAncestors()
    this.isIgnoredPath = makeWatchIgnore(
      this.cacheDir,
      this.outputs,
      this.inputs,
      this.atArm?.tracked,
    )
    this.fenced = makeFence(next.fenceDirs)
    this.matters = makeRootEventFilter(
      this.workspaceRoot,
      this.projectDirs,
      this.workspaceInputs,
      this.claimedRootFiles,
      this.fenced,
    )
    if (next.workspaceWide !== this.workspaceWide || modulesRenamed) {
      // A task started or stopped declaring `workspaceFiles`: the other arm's
      // shape. Chosen once, it left a newly named root file no event.
      this.dropMode()
      this.workspaceWide = next.workspaceWide
      this.armMode(next.projects)
    } else if (this.workspaceWide) this.wide = next.projects
    else this.rearmProjects(next.projects)
    this.armImports()
    this.watched = next.projects
    this.links = gitFiles(this.workspaceRoot)?.links ?? this.links
    this.armLinks()
    this.armExtras()
    // A new arm proves delivery like the first ones: an edit in the new
    // project right after this cycle is seen, not lost in the gap.
    await this.pool.proved()
    if (say) this.sayArmed(next.projects.length)
    return undefined
  }

  /** The per-project arms for `projects`: a gone or replaced one closed, a new one opened. */
  private rearmProjects(projects: readonly ProjectMeta[]): void {
    this.streamed = this.oneStream ? this.toStream(projects) : []
    const inStream = new Set(this.streamed.map((s) => s.proj))
    const own = projects.filter((p) => !inStream.has(p))
    const keep = new Set(own.map((p) => p.dir))
    for (const [dir, handle] of this.perProject) {
      if (keep.has(dir) && !this.stale(dir)) continue
      handle.close()
      this.perProject.delete(dir)
    }
    for (const proj of own) if (!this.perProject.has(proj.dir)) this.armProject(proj)
  }

  private ancestorEvent(dir: string, filename: string): void {
    // A project's parent's `.gitignore` shapes what its keys read, as the root's does.
    if (!this.ancestorNames.get(dir)?.has(filename) && filename !== '.gitignore') return
    const abs = path.join(dir, filename)
    // A project directory still the one its arm holds is no change: macOS
    // reports its mtime on every top-level write, and a cycle's own write
    // started the next.
    if (this.heldDirs.get(abs) === (inodeOf(abs) ?? '')) return
    this.reread = true
    this.trigger(path.relative(this.workspaceRoot, abs), abs)
  }

  private armAncestors(): void {
    const workspaceRoot = this.workspaceRoot
    const ancestorNames = new Map<string, Set<string>>()
    this.ancestorNames = ancestorNames
    const rootDir = path.resolve(workspaceRoot)
    const below = this.projectDirs.filter((d) => path.resolve(d) !== rootDir)
    this.heldDirs = new Map(
      below.flatMap((d) => {
        const id = inodeOf(d)
        return id === undefined ? [] : [[d, id]]
      }),
    )
    for (const base of [...below, ...this.importNames.keys()]) {
      let dir = path.dirname(base)
      let name = path.basename(base)
      while (inodeOf(dir) === undefined && dir !== workspaceRoot && dir !== path.dirname(dir)) {
        name = path.basename(dir)
        dir = path.dirname(dir)
      }
      for (;;) {
        const names = ancestorNames.get(dir) ?? new Set<string>()
        // A directory already holding this name was climbed from here before.
        const climbed = names.has(name)
        ancestorNames.set(dir, names.add(name))
        // Outside the root (a preset a config imports from `../`) only the nearest arm.
        if (climbed || !dir.startsWith(workspaceRoot + path.sep)) break
        name = path.basename(dir)
        dir = path.dirname(dir)
      }
    }
    this.streamedAncestors = new Set([...ancestorNames.keys()].filter((d) => this.inStream(d)))
    for (const [dir, handle] of this.ancestorArms) {
      if (ancestorNames.has(dir) && !this.streamedAncestors.has(dir) && !this.stale(dir)) continue
      handle.close()
      this.ancestorArms.delete(dir)
    }
    for (const dir of ancestorNames.keys()) {
      if (this.ancestorArms.has(dir) || this.streamedAncestors.has(dir)) continue
      try {
        this.ancestorArms.set(
          dir,
          this.arm(dir, false, (filename) => this.ancestorEvent(dir, filename)),
        )
        this.armedAs.set(dir, inodeOf(dir) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${dir}`, err)
      }
    }
  }

  /**
   * Files written since the initial run started by none of its commands, each
   * judged a change. Only files git finds untracked or modified qualify, and
   * `atArm` asked git already, so a start with no edit costs only stats. An
   * edit before its task keyed it re-runs to a hit.
   */
  private heardSinceRun(): boolean {
    const { initialRun } = this.args
    const workspaceRoot = this.workspaceRoot
    let heard = false
    for (const abs of this.atArm?.dirty ?? []) {
      let t: number
      try {
        const st = fs.lstatSync(abs)
        if (Math.max(st.mtimeMs, st.ctimeMs) < initialRun.from) continue
        t = st.ctimeMs
      } catch {
        // Gone: a deletion has no date, and one made before the start would run every start.
        continue
      }
      if (
        initialRun.windows.writerDuring('', abs, t, t + racyWindowMs(t, FILE_HASH_RACY_MS)) !==
        undefined
      )
        continue
      const rel = path.relative(workspaceRoot, abs)
      if (this.workspaceWide) this.wideEvent(rel)
      else {
        if (!rel.includes(path.sep)) this.rootFileEvent(rel)
        else if (rel.startsWith(`.vx${path.sep}`) && !rel.slice(4).includes(path.sep))
          this.dotVxEvent(rel.slice(4))
        for (const proj of this.watched)
          if (abs.startsWith(proj.dir + path.sep))
            this.projectEvent(proj, path.relative(proj.dir, abs))
      }
      if (!this.changes.pending.has(abs)) continue
      this.changes.unseen([abs])
      heard = true
    }
    return heard
  }
}

// Birth time is part of a directory's name: a freed inode number goes straight
// to the next directory made.
function inodeOf(dir: string): string | undefined {
  try {
    const st = fs.statSync(dir)
    return `${st.dev}:${st.ino}:${st.birthtimeMs}`
  } catch {
    return undefined
  }
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The lock's identity, `''` when there is none: a re-lock changes it. */
export function lockStamp(workspaceRoot: string): string {
  try {
    const st = fs.statSync(path.join(workspaceRoot, LOCKFILE_NAME))
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
  } catch {
    return ''
  }
}

/**
 * The event a finished cycle hands back to the timer, if any: one landing
 * between the last judgement and idle would sit in `changes.pending` with no
 * timer, and watch idled over an edit. Insertion order: the first label wins
 * and is what the cycle announces. Extracted so the decision can be pinned; no
 * e2e test can hit that instant.
 */
export function pendingAfterCycle(
  pending: ReadonlyMap<string, string>,
  aborted: boolean,
): [abs: string, label: string] | undefined {
  if (aborted || pending.size === 0) return undefined
  const [abs, label] = [...pending][0]!
  return [abs, label]
}
