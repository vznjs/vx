// `vx watch <task>` — re-run on file changes.
//
// Initial run uses the same orchestrator path as `vx run`. After it
// finishes, set up recursive filesystem watchers on every project's
// directory in the resolved scope. Filesystem changes trigger a
// debounced re-invocation of the orchestrator with the same options.
//
// The cache does the heavy lifting: re-runs are typically cache hits
// (input hash matches), so spurious events from edits outside any
// task's `inputs.files` cost ~tens of ms of orchestrator
// overhead. We deliberately don't try to filter events through the
// per-task input globs — the cache key is the source of truth, and
// filtering would mean re-doing the glob/boundary work on every event.

import fs from 'node:fs'
import path from 'node:path'
import { parseRunArgs, resolveRunOptions, type RunArgs } from './run.js'
import { seeHelp } from './help.js'
import {
  fingerprintClaims,
  forwardedSignal,
  run as runOrchestrator,
  type HeldPersistent,
  type RunOptions,
  shellQuote,
} from '../orchestrator/index.js'
import { findWorkspaceRoot, LOCKFILE_NAME, NO_LOCK, type ProjectMeta } from '../workspace/index.js'
import { type CliLoadOptions, discoverCliProjects, loadCliWorkspace } from './workspace-config.js'
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
import { CLOSED, fsClockNow, type WatchHandle, WatcherPool } from './watch-fs.js'
import { ChangeJudge } from './watch-judge.js'
import { type WatchCycle, watchCycle } from './watch-cycle.js'
import { hangupIgnored, maskedLine, restartTimings, sayNotice, sayLine } from '../util/index.js'
import { sweepConfigs, watchedProjects } from './watch-set.js'
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
function sayAllCached(opts: RunOptions, outcomes: readonly { status: string }[]): void {
  if (outcomes.length === 0 || !outcomes.every((o) => isCacheHit(o.status))) return
  const mode = resolveOutputView(opts).mode
  if (mode !== 'broad' && mode !== 'errors-only' && mode !== 'none') return
  const n = outcomes.length
  process.stdout.write(` ${n === 1 ? '1 task' : `${n} tasks`} cached, nothing ran\n`)
}

/** Wait this long after the last filesystem event before re-running. */
const DEBOUNCE_MS = 150
/**
 * ...but no longer than this after the first: a writer that never pauses
 * for a window (a dev server logging into its project every 50 ms) reset
 * the timer forever, and an edit made meanwhile never ran.
 */
const DEBOUNCE_MAX_MS = 1_000

/**
 * The run flags a watch loop cannot honour, as the refusal line it prints; null
 * when there is none. `WATCH_REFUSED_FLAGS` (help.ts) is the same list for
 * the help line and the completions, and a test holds the two together.
 */
export function watchRefusal(parsed: RunArgs): string | null {
  if (parsed.dry !== undefined) {
    return 'vx watch: --dry is not supported in watch mode'
  }
  if (parsed.profile !== undefined) {
    return 'vx watch: --profile is not supported in watch mode (would overwrite per cycle)'
  }
  // It formats ONE run's result and is consumed by `runCmd` alone, so a
  // watch loop silently ignored it. `--verbosity 0` is not rejected: it
  // asks for the output watch already gives.
  if (parsed.verbosity > 0) {
    return 'vx watch: --verbosity is not supported in watch mode (it reports a single run)'
  }
  return null
}

export async function watchCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args, 'watch')
  if (parsed.error) {
    sayNotice('error', 'vx watch', `${parsed.error}${seeHelp('watch')}`)
    return 1
  }

  const refused = watchRefusal(parsed)
  if (refused !== null) {
    sayLine('error', refused, 'vx watch')
    return 1
  }
  if (parsed.tasks.length === 0) {
    sayNotice(
      'error',
      'vx watch',
      `missing task name (vx watch <task>, e.g. vx watch build)${seeHelp('watch')}`,
    )
    return 1
  }

  const cwd = process.cwd()
  const resolved = await resolveRunOptions(parsed, cwd, parsed.tasks, 'watch')
  if ('error' in resolved) {
    sayNotice('error', 'vx watch', resolved.error)
    return 1
  }
  if ('nothingSelected' in resolved) {
    sayNotice('info', 'vx watch', resolved.nothingSelected)
    return 0
  }
  // The watch loop owns SIGINT/SIGTERM for its whole lifetime. A cycle's
  // run() must not install its exit-the-process handlers — Ctrl-C
  // mid-cycle would kill the loop with 130 instead of the loop's own
  // clean shutdown — so it gets `signal` instead: on SIGINT/SIGTERM the
  // controller aborts with the signal's name as the reason, the in-flight
  // cycle forwards it to its children (a SIGINT as SIGINT, the rest as
  // SIGTERM; grace, SIGKILL) and returns, and the loop resolves 0.
  // Installed BEFORE the initial run: until 2026-09-10 the handlers went
  // in with the loop, so a SIGTERM during the initial run took Bun's
  // default (exit 143) and left the cycle's children running under init.
  const stop = new AbortController()
  const opts: RunOptions = {
    ...resolved,
    handleSignals: false,
    signal: stop.signal,
    holdPersistent: true,
  }
  // Every cycle's `invocations` row names the verb, as `vx run`'s does;
  // run()'s process.argv fallback put the bin's absolute path there, so
  // `vx last --list` showed `$ /…/bin.ts watch build` beside `$ vx run build`.
  opts.command = ['vx', 'watch', ...args.map(shellQuote)].join(' ')
  // A staged load and a discovery from the selection pass are one run's
  // worth; every cycle after an edit must load and list live.
  delete opts.staged
  delete opts.discovered
  process.once('SIGINT', () => stop.abort('SIGINT'))
  // Said once the loop is down, the last line: written as the signal
  // landed, the aborted cycle's summary printed below it.
  const stopped = (): number => {
    if (stop.signal.reason === 'SIGINT') process.stdout.write('\nvx watch: stopped\n')
    return 0
  }
  process.once('SIGTERM', () => stop.abort('SIGTERM'))
  // A task runs in its own session (exec/kill-tree.ts): the terminal
  // closing reaches the loop alone, and the loop passes it on — unless vx
  // was started with it ignored (nohup).
  if (!hangupIgnored()) process.once('SIGHUP', () => stop.abort('SIGHUP'))

  // Enumerate projects-in-scope so we know what dirs to watch: the bare
  // tasks' scope (`opts.projects`; undefined means "every project", or
  // nothing when every task is anchored) and each `pkg#task`'s own
  // project, which no scope reaches. The watched set is what a cycle can
  // RUN: the scope plus its transitive dependencies (a cycle runs
  // `lib#build` for `app#build`'s `^build`, so a `lib` edit is an edit) — the same
  // closure `--filter 'app...'` walks, computed below once the initial
  // run has staged the configs. Plus the workspace root, for lockfile
  // changes.
  const workspaceRoot = await findWorkspaceRoot(cwd)
  // No lock yet is no project yet: the first cycle fails saying so, and
  // the lock `vx lock` writes is the event that arms the set.
  let unlocked = false
  const allProjects = await discoverCliProjects(workspaceRoot).catch((err: unknown) => {
    if (!(err instanceof Error) || err.message !== NO_LOCK) throw err
    unlocked = true
    return []
  })
  const anchored = opts.tasks.filter((t) => t.includes('#')).map((t) => t.slice(0, t.indexOf('#')))
  const named =
    anchored.length === opts.tasks.length
      ? new Set(anchored)
      : opts.projects === undefined
        ? undefined
        : new Set([...opts.projects, ...anchored])
  // `//#check` is the root project's task, under the name the run gives
  // it (prepare.ts, D-39): taken literally, no project was in scope and
  // the watch exited 1 after a green run. Resolved per discovery: started
  // with no lock, the root has no name until `vx lock` writes one.
  const rootDir = path.resolve(workspaceRoot)
  const inScope = (all: readonly ProjectMeta[]): ProjectMeta[] =>
    named === undefined
      ? [...all]
      : all.filter((p) => named.has(p.name) || (named.has('//') && path.resolve(p.dir) === rootDir))
  const scope = inScope(allProjects)

  // Initial run — same code path as `vx run`.
  //
  // Watchers do not exist yet, so an edit made WHILE this run is executing is
  // dropped by the OS and never triggers a re-run. Known and deliberate: the
  // obvious fix (install watchers first) forces `anyTaskUsesWorkspaceFiles`
  // ahead of the run to decide which watchers to install, and that marks every
  // config loaded — so the initial run's own loads become REPEATs and pay a
  // worker round-trip each (see config-eval.ts). Trading a hot-path regression
  // on every `vx watch` for a window a user rarely edits into is a bad deal;
  // configs.
  // The exception: once the run waits on a server's readiness alone, every
  // config is loaded, and the loop arms with the run as its cycle in
  // flight. Unarmed, a server that never got ready held the initial run
  // for good, and the fix to it was never heard (X-139).
  let loop: Promise<void> | undefined
  const initial: InitialCycle = {
    cycle: watchCycle(opts, stop.signal, () => {
      if (initial.onWaiting !== undefined) initial.onWaiting()
      else if (loop === undefined && (scope.length > 0 || unlocked) && !stop.signal.aborted)
        loop = armLoop(initial)
    }),
    held: Promise.resolve(undefined),
  }
  const openingTasks = (): number | undefined => initial.cycle.tasks
  // A run that throws (a config that does not parse) is a failed cycle, as
  // it is once the loop runs: watch keeps watching, so the fix re-runs.
  // Uncaught, it ended watch at start while the same break mid-watch did
  // not (item 1017).
  let refusedToStart = false
  initial.held = runOrchestrator(initial.cycle.opts).then(
    (run) => {
      if (run.refused !== undefined) sayNotice('error', 'vx watch', run.refused)
      sayAllCached(opts, run.outcomes)
      // A run that failed having run nothing refused to start: a requested
      // name no project declares (run() says which, with a "did you mean").
      // `vx run` exits 1 on it; `vx watch buidl` watched on, re-running the
      // same refusal on every change, since no edit to an input can declare
      // a task. A name only the diff left out (`--affected`) is `ok` and
      // keeps watching.
      refusedToStart = !run.ok && run.outcomes.length === 0
      return run.persistent
    },
    (err: unknown) => {
      sayNotice(
        'error',
        'vx watch',
        `cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    },
  )
  const held = await initial.held
  if (loop !== undefined) {
    await loop
    return stopped()
  }
  if (stop.signal.aborted) {
    await held?.stop(forwardedSignal(stop.signal.reason))
    return stopped()
  }
  if (refusedToStart) return 1
  // After the initial run, so a `pkg#task` naming no project gets the
  // run's own refusal and its "did you mean".
  if (scope.length === 0 && !unlocked) {
    await held?.stop()
    sayNotice('error', 'vx watch', 'no projects in scope')
    return 1
  }
  await armLoop(undefined, held)
  return stopped()

  async function armLoop(initial?: InitialCycle, held?: HeldPersistent): Promise<void> {
    // `--affected`'s diff is the tree at start; judged again, it held every
    // later edit out of the scope it picked. A cycle is an edit, and the
    // cache keys decide what in the scope it re-runs.
    delete opts.affected
    delete opts.selectedOutright

    const load: CliLoadOptions = opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}
    const swept = await sweepConfigs(allProjects, workspaceRoot, load, opts.tasks)
    const watched = await watchedProjects(workspaceRoot, allProjects, scope, load, swept.staged)
    const ws = await loadCliWorkspace(workspaceRoot)
    const claimsOf = (plugins: Parameters<typeof fingerprintClaims>[0]): Set<string> =>
      new Set([...fingerprintClaims(plugins).keys(), LOCKFILE_NAME])
    await runWatchLoop({
      opts,
      held,
      initial,
      tasks: openingTasks,
      stop: stop.signal,
      workspaceRoot,
      projects: watched,
      workspaceWide: swept.workspaceWide,
      projectDirs: watched.map((p) => p.dir),
      workspaceInputs: swept.workspaceInputs,
      outputs: swept.outputs,
      inputs: swept.inputs,
      uncached: swept.uncached,
      namedIgnored: swept.namedIgnored,
      configImports: swept.configImports,
      workspaceConfigImports: swept.workspaceConfigImports,
      fenceDirs: fenceDirs(allProjects),
      // The workspace as the cycle that just ran saw it: a project the lock
      // gained or lost since the loop armed joins or leaves the watched
      // set. The scope is the one resolved at start; a new project joins
      // it only as a dependency of it.
      rediscover: async () => {
        const all = await discoverCliProjects(workspaceRoot)
        const sweep = await sweepConfigs(all, workspaceRoot, load, opts.tasks)
        const now = await watchedProjects(workspaceRoot, all, inScope(all), load, sweep.staged)
        return {
          projects: now,
          // A plugin the workspace config gained since claims its file from
          // the cycle that loaded it; read once, its edits started nothing
          // until a restart.
          claimedRootFiles: claimsOf((await loadCliWorkspace(workspaceRoot)).plugins),
          workspaceWide: sweep.workspaceWide,
          workspaceInputs: sweep.workspaceInputs,
          outputs: sweep.outputs,
          inputs: sweep.inputs,
          uncached: sweep.uncached,
          namedIgnored: sweep.namedIgnored,
          configImports: sweep.configImports,
          workspaceConfigImports: sweep.workspaceConfigImports,
          fenceDirs: fenceDirs(all),
        }
      },
      // Every cycle's configs are the lock's, so a re-lock is
      // the one edit that changes what a cycle runs; unheard, the loop ran
      // the old lock until a restart (item 971).
      claimedRootFiles: claimsOf(ws.plugins),
      // The RESOLVED cache dir, not the `.vx` literal — see `makeWatchIgnore`.
      cacheDir: opts.cacheDir ?? ws.cacheDir,
      poll: resolveSetting('watch.poll', ws.workspaceConfig, parsed.poll).value === true,
    })
  }
}

/** The initial run, when the loop arms while it is still in flight. */
interface InitialCycle {
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
  /** The initial run's task count, once it has started. */
  tasks: () => number | undefined
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
  /** Every project, in scope or not: a project's key leaves out what lies in one nested under it. */
  fenceDirs: readonly string[]
  /** The watched set again, after a cycle that followed an event which can change it. */
  rediscover: () => Promise<Rediscovered>
  /** `watch.poll`: poll from the start instead of the OS watcher. */
  poll: boolean
}

const fenceDirs = (all: readonly ProjectMeta[]): string[] => all.map((p) => p.dir)

interface Rediscovered {
  projects: readonly ProjectMeta[]
  claimedRootFiles: ReadonlySet<string>
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

async function runWatchLoop(args: WatchLoopArgs): Promise<void> {
  const { opts, stop, workspaceRoot, projects, cacheDir } = args
  // The watched set as of the last cycle: `rearm` replaces these after an
  // event that can change it, and every filter below reads the current one.
  let workspaceWide = args.workspaceWide
  let projectDirs = args.projectDirs
  let workspaceInputs = args.workspaceInputs
  let outputs = args.outputs
  let inputs = args.inputs
  let uncached = args.uncached
  let namedIgnored = args.namedIgnored
  let claimedRootFiles = args.claimedRootFiles
  let configImportFiles = args.configImports
  let wsConfigImportFiles = args.workspaceConfigImports
  // A dev server stays up while the loop idles and across cycles; a cycle
  // that must restart it (its config changed, it died) stops it before its
  // graph, so the new one never meets the old one's port.
  let held = args.held

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
      interruptedBy = label
      c.interrupt()
    }, DEBOUNCE_MS)
  }
  let windowOpened = 0

  const lockAbs = path.join(workspaceRoot, LOCKFILE_NAME)
  const lockStamp = (): string => {
    try {
      const st = fs.statSync(lockAbs)
      return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
    } catch {
      return ''
    }
  }
  /** The lock as the last cycle found it: a config edit with no re-lock since changes no command. */
  let lockSeen = lockStamp()
  // Every cycle's configs are the lock's, so a config edit alone ran a cycle
  // that printed `changed` and nothing else, read as the edit applied. A
  // config gone is the run's own refusal to name.
  const sayUnlocked = (paths: readonly string[]): void => {
    for (const abs of paths)
      if ((isProjectConfigFile(abs) || configImportFiles.includes(abs)) && fs.existsSync(abs))
        sayNotice(
          'warn',
          'vx watch',
          `${path.relative(workspaceRoot, abs)} changed; runs read the lock, so run \`vx lock\` to apply it`,
        )
  }
  const trigger = (label: string, abs: string): void => {
    if (!changes.pending.has(abs)) changes.pending.set(abs, label)
    if (running) return interruptIfWaiting()
    if (debounceTimer) {
      if (Date.now() - windowOpened >= DEBOUNCE_MAX_MS) return
      clearTimeout(debounceTimer)
    } else windowOpened = Date.now()
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
      let lockAtRun = ''
      // The initial run is collected even after a stop: its server is the
      // loop's to stop.
      while (initial !== undefined || (label !== undefined && !stop.aborted)) {
        if (initial !== undefined) {
          held = await initial.held
          initial = undefined
        } else
          try {
            // A member came or went: armed before the run keys it, an edit in a
            // new package while its first cycle runs queues like any other; armed
            // only after, it fell in the gap and ran nothing (X-138). The re-read
            // after the run stays, for what the run itself changed.
            lockAtRun = lockStamp()
            const relocked = lockAtRun !== lockSeen
            lockSeen = lockAtRun
            if (reread) await rearm(false)
            process.stdout.write(`\nchanged ${label}\n`)
            if (!relocked) sayUnlocked(changes.changed)
            if (stop.aborted) break
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
              { ...opts, ...(before ? { keep: before } : {}) },
              stop,
              interruptIfWaiting,
            )
            const cycle = await runOrchestrator(current.opts)
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
            const message = maskedLine(err instanceof Error ? err.message : String(err))
            sayNotice('error', 'vx watch', `cycle failed: ${message}`)
          } finally {
            // A re-lock since this cycle began: the re-arm below can
            // close the watcher its event was still on its way to (FSEvents'
            // latency, a poller's tick), and the new lock ran nothing until
            // the next edit (macOS CI, 2026-10-23). A cycle that read the
            // lock mid-write failed on it, and is the same case.
            if (lockStamp() !== lockAtRun) rootFileEvent(LOCKFILE_NAME)
          }
        // After a failed cycle too: a package added with a config that does
        // not load yet fails its cycle, and unarmed, the fix to that config
        // was never an event.
        if (reread && !stop.aborted) {
          reread = false
          await rearm()
        }
        // What landed mid-run is judged on settled state, one window
        // after the run, under the label of what actually arrived.
        current = undefined
        if (stop.aborted) break
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
  const atArm = gitFiles(workspaceRoot)
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
  const pool = new WatcherPool((dir, rel) => isIgnoredPath(dir, rel), args.poll)
  const arm = (dir: string, recursive: boolean, onEvent: (filename: string) => void): WatchHandle =>
    pool.arm(dir, recursive, onEvent)

  /** The instant the watchers go live, on the mtime clock (see `fsClockNow`): a path last modified before it is the initial run's, not an edit. */
  const armedAt = fsClockNow(cacheDir)
  /** Which settled paths are changes (watch-judge.ts); `pending` holds what fired since. */
  const changes = new ChangeJudge({
    workspaceRoot,
    armedAt,
    held: () => held !== undefined,
    uncached: () => uncached,
    namedIgnored: () => namedIgnored,
    fenced: (ownDir, abs) => fenced(ownDir, abs),
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
    const rel = filename.split(path.sep).join('/')
    if (!rel.includes('/')) rootFileEvent(rel)
    else if (rel.startsWith('.vx/') && rel.indexOf('/', 4) < 0) dotVxEvent(rel.slice(4))
    const abs = path.join(realRoot, filename)
    for (const { proj, real } of streamed) {
      if (abs.startsWith(real + path.sep)) projectEvent(proj, path.relative(real, abs))
    }
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
            if (!matters(filename) || isIgnoredPath(workspaceRoot, filename)) return
            const abs = path.join(workspaceRoot, filename)
            if (
              shapesWatchedSet(filename) ||
              filename === LOCKFILE_NAME ||
              claimedRootFiles.has(filename) ||
              configImportFiles.includes(abs)
            )
              reread = true
            const owner = ownerOf(abs)
            trigger(
              owner === undefined
                ? `root ${filename}`
                : `${owner.name} ${path.relative(owner.dir, abs)}`,
              abs,
            )
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
    for (const [dir, handle] of importArms) {
      if (want.has(dir) && !stale(dir)) continue
      handle.close()
      importArms.delete(dir)
    }
    for (const dir of want.keys()) {
      if (importArms.has(dir)) continue
      // Gone for now: its ancestor's arm (`armAncestors`) hears it return.
      if (inodeOf(dir) === undefined) continue
      try {
        importArms.set(
          dir,
          arm(dir, false, (filename) => {
            if (!(importNames.get(dir)?.has(filename) ?? false)) return
            const abs = path.join(dir, filename)
            const rel = path.relative(workspaceRoot, abs)
            if (configImportFiles.includes(abs)) {
              reread = true
              trigger(`config import ${rel}`, abs)
              return
            }
            // One line per save, not per event: a save is often two.
            const now = Date.now()
            if (now - (staleNamed.get(abs) ?? 0) < 1_000) return
            staleNamed.set(abs, now)
            process.stdout.write(
              `vx watch: ${rel} changed; the workspace config imports it, and this process loaded it at start — restart vx watch to apply the edit\n`,
            )
          }),
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
  let watched = projects
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

  // Said once, when the loop first arms: a re-arm repeated it after every
  // cycle that re-read the watched set, between task rows. `debug.watch`
  // says each arm on stderr, for whoever needs to see the set change.
  let lastTasks: number | undefined
  const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  const sayWatching = (count: number): void => {
    const tasks = lastTasks === undefined ? '' : ` · ${plural(lastTasks, 'task')}`
    process.stdout.write(`watching ${plural(count, 'project')}${tasks}\n`)
  }
  const debugArms = resolveSetting('debug.watch', undefined).value === true
  const sayArmed = (count: number): void => {
    if (debugArms) process.stderr.write(`vx watch: armed ${plural(count, 'project')}\n`)
  }

  const rearm = async (say = true): Promise<void> => {
    let next: Rediscovered
    try {
      next = await args.rediscover()
    } catch (err) {
      // No lock is the cycle's own failure to say; said here too, it was two lines.
      if (!(err instanceof Error && err.message === NO_LOCK))
        sayCannot(`cannot re-read the workspace`, err)
      return
    }
    projectDirs = next.projects.map((p) => p.dir)
    workspaceInputs = next.workspaceInputs
    outputs = next.outputs
    inputs = next.inputs
    uncached = next.uncached
    namedIgnored = next.namedIgnored
    claimedRootFiles = next.claimedRootFiles
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
    if (next.workspaceWide !== workspaceWide) {
      // A task started or stopped declaring `workspaceFiles`: the other
      // arm's shape. Until item 891 the choice was made once, at start, and
      // a root file a config newly named was never an event.
      dropMode()
      workspaceWide = next.workspaceWide
      armMode(next.projects)
    } else if (!workspaceWide) {
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
    // A new arm proves delivery like the first ones: an edit in the new
    // project right after this cycle is seen, not lost in the gap.
    await pool.proved()
    if (say) sayArmed(next.projects.length)
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
    for (const [dir, handle] of ancestorArms) {
      if (ancestorNames.has(dir) && !stale(dir)) continue
      handle.close()
      ancestorArms.delete(dir)
    }
    for (const dir of ancestorNames.keys()) {
      if (ancestorArms.has(dir)) continue
      try {
        ancestorArms.set(
          dir,
          arm(dir, false, (filename) => {
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
          }),
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
