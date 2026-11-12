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
  run as runOrchestrator,
  type HeldPersistent,
  type RunOptions,
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
 * One line for a cycle every task of which was a cache hit, where hits
 * print no row: watch prints no footer, so such a cycle said nothing, and
 * a failure the cycle before stayed the last outcome on screen.
 */
export function sayAllCached(opts: RunOptions, outcomes: readonly { status: string }[]): void {
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
 * ...but no longer than this after the first: a writer that never pauses
 * for a window (a dev server logging into its project every 50 ms) reset
 * the timer forever, and an edit made meanwhile never ran.
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
  opts: RunOptions
  /** The persistent tasks the initial run left running; the next cycle stops them before it starts. */
  held: HeldPersistent | undefined
  /** The initial run, still in flight: the loop's first cycle. */
  initial: InitialCycle | undefined
  initialRun: InitialRun
  /** The initial run's task count, once it has started. */
  tasks: () => number | undefined
  /** A task the initial run left unsaved because its inputs moved under it (`TaskOutcome.unkeyed`). */
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
   * Root files a plugin claims (`VxPlugin.fingerprint`): a lockfile, or a
   * file its stages read (`turbo.json`, item 961). The workspace config is
   * loaded once per process, so the set is fixed for the loop.
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
  const { opts, stop, workspaceRoot, projects } = args
  // The watched set as of the last cycle: `rearm` replaces these after an
  // event that can change it, and every filter below reads the current one.
  let cacheDir = args.cacheDir
  let workspaceWide = args.workspaceWide
  let projectDirs = args.projectDirs
  let workspaceInputs = args.workspaceInputs
  let outputs = args.outputs
  let inputs = args.inputs
  let uncached = args.uncached
  let namedIgnored = args.namedIgnored
  let claimedRootFiles = args.claimedRootFiles
  let extraFiles = args.extraFiles
  let configImportFiles = args.configImports
  let wsConfigImportFiles = args.workspaceConfigImports
  // A dev server stays up while the loop idles and across cycles; a cycle
  // that must restart it (its config changed, it died) stops it before its
  // graph, so the new one never meets the old one's port.
  let held = args.held
  /** The watched projects: `rearm` replaces them. */
  let watched = projects

  // Reentrancy guard — never two orchestrator runs in flight. Events that
  // land while one is running wait in `changes.pending` and are judged, on
  // settled bytes, one debounce window after it ends.
  let running = args.initial !== undefined
  /** The cycle in flight, so the stop path can wait for its teardown before resolving. */
  let inFlight: Promise<void> = Promise.resolve()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** The run in flight, while one is. */
  let current: WatchCycle | undefined
  /** What stopped a cycle that waited on a server's readiness; the loop runs it next. */
  let interruptedBy: string | undefined
  let interruptTimer: ReturnType<typeof setTimeout> | null = null
  /** The server's own writes among the paths that stopped the last cycle waiting on readiness. */
  let stoppedLast = new Set<string>()
  // Judged on settled state one window later, as an idle edit is, and only
  // if the cycle still waits on readiness alone by then.
  const interruptIfWaiting = (): void => {
    if (changes.pending.size === 0 || current?.waitsOnReadiness() !== true) return
    if (interruptTimer) clearTimeout(interruptTimer)
    interruptTimer = setTimeout(() => {
      interruptTimer = null
      const c = current
      if (c === undefined || c.interrupted || !c.waitsOnReadiness() || stop.aborted) return
      const label = changes.judge()
      if (label === undefined) return
      // What a server writes in its project as it boots (a timestamped
      // config bundle, a route tree) is an edit: it stopped the cycle, the
      // next server wrote it again, and the loop restarted it for good,
      // never ready. A path that stopped the last such cycle, untracked
      // and in a waiting server's project, is that server's own write.
      const dirs = c.serverDirs()
      const own = changes.changed.filter(
        (p) => dirs.some((d) => p.startsWith(d + path.sep)) && !changes.tracked(p),
      )
      const again = own.length === changes.changed.length && own.every((p) => stoppedLast.has(p))
      stoppedLast = new Set(own)
      if (again) return
      interruptedBy = label
      c.interrupt()
    }, DEBOUNCE_MS)
  }
  let windowOpened = 0

  const hasWorkspaceFile = (): boolean =>
    WORKSPACE_CONFIG_FILENAMES.some((n) => fs.existsSync(path.join(workspaceRoot, n)))
  /** The lock as the last cycle found it: a config edit with no re-lock since changes no command. */
  let lockSeen = args.initialRun.lock
  // Every cycle's configs are the lock's, so a config edit alone ran a cycle
  // that printed `changed` and nothing else, read as the edit applied. A
  // config gone is the run's own refusal to name.
  const sayUnlocked = (paths: readonly string[]): void => {
    for (const abs of paths)
      if ((isProjectConfigFile(abs) || configImportFiles.includes(abs)) && fs.existsSync(abs))
        sayNotice(
          'warn',
          'vx watch',
          `${printable(path.relative(workspaceRoot, abs))} changed; runs read the lock, so run \`vx lock\` to apply it`,
        )
  }
  const trigger = (label: string, abs: string): void => {
    if (!changes.pending.has(abs)) changes.pending.set(abs, label)
    changes.sawEvent(abs)
    if (running) return interruptIfWaiting()
    if (debounceTimer) {
      if (performance.now() - windowOpened >= DEBOUNCE_MAX_MS) return
      clearTimeout(debounceTimer)
    } else windowOpened = performance.now()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (running) return
      const first = changes.judge()
      if (first !== undefined) void cycle(first)
    }, DEBOUNCE_MS)
  }

  const cycle = async (label: string): Promise<void> => {
    if (stop.aborted || running) return
    running = true
    const done = (inFlight = runCycle(label))
    await done
  }
  const runCycle = async (first: string | undefined, initial?: InitialCycle): Promise<void> => {
    try {
      let label: string | undefined = first
      /** The lock this cycle's run read; none for the initial run. */
      let lockAtRun: string | undefined
      // The initial run is collected even after a stop: its server is the
      // loop's to stop.
      while (initial !== undefined || (label !== undefined && !stop.aborted)) {
        /** This cycle's failure, as said: a re-read failing on the same cause says nothing more. */
        let failed: string | undefined
        /** The judged cycle this run is (`ChangeJudge.cycle`): its window closes when the run ends. */
        const judged = changes.cycle
        if (initial !== undefined) {
          held = await initial.held
          initial = undefined
        } else
          try {
            // A member came or went: armed before the run keys it, an edit in a
            // new package while its first cycle runs queues like any other; armed
            // only after, it fell in the gap and ran nothing (X-138). The re-read
            // after the run stays, for what the run itself changed.
            lockAtRun = lockStamp(workspaceRoot)
            const relocked = lockAtRun !== lockSeen
            lockSeen = lockAtRun
            // The file marks the root, and `vx run` refuses without it; a
            // cycle ran on with no workspace config, its plugins gone and
            // its tasks named by path.
            if (!hasWorkspaceFile()) {
              ui.print('out', ui.gap())
              ui.say('info', `changed ${label}`, 'out')
              throw new Error(
                `no .vx/workspace.ts in ${workspaceRoot}; restore it, or stop vx watch`,
              )
            }
            // A failed re-read is said once, by the re-read after the
            // cycle: said here too, it printed above the cycle's header.
            if (reread) await rearm(false)
            ui.print('out', ui.gap())
            ui.say('info', `changed ${label}`, 'out')
            if (!relocked) sayUnlocked(changes.changed)
            if (stop.aborted) break
            // A file a `.gitignore` edit stops ignoring is an input from this
            // cycle on, and was not on the arm's inventory: its deletion read
            // as a file born and gone since, and ran nothing.
            if (
              atArm !== undefined &&
              changes.changed.some((p) => path.basename(p) === '.gitignore' || p === excludeFile)
            ) {
              for (const p of gitFiles(workspaceRoot)?.listed ?? []) atArm.listed.add(p)
              reachOf = undefined
            }
            restartTimings()
            // On the mtime clock, as the arm is: from `Date.now()` a write the
            // run made within a tick of it carried an earlier mtime and read as
            // an edit (WD-20). The end needs no stamp: an mtime never leads it.
            const start = fsClockNow(cacheDir)
            // A server still up whose task is unchanged stays up: the cycle
            // rebuilds what it depends on, and the dev tool's own reload
            // takes it from there. The run stops the others before its graph.
            const before = held
            current = watchCycle(
              {
                ...opts,
                ...(before ? { keep: before } : {}),
                ...(judged ? { commandWindows: judged.windows } : {}),
              },
              stop,
              interruptIfWaiting,
            )
            const cycle = await runOrchestrator(current.opts)
            changes.unseen(
              cycle.outcomes.flatMap((o) => (o.driftedInput === undefined ? [] : [o.driftedInput])),
            )
            sayAllCached(opts, cycle.outcomes)
            lastTasks = current.tasks ?? lastTasks
            current = undefined
            held = cycle.persistent
            // What this cycle did not take (a server whose task did not run).
            await before?.stop()
            if (cycle.refused !== undefined) sayNotice('error', 'vx watch', cycle.refused)
            changes.lastCycle = { start, end: Date.now() }
          } catch (err) {
            // A re-run can fail catastrophically when the workspace
            // itself moved out from under us — e.g. the user deleted
            // the project dir, or git lost its repo (the watch loop
            // outlives its own cwd in test teardown). Surface the
            // message but DON'T let it crash the watch loop; the next
            // FS event (if any) will retry. The dispose() on SIGINT
            // is the canonical exit; we don't unilaterally abort here.
            // A config's own throw or a plugin's failure may quote a secret (L-11).
            failed = err instanceof Error ? err.message : String(err)
            sayNotice('error', 'vx watch', `cycle failed: ${maskedLine(failed)}`)
          }
        if (judged !== undefined) judged.to = Math.min(judged.to, Date.now())
        // After a failed cycle too: a package added with a config that does
        // not load yet fails its cycle, and unarmed, the fix to that config
        // was never an event.
        if (reread && !stop.aborted && hasWorkspaceFile()) {
          reread = false
          const err = await rearm()
          // No lock is the cycle's own failure to say; said here too, it was two lines.
          const why = err instanceof Error ? err.message : String(err)
          if (err !== undefined && why !== NO_LOCK && why !== failed)
            sayCannot(`cannot re-read the workspace`, err)
        }
        // A re-lock since this cycle began: the re-arm can close the watcher
        // its event was still on its way to (FSEvents' latency, a poller's
        // tick), and the new lock ran nothing until the next edit (macOS CI,
        // 2026-10-23). A cycle that read the lock mid-write failed on it, and
        // is the same case. Asked after the re-arm, not when the run ends: a
        // lock written in between was the re-arm's to read, its new pollers
        // took it as their baseline, and it was never an event (macOS CI,
        // 2026-11-06).
        if (lockAtRun !== undefined && lockStamp(workspaceRoot) !== lockAtRun)
          rootFileEvent(LOCKFILE_NAME)
        // What landed mid-run is judged on settled state, one window
        // after the run, under the label of what actually arrived.
        current = undefined
        if (stop.aborted) break
        if (interruptedBy === undefined) stoppedLast = new Set()
        if (interruptedBy !== undefined) {
          label = interruptedBy
          interruptedBy = undefined
          continue
        }
        if (changes.pending.size === 0) break
        await Bun.sleep(DEBOUNCE_MS)
        label = changes.judge()
      }
    } finally {
      running = false
      // Anything that landed after the last judgement waits for a timer
      // like any other event.
      const next = pendingAfterCycle(changes.pending, stop.aborted)
      if (next !== undefined) trigger(next[1], next[0])
    }
  }

  // Filter out events for paths we don't care about. We watch each
  // project's dir recursively, so a `node_modules` write under a
  // project would otherwise trigger every save during `bun install` —
  // and vx's own cache writes would trigger a cycle that writes again.
  /** What existed and was tracked at the arm, so a file born and gone since is no deletion and a tracked one is the user's edit (watch-judge.ts). */
  const atArm = gitFiles(workspaceRoot, true)
  let isIgnoredPath = makeWatchIgnore(cacheDir, outputs, inputs, atArm?.tracked)
  let fenced = makeFence(args.fenceDirs)
  let matters = makeRootEventFilter(
    workspaceRoot,
    projectDirs,
    workspaceInputs,
    claimedRootFiles,
    fenced,
  )
  /** Since the last cycle, a member came or went, or a file that shapes the watched set changed (`shapesWatchedSet`). */
  let reread = false

  // The poller skips exactly what the event filter would drop: the
  // unconditional segments AND this run's declared output containers. Read
  // through `isIgnoredPath` rather than captured, because `rearm` replaces
  // the filter when the selection changes.
  const pool = new WatcherPool((dir, rel) => isIgnoredPath(dir, rel, true), args.poll)
  const arm = (dir: string, recursive: boolean, onEvent: (filename: string) => void): WatchHandle =>
    pool.arm(dir, recursive, onEvent)

  // Only the named entries a key reads ignored files under: `src` of
  // `src/**` over a listed `src` reaches none, and a dev server's ignored
  // `src/dev.log` started ~3 cycles a second. Reckoned per sweep.
  let reachOf: readonly string[] | undefined
  let reach: readonly string[] = []
  /** The instant the watchers go live, on the mtime clock (see `fsClockNow`): a path last modified before it is the initial run's, not an edit. */
  const armedAt = fsClockNow(cacheDir)
  /** Which settled paths are changes (watch-judge.ts); `pending` holds what fired since. */
  const changes = new ChangeJudge({
    workspaceRoot,
    armedAt,
    clock: () => fsClockNow(cacheDir),
    held: () => held !== undefined,
    serverDirs: () => {
      const names = new Set(held?.ids.map((id) => id.slice(0, id.lastIndexOf('#'))))
      return watched.filter((p) => names.has(p.name)).map((p) => p.dir)
    },
    uncached: () => uncached,
    namedIgnored: () => {
      if (reachOf !== namedIgnored) {
        reachOf = namedIgnored
        reach =
          atArm === undefined
            ? namedIgnored
            : namedIgnoredReach(workspaceRoot, namedIgnored, atArm.listed)
      }
      return reach
    },
    fenced: (ownDir, abs) => fenced(ownDir, abs),
    awaited: (abs) => ancestorNames.get(path.dirname(abs))?.has(path.basename(abs)) === true,
    ...(atArm !== undefined ? { existedAtArm: atArm.listed, trackedAtArm: atArm.tracked } : {}),
  })
  /** Per-project arms by directory, so `rearm` can add and drop them. */
  const perProject = new Map<string, WatchHandle>()
  // Each FSEvents stream goes live slower than the one before it: per
  // project, 751 of 3000 missed their 2 s proof on a macos-latest runner
  // and fell back to polling, a full core at idle; one stream at the root
  // went live in 8 ms (tests/watch-one-stream.test.ts). Polling keeps its
  // per-project walks, which skip what lies between projects.
  const oneStream = process.platform === 'darwin' && !args.poll
  const treeArms = process.platform === 'linux' && !args.poll
  /** The projects the one stream hands events to, by their real directory. */
  let streamed: { proj: ProjectMeta; real: string }[] = []
  const realRoot = ((): string => {
    try {
      return fs.realpathSync(workspaceRoot)
    } catch {
      return path.resolve(workspaceRoot)
    }
  })()
  // The stream names a file by its real place under the root, so a project
  // whose real directory lies outside the root keeps its own arm.
  const toStream = (all: readonly ProjectMeta[]): { proj: ProjectMeta; real: string }[] => {
    const out: { proj: ProjectMeta; real: string }[] = []
    for (const proj of all) {
      let real: string
      try {
        real = fs.realpathSync(proj.dir)
      } catch {
        continue
      }
      const rel = path.relative(realRoot, real)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      out.push({ proj, real })
    }
    return out
  }
  // An OS watch holds the directory's inode, not its path: one removed and
  // made again (`rm -rf packages && git checkout packages`) keeps reporting
  // for the deleted one. Each arm notes the directory it holds, and a
  // re-arm replaces any whose path now names another. The birth time is
  // part of the name: a freed inode number is handed straight to the next
  // directory made (measured on this box's /tmp), so the number alone
  // said "the same one" of a new directory.
  const armedAs = new Map<string, string>()
  const inodeOf = (dir: string): string | undefined => {
    try {
      const st = fs.statSync(dir)
      return `${st.dev}:${st.ino}:${st.birthtimeMs}`
    } catch {
      return undefined
    }
  }
  const stale = (dir: string): boolean => armedAs.get(dir) !== inodeOf(dir)
  // Bun keeps ONE FSEvents stream for every `fs.watch` of a process and
  // rebuilds it, from "now", on each watch opened or closed: what lands
  // while it is down is lost to every watch, the proved root stream
  // included, and a close proves nothing after it. A re-arm that swapped
  // `apps/`'s arms lost `apps/` made again, and the edit after it, for good
  // (macOS CI, 2026-11-04). So inside the root the one stream serves the
  // ancestor and import arms too, and a re-arm there opens or closes none.
  /** Whether the one stream hears `dir`'s children: under the root by its real path. */
  const inStream = (dir: string): boolean => {
    if (!oneStream) return false
    const rel = path.relative(workspaceRoot, dir)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false
    try {
      return fs.realpathSync(dir) === path.join(realRoot, rel)
    } catch {
      return false
    }
  }
  /** The ancestor and import directories the one stream serves (`inStream`). */
  let streamedAncestors = new Set<string>()
  let streamedImports = new Set<string>()
  const heardInStream = (filename: string): void => {
    const abs = path.join(workspaceRoot, filename)
    const dir = path.dirname(abs)
    if (streamedAncestors.has(dir)) ancestorEvent(dir, path.basename(abs))
    if (streamedImports.has(dir)) importEvent(dir, path.basename(abs))
  }
  /** The projects the workspace-wide arm names an event by. */
  let wide: readonly ProjectMeta[] = []
  // The deepest, as a nested project's file is its own.
  const ownerOf = (abs: string): ProjectMeta | undefined => {
    let best: ProjectMeta | undefined
    for (const proj of wide)
      if (
        abs.startsWith(proj.dir + path.sep) &&
        (best === undefined || proj.dir.length > best.dir.length)
      )
        best = proj
    return best
  }
  /** The root arm: recursive when workspace-wide or the one stream, else the root's own files only. */
  let rootArm: WatchHandle = CLOSED
  let dotVxArm: WatchHandle = CLOSED
  const projectEvent = (proj: ProjectMeta, filename: string): void => {
    const abs = path.join(proj.dir, filename)
    if (isIgnoredPath(proj.dir, filename) || fenced(proj.dir, abs)) return
    // A module the config imports from inside the project is the config
    // too: its edit can add an output or a `workspaceFiles` input.
    if (shapesWatchedSet(filename) || configImportFiles.includes(abs) || linkChanged(abs))
      reread = true
    // Inside a project (any repo whose root is one) no import arm hears it.
    if (wsConfigImportFiles.includes(abs)) sayStaleImport(abs)
    trigger(`${proj.name} ${filename}`, abs)
  }
  const armProject = (proj: ProjectMeta): void => {
    // Gone for now: its ancestor's arm (`armAncestors`) hears it return.
    if (inodeOf(proj.dir) === undefined) return
    try {
      const handle = arm(proj.dir, true, (filename) => projectEvent(proj, filename))
      perProject.set(proj.dir, handle)
      armedAs.set(proj.dir, inodeOf(proj.dir) ?? '')
    } catch (err) {
      sayCannot(`cannot watch ${proj.dir}`, err)
    }
  }
  const rootFileEvent = (filename: string): void => {
    if (
      !isWorkspaceConfigFile(filename) &&
      filename !== '.gitignore' &&
      !claimedRootFiles.has(filename)
    )
      return
    if (shapesWatchedSet(filename) || filename === LOCKFILE_NAME || claimedRootFiles.has(filename))
      reread = true
    trigger(`root ${filename}`, path.join(workspaceRoot, filename))
  }
  const dotVxEvent = (filename: string): void => {
    const rel = `.vx/${filename}`
    if (!isWorkspaceConfigFile(rel) && !claimedRootFiles.has(rel)) return
    reread = true
    trigger(`root ${rel}`, path.join(workspaceRoot, rel))
  }
  /**
   * The one stream's events, handed out as the per-project arms, the
   * root's own files and `.vx/` would have heard them: an event lies in
   * every watched project whose tree holds it (a nested one's fence drops
   * it from the outer), so each listener decides exactly as its own arm did.
   */
  const streamEvent = (filename: string): void => {
    heardInStream(filename)
    const rel = filename.split(path.sep).join('/')
    if (!rel.includes('/')) rootFileEvent(rel)
    else if (rel.startsWith('.vx/') && rel.indexOf('/', 4) < 0) dotVxEvent(rel.slice(4))
    const abs = path.join(realRoot, filename)
    for (const { proj, real } of streamed) {
      if (abs.startsWith(real + path.sep)) projectEvent(proj, path.relative(real, abs))
    }
  }
  const wideEvent = (filename: string): void => {
    if (!matters(filename) || isIgnoredPath(workspaceRoot, filename)) return
    const abs = path.join(workspaceRoot, filename)
    if (
      shapesWatchedSet(filename) ||
      filename === LOCKFILE_NAME ||
      claimedRootFiles.has(filename) ||
      configImportFiles.includes(abs)
    )
      reread = true
    if (wsConfigImportFiles.includes(abs)) sayStaleImport(abs)
    const owner = ownerOf(abs)
    trigger(
      owner === undefined ? `root ${filename}` : `${owner.name} ${path.relative(owner.dir, abs)}`,
      abs,
    )
  }
  const armRoot = (): void => {
    try {
      rootArm = workspaceWide
        ? // workspaceFiles inputs in play: a root-relative glob can name a
          // file anywhere, so one recursive root watcher replaces the
          // per-project ones (it also covers claimed root files).
          // `matters` keeps the events a key can see —
          // project trees, claimed root files, the declared globs — and drops
          // the rest of the tree; the ignore filter then keeps node_modules
          // / .git / .vx and declared outputs out of what remains.
          arm(workspaceRoot, true, (filename) => {
            if (oneStream) heardInStream(filename)
            wideEvent(filename)
          })
        : oneStream
          ? arm(workspaceRoot, true, streamEvent)
          : // The root itself, non-recursive, beside the per-project arms, so
            // claimed root files (a lockfile) trigger re-runs even when no
            // project dir saw the change.
            arm(workspaceRoot, false, rootFileEvent)
    } catch (err) {
      sayCannot(`cannot watch workspace root`, err)
    }
    // The workspace config and the lock sit in `.vx/`, which the root's
    // non-recursive arm does not see into.
    if (workspaceWide || oneStream) return
    try {
      dotVxArm = arm(path.join(workspaceRoot, '.vx'), false, dotVxEvent)
    } catch (err) {
      sayCannot(`cannot watch ${path.join(workspaceRoot, '.vx')}`, err)
    }
  }
  // One recursive watcher per project, unless workspace-wide: each project
  // owns its own subtree; the root is never watched recursively for them
  // (it would cover every project + node_modules + caches). On macOS one
  // recursive stream at the root stands for all of them (`oneStream`).
  const armMode = (watched: readonly ProjectMeta[]): void => {
    wide = workspaceWide ? watched : []
    if (!workspaceWide) {
      streamed = oneStream ? toStream(watched) : []
      const inStream = new Set(streamed.map((s) => s.proj))
      for (const proj of watched) if (!inStream.has(proj)) armProject(proj)
    }
    armRoot()
  }
  const dropMode = (): void => {
    streamed = []
    for (const handle of perProject.values()) handle.close()
    perProject.clear()
    rootArm.close()
    rootArm = CLOSED
    dotVxArm.close()
    dotVxArm = CLOSED
  }

  /**
   * A config's imports from outside the watched projects: a shared preset
   * (`../../shared/preset.mjs`) changed what a run evaluates and no arm
   * saw it (item 949). One non-recursive arm per directory holding one.
   * A project config's import re-reads and runs; a workspace config's is
   * loaded once per process (Bun keeps the module), so its edit is named
   * with the restart it needs instead of a cycle that would run stale.
   */
  const importArms = new Map<string, WatchHandle>()
  let importNames = new Map<string, Set<string>>()
  const staleNamed = new Map<string, number>()
  const sayStaleImport = (abs: string): void => {
    // One line per save, not per event: a save is often two.
    const now = Date.now()
    if (now - (staleNamed.get(abs) ?? 0) < 1_000) return
    staleNamed.set(abs, now)
    ui.say(
      'warn',
      `vx watch: ${printable(path.relative(workspaceRoot, abs))} changed; the workspace config imports it, and this process loaded it at start — restart vx watch to apply the edit\n`,
      'out',
    )
  }
  const importEvent = (dir: string, filename: string): void => {
    if (!(importNames.get(dir)?.has(filename) ?? false)) return
    const abs = path.join(dir, filename)
    const rel = path.relative(workspaceRoot, abs)
    if (configImportFiles.includes(abs)) {
      reread = true
      trigger(`config import ${rel}`, abs)
      return
    }
    sayStaleImport(abs)
  }
  const armImports = (): void => {
    const inProject = (f: string): boolean => projectDirs.some((d) => f.startsWith(d + path.sep))
    const want = new Map<string, Set<string>>()
    for (const f of new Set([...configImportFiles, ...wsConfigImportFiles])) {
      if (inProject(f)) continue
      const names = want.get(path.dirname(f)) ?? new Set<string>()
      names.add(path.basename(f))
      want.set(path.dirname(f), names)
    }
    importNames = want
    streamedImports = new Set([...want.keys()].filter(inStream))
    for (const [dir, handle] of importArms) {
      if (want.has(dir) && !streamedImports.has(dir) && !stale(dir)) continue
      handle.close()
      importArms.delete(dir)
    }
    for (const dir of want.keys()) {
      if (importArms.has(dir) || streamedImports.has(dir)) continue
      // Gone for now: its ancestor's arm (`armAncestors`) hears it return.
      if (inodeOf(dir) === undefined) continue
      try {
        importArms.set(
          dir,
          arm(dir, false, (filename) => importEvent(dir, filename)),
        )
        armedAs.set(dir, inodeOf(dir) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${dir}`, err)
      }
    }
    armAncestors()
  }

  /**
   * What each symlink under a watched project points to: the key reads it,
   * wherever it lies (cache/linked-inputs.ts), and the project's arm hears
   * only the link. A file target's directory, non-recursive, or a directory
   * target, recursive; each event names the link. Links are read again when
   * one comes or goes (`projectEvent`).
   */
  const linkArms = new Map<string, { target: string; handle: WatchHandle }>()
  let links = atArm?.links ?? new Set<string>()
  /** A link came, went or moved: the set `armLinks` reads is stale. */
  const linkChanged = (abs: string): boolean => {
    if (links.has(abs)) return true
    try {
      return fs.lstatSync(abs).isSymbolicLink()
    } catch {
      return false
    }
  }
  const armLinks = (): void => {
    const want = new Map<string, { proj: ProjectMeta; real: string; dir: boolean }>()
    for (const link of links) {
      let proj: ProjectMeta | undefined
      for (const p of watched)
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
    for (const [link, armed] of linkArms) {
      if (want.get(link)?.real === armed.target) continue
      armed.handle.close()
      linkArms.delete(link)
    }
    for (const [link, { proj, real, dir }] of want) {
      if (linkArms.has(link)) continue
      const name = path.basename(real)
      const label = `${proj.name} ${path.relative(proj.dir, link)}`
      try {
        const handle = arm(dir ? real : path.dirname(real), dir, (filename) => {
          if (!dir && filename !== name) return
          trigger(label, link)
        })
        linkArms.set(link, { target: real, handle })
        changes.seed(link)
      } catch (err) {
        sayCannot(`cannot watch ${real}`, err)
      }
    }
  }

  /**
   * The files a claimed file's recorded digests read besides it (a `file:`
   * dependency's directory, a patch; `lockedExtras`): a run keys them, and
   * no project's arm hears one outside its tree. A directory recursively,
   * a file (or a path gone for now) from its directory; armed again when a
   * re-lock changes the set.
   */
  const extraArms = new Map<string, { at: string; handle: WatchHandle }>()
  const armExtras = (): void => {
    const want = new Map<string, { at: string; dir: boolean }>()
    for (const abs of extraFiles) {
      const dir = isDirectory(abs)
      want.set(abs, { at: dir ? abs : path.dirname(abs), dir })
    }
    for (const [abs, armed] of extraArms) {
      if (want.get(abs)?.at === armed.at && !stale(armed.at)) continue
      armed.handle.close()
      extraArms.delete(abs)
    }
    for (const [abs, { at, dir }] of want) {
      if (extraArms.has(abs) || inodeOf(at) === undefined) continue
      const name = path.basename(abs)
      try {
        const handle = arm(at, dir, (filename) => {
          if (!dir && filename !== name) return
          const changed = dir ? path.join(abs, filename) : abs
          // A directory made where a file or nothing was armed: armed again, recursively.
          if (!dir && isDirectory(abs)) reread = true
          trigger(`root ${path.relative(workspaceRoot, changed)}`, changed)
        })
        extraArms.set(abs, { at, handle })
        armedAs.set(at, inodeOf(at) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${at}`, err)
      }
    }
  }
  /**
   * `info/exclude` ignores as a `.gitignore` does, and keys are
   * gitignore-aware (X-136), so its edit is a cycle; the ignore filter drops
   * every path under `.git/`. Armed once, from the common dir the run's own
   * enumeration asked git for (`repoFacts`, memoised).
   */
  const commonDir = repoFacts(workspaceRoot)?.commonDir
  const excludeFile =
    commonDir === undefined ? undefined : path.resolve(workspaceRoot, commonDir, 'info', 'exclude')
  const armExclude = (): void => {
    if (excludeFile === undefined || inodeOf(path.dirname(excludeFile)) === undefined) return
    try {
      arm(path.dirname(excludeFile), false, (filename) => {
        if (filename === 'exclude')
          trigger(`root ${path.relative(workspaceRoot, excludeFile)}`, excludeFile)
      })
    } catch (err) {
      sayCannot(`cannot watch ${path.dirname(excludeFile)}`, err)
    }
  }

  // Said once, when the loop first arms: a re-arm repeated it after every
  // cycle that re-read the watched set, between task rows. `debug.watch`
  // says each arm on stderr, for whoever needs to see the set change.
  let lastTasks: number | undefined
  const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  const sayWatching = (count: number): void => {
    const tasks = lastTasks === undefined ? '' : ` · ${plural(lastTasks, 'task')}`
    ui.say('info', `watching ${plural(count, 'project')}${tasks}`, 'out')
  }
  const debugArms = resolveSetting('debug.watch', undefined).value === true
  const sayArmed = (count: number): void => {
    if (debugArms)
      ui.say(
        'info',
        `vx watch: armed ${plural(count, 'project')} (${pool.open} watch${pool.open === 1 ? '' : 'es'})`,
      )
  }

  /** Re-read the workspace and re-arm on it; a failed re-read is returned, for the caller to say. */
  const rearm = async (say = true): Promise<unknown> => {
    let next: Rediscovered
    try {
      next = await args.rediscover()
    } catch (err) {
      return err
    }
    cacheDir = next.cacheDir
    projectDirs = next.projects.map((p) => p.dir)
    workspaceInputs = next.workspaceInputs
    outputs = next.outputs
    // Linux's tree watcher picks the `node_modules` it enters when it arms
    // (watch-fs.ts): an input newly named there needs the trees armed again.
    const modulesRenamed = treeArms && modulesNamed(next.inputs) !== modulesNamed(inputs)
    inputs = next.inputs
    uncached = next.uncached
    namedIgnored = next.namedIgnored
    claimedRootFiles = next.claimedRootFiles
    extraFiles = next.extraFiles
    configImportFiles = next.configImports
    wsConfigImportFiles = next.workspaceConfigImports
    armAncestors()
    isIgnoredPath = makeWatchIgnore(cacheDir, outputs, inputs, atArm?.tracked)
    fenced = makeFence(next.fenceDirs)
    matters = makeRootEventFilter(
      workspaceRoot,
      projectDirs,
      workspaceInputs,
      claimedRootFiles,
      fenced,
    )
    if (next.workspaceWide !== workspaceWide || modulesRenamed) {
      // A task started or stopped declaring `workspaceFiles`: the other
      // arm's shape. Until item 891 the choice was made once, at start, and
      // a root file a config newly named was never an event.
      dropMode()
      workspaceWide = next.workspaceWide
      armMode(next.projects)
    } else if (workspaceWide) wide = next.projects
    else {
      streamed = oneStream ? toStream(next.projects) : []
      const inStream = new Set(streamed.map((s) => s.proj))
      const own = next.projects.filter((p) => !inStream.has(p))
      const keep = new Set(own.map((p) => p.dir))
      for (const [dir, handle] of perProject) {
        if (keep.has(dir) && !stale(dir)) continue
        handle.close()
        perProject.delete(dir)
      }
      for (const proj of own) if (!perProject.has(proj.dir)) armProject(proj)
    }
    armImports()
    watched = next.projects
    links = gitFiles(workspaceRoot)?.links ?? links
    armLinks()
    armExtras()
    // A new arm proves delivery like the first ones: an edit in the new
    // project right after this cycle is seen, not lost in the gap.
    await pool.proved()
    if (say) sayArmed(next.projects.length)
    return undefined
  }

  armMode(projects)

  // A project directory, or one a config imports from, removed and made
  // again (`rm -rf packages && git checkout packages`) is no event to its
  // own watch (it holds the deleted directory) nor to the root arm, which
  // drops every name but its own files: silence until a restart. So each
  // is watched from its nearest directory that exists, for the next name
  // on the way down: its parent while it is there, an ancestor when the
  // parent went too (`apps/` removed under `apps/web/site`). Every
  // directory above it up to the root is watched for the next name too:
  // FSEvents reports nothing for a watched directory's children when the
  // directory itself goes with them, so on macOS the parent's arm alone
  // never heard `packages/` removed under `packages/a` (inotify did).
  const ancestorArms = new Map<string, WatchHandle>()
  let ancestorNames = new Map<string, Set<string>>()
  const ancestorEvent = (dir: string, filename: string): void => {
    // A project's parent's `.gitignore` shapes what its keys read, as the root's does.
    if (!ancestorNames.get(dir)?.has(filename) && filename !== '.gitignore') return
    const abs = path.join(dir, filename)
    // A project directory still the one its arm holds is no change:
    // its arm judges what is in it. macOS reports the directory's
    // mtime here on every write at its top level, and a cycle's own
    // write started the next (solid's `types`, 2026-10-15).
    if (heldDirs.get(abs) === (inodeOf(abs) ?? '')) return
    reread = true
    trigger(path.relative(workspaceRoot, abs), abs)
  }
  /** Each project directory below the root as these arms first saw it (`inodeOf`). */
  let heldDirs = new Map<string, string>()
  const armAncestors = (): void => {
    ancestorNames = new Map()
    const rootDir = path.resolve(workspaceRoot)
    const below = projectDirs.filter((d) => path.resolve(d) !== rootDir)
    heldDirs = new Map(
      below.flatMap((d) => {
        const id = inodeOf(d)
        return id === undefined ? [] : [[d, id]]
      }),
    )
    for (const base of [...below, ...importNames.keys()]) {
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
    streamedAncestors = new Set([...ancestorNames.keys()].filter(inStream))
    for (const [dir, handle] of ancestorArms) {
      if (ancestorNames.has(dir) && !streamedAncestors.has(dir) && !stale(dir)) continue
      handle.close()
      ancestorArms.delete(dir)
    }
    for (const dir of ancestorNames.keys()) {
      if (ancestorArms.has(dir) || streamedAncestors.has(dir)) continue
      try {
        ancestorArms.set(
          dir,
          arm(dir, false, (filename) => ancestorEvent(dir, filename)),
        )
        armedAs.set(dir, inodeOf(dir) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${dir}`, err)
      }
    }
  }
  armAncestors()
  armImports()
  armLinks()
  armExtras()
  armExclude()

  // The orchestrator's own writes never kick the loop: `makeWatchIgnore`
  // closes over the RESOLVED cache dir (relocated or not) and the tasks'
  // declared outputs.

  // "watching" is a promise that an edit from now on is seen; every
  // watcher has proved (or been given 2 s to prove) delivery first.
  await pool.proved()
  if (args.initial !== undefined) {
    current = args.initial.cycle
    args.initial.onWaiting = interruptIfWaiting
    inFlight = runCycle(undefined, args.initial)
    interruptIfWaiting()
  }

  lastTasks = args.tasks()
  sayWatching(projects.length)
  sayArmed(projects.length)
  // An edit made while the initial run ran landed before any watcher, and
  // its mtime predates the arm, so no event or judgement can find it.
  // Unheard, watch idled over output built from the old bytes. One to a
  // task the run was running, the run's own re-check found (it left the
  // task unsaved); any other is heard here.
  const heard = heardSinceRun()
  if (args.drifted !== undefined && !heard)
    void cycle(`${args.drifted} inputs, edited during the first run`)

  /**
   * The files written since the initial run started, by none of its
   * commands, an event each, judged as changes. Only a file git finds
   * untracked or modified can be one, and `atArm` asked git once already,
   * so a start with no edit adds `-m`'s stats and nothing else. An edit
   * made before its task keyed it re-runs to a hit.
   */
  function heardSinceRun(): boolean {
    let heard = false
    for (const abs of atArm?.dirty ?? []) {
      let t: number
      try {
        const st = fs.lstatSync(abs)
        if (Math.max(st.mtimeMs, st.ctimeMs) < args.initialRun.from) continue
        t = st.ctimeMs
      } catch {
        // Gone: a deletion has no date, and one made before the start would run every start.
        continue
      }
      if (
        args.initialRun.windows.writerDuring('', abs, t, t + racyWindowMs(t, FILE_HASH_RACY_MS)) !==
        undefined
      )
        continue
      const rel = path.relative(workspaceRoot, abs)
      if (workspaceWide) wideEvent(rel)
      else {
        if (!rel.includes(path.sep)) rootFileEvent(rel)
        else if (rel.startsWith(`.vx${path.sep}`) && !rel.slice(4).includes(path.sep))
          dotVxEvent(rel.slice(4))
        for (const proj of watched)
          if (abs.startsWith(proj.dir + path.sep)) projectEvent(proj, path.relative(proj.dir, abs))
      }
      if (!changes.pending.has(abs)) continue
      changes.unseen([abs])
      heard = true
    }
    return heard
  }

  return await new Promise<void>((resolve) => {
    const cleanup = async (): Promise<void> => {
      pool.closeAll()
      if (debounceTimer) clearTimeout(debounceTimer)
      if (interruptTimer) clearTimeout(interruptTimer)
      // The aborted cycle is tearing its children down; resolve only once
      // it has returned, so the process never exits over a live child.
      await inFlight
      await held?.stop(forwardedSignal(stop.reason))
      resolve()
    }
    if (stop.aborted) {
      void cleanup()
      return
    }
    stop.addEventListener('abort', () => void cleanup(), { once: true })
  })
}

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
 * The event a finished cycle hands back to the timer, if any.
 *
 * The inner loop re-runs while anything is pending, so this covers only the
 * narrow gap between its LAST judgement and the loop going idle: an event
 * landing there would otherwise sit in `changes.pending` with no timer armed
 * and no cycle to notice it — watch quietly idle over an edit the user
 * made. Insertion order, because the map is "first label wins" and the
 * label is what the cycle announces.
 *
 * A branch, not a race: extracted so it can be pinned at all. Deleting the
 * arming left every green test in the repo green (2026-09-20) — the e2e
 * watch fixture spawns a real `vx watch`, so it cannot deliver an event at
 * that instant, and the suites that could are the ones this repo's cloud
 * container already fails for timing reasons. What this pins is the
 * decision; the delivery window is the process's own.
 */
export function pendingAfterCycle(
  pending: ReadonlyMap<string, string>,
  aborted: boolean,
): [abs: string, label: string] | undefined {
  if (aborted || pending.size === 0) return undefined
  const [abs, label] = [...pending][0]!
  return [abs, label]
}
