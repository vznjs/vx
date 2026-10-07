// `vx watch <task>` — re-run on file changes.
//
// Initial run uses the same orchestrator path as `vx run`. After it
// finishes, set up recursive filesystem watchers on every project's
// directory in the resolved scope. Filesystem changes trigger a
// debounced re-invocation of the orchestrator with the same options.
//
// The cache does the heavy lifting: re-runs are typically cache hits
// (input hash matches), so spurious events from edits outside any
// task's `cache.inputs.files` cost ~tens of ms of orchestrator
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
import {
  findWorkspaceRoot,
  type LoadReads,
  loadWorkspace,
  LOCKFILE_NAME,
  memberBaseDirs,
  type ProjectMeta,
} from '../workspace/index.js'
import { type CliLoadOptions, discoverCliProjects, loadCliWorkspace } from './workspace-config.js'
import {
  isIgnoredWatchPath,
  isWorkspaceConfigFile,
  gitFiles,
  isWorkspaceFingerprintFile,
  makeFence,
  makeRootEventFilter,
  makeWatchIgnore,
  shapesWatchedSet,
} from './watch-filter.js'
import { CLOSED, fsClockNow, type WatchHandle, WatcherPool } from './watch-fs.js'
import { ChangeJudge } from './watch-judge.js'
import { restartTimings } from '../util/index.js'
import { memberEntries, sameMembers, sweepConfigs, watchedProjects } from './watch-set.js'

/** One line for a watcher or re-read the OS refused; the loop goes on without it. */
function sayCannot(what: string, err: unknown): void {
  process.stderr.write(`vx watch: ${what}: ${err instanceof Error ? err.message : String(err)}\n`)
}

/** Wait this long after the last filesystem event before re-running. */
const DEBOUNCE_MS = 150

/**
 * The run flags a watch loop cannot honour, as the refusal line it prints; null
 * when there is none. `WATCH_REFUSED_FLAGS` (help.ts) is the same list for
 * the help line and the completions, and a test holds the two together.
 */
export function watchRefusal(parsed: RunArgs): string | null {
  if (parsed.dry !== undefined || parsed.graph !== undefined) {
    return 'vx watch: --dry / --graph are not supported in watch mode'
  }
  if (parsed.summarize !== undefined || parsed.profile !== undefined) {
    return 'vx watch: --summarize / --profile are not supported in watch mode (would overwrite per cycle)'
  }
  // All three format ONE run's result and are consumed by `runCmd` alone, so
  // a watch loop silently ignored them. `--verbosity 0` is not rejected: it
  // asks for the output watch already gives.
  if (parsed.report !== undefined || parsed.reportFile !== undefined || parsed.verbosity > 0) {
    return 'vx watch: --report / --report-file / --verbosity are not supported in watch mode (they report a single run)'
  }
  return null
}

export async function watchCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args, 'watch')
  if (parsed.error) {
    process.stderr.write(`vx watch: ${parsed.error}\n`)
    return 1
  }

  const refused = watchRefusal(parsed)
  if (refused !== null) {
    process.stderr.write(`${refused}\n`)
    return 1
  }
  if (parsed.tasks.length === 0) {
    process.stderr.write(
      `vx watch: missing task name (vx watch <task>, e.g. vx watch build)${seeHelp('watch')}\n`,
    )
    return 1
  }

  const cwd = process.cwd()
  const resolved = await resolveRunOptions(parsed, cwd, parsed.tasks)
  if ('error' in resolved) {
    process.stderr.write(`vx watch: ${resolved.error}\n`)
    return 1
  }
  if ('nothingSelected' in resolved) {
    process.stderr.write(`vx watch: ${resolved.nothingSelected}\n`)
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
  process.once('SIGINT', () => {
    process.stdout.write('\nvx watch: stopped\n')
    stop.abort('SIGINT')
  })
  process.once('SIGTERM', () => stop.abort('SIGTERM'))
  // A task runs in its own session (exec/kill-tree.ts): the terminal
  // closing reaches the loop alone, and the loop passes it on.
  process.once('SIGHUP', () => stop.abort('SIGHUP'))

  // Enumerate projects-in-scope so we know what dirs to watch: the bare
  // tasks' scope (`opts.projects`; undefined means "every project", or
  // nothing when every task is anchored) and each `pkg#task`'s own
  // project, which no scope reaches. The watched set is what a cycle can
  // RUN: the scope plus its transitive dependencies (a cycle runs
  // `lib#build` for `app#build`'s `^build`, so a `lib` edit is an edit) — the same
  // closure `--filter 'app...'` walks, computed below once the initial
  // run has staged the configs. Plus the workspace root, for lockfile
  // changes.
  const reads: LoadReads = new Map()
  const workspaceRoot = await findWorkspaceRoot(cwd, reads)
  const workspace = await loadWorkspace(workspaceRoot, reads)
  const allProjects = await discoverCliProjects(workspace)
  const anchored = opts.tasks.filter((t) => t.includes('#')).map((t) => t.slice(0, t.indexOf('#')))
  const named =
    anchored.length === opts.tasks.length
      ? new Set(anchored)
      : opts.projects === undefined
        ? undefined
        : new Set([...opts.projects, ...anchored])
  const inScope = (all: readonly ProjectMeta[]): ProjectMeta[] =>
    named === undefined ? [...all] : all.filter((p) => named.has(p.name))
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
  // closing it properly needs the workspaceWide decision made without loading
  // configs.
  process.stdout.write('vx watch: initial run...\n\n')
  // A run that throws (a config that does not parse) is a failed cycle, as
  // it is once the loop runs: watch keeps watching, so the fix re-runs.
  // Uncaught, it ended watch at start while the same break mid-watch did
  // not (item 1017).
  let held: HeldPersistent | undefined
  let refusedToStart = false
  try {
    const initial = await runOrchestrator(opts)
    held = initial.persistent
    if (initial.refused !== undefined) process.stderr.write(`vx watch: ${initial.refused}\n`)
    // A run that failed having run nothing refused to start: a requested
    // name no project declares (run() says which, with a "did you mean").
    // `vx run` exits 1 on it; `vx watch buidl` watched on, re-running the
    // same refusal on every change, since no edit to an input can declare
    // a task. A name only the diff left out (`--affected`) is `ok` and
    // keeps watching.
    refusedToStart = !initial.ok && initial.outcomes.length === 0
  } catch (err) {
    process.stderr.write(
      `vx watch: cycle failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
  if (stop.signal.aborted) {
    await held?.stop(forwardedSignal(stop.signal.reason))
    return 0
  }
  if (refusedToStart) return 1
  // After the initial run, so a `pkg#task` naming no project gets the
  // run's own refusal and its "did you mean".
  if (scope.length === 0) {
    await held?.stop()
    process.stderr.write(`vx watch: no projects in scope\n`)
    return 1
  }
  // `--affected`'s diff is the tree at start; judged again, it held every
  // later edit out of the scope it picked. A cycle is an edit, and the
  // cache keys decide what in the scope it re-runs.
  delete opts.affected
  delete opts.selectedOutright

  const load: CliLoadOptions = {
    ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
    ...(opts.frozen === true ? { frozen: true } : {}),
  }
  const swept = await sweepConfigs(allProjects, workspaceRoot, load, opts.tasks)
  const watched = await watchedProjects(workspaceRoot, allProjects, scope, load, swept.staged)
  const ws = await loadCliWorkspace(workspaceRoot)
  const claimsOf = (plugins: Parameters<typeof fingerprintClaims>[0]): Set<string> =>
    new Set([
      ...fingerprintClaims(plugins).keys(),
      ...(opts.frozen === true ? [LOCKFILE_NAME] : []),
    ])
  return await runWatchLoop({
    opts,
    held,
    stop: stop.signal,
    workspaceRoot,
    projects: watched,
    workspaceWide: swept.workspaceWide,
    projectDirs: watched.map((p) => p.dir),
    workspaceInputs: swept.workspaceInputs,
    outputs: swept.outputs,
    inputs: swept.inputs,
    uncached: swept.uncached,
    configImports: swept.configImports,
    workspaceConfigImports: swept.workspaceConfigImports,
    memberBases: memberBaseDirs(workspace),
    packageDirs: new Set(allProjects.map((p) => p.dir)),
    fenceDirs: fenceDirs(allProjects),
    // The workspace as the cycle that just ran saw it: a package added or
    // removed since the loop armed joins or leaves the watched set. The
    // scope is the one resolved at start; a new package joins it only as a
    // dependency of it.
    rediscover: async () => {
      const workspace = await loadWorkspace(workspaceRoot)
      const all = await discoverCliProjects(workspace)
      const sweep = await sweepConfigs(all, workspaceRoot, load, opts.tasks)
      const now = await watchedProjects(workspaceRoot, all, inScope(all), load, sweep.staged)
      return {
        projects: now,
        // A plugin the workspace config gained since claims its file from
        // the cycle that loaded it; read once, its edits started nothing
        // until a restart.
        claimedRootFiles: claimsOf((await loadCliWorkspace(workspaceRoot)).plugins),
        memberBases: memberBaseDirs(workspace),
        workspaceWide: sweep.workspaceWide,
        workspaceInputs: sweep.workspaceInputs,
        outputs: sweep.outputs,
        inputs: sweep.inputs,
        uncached: sweep.uncached,
        configImports: sweep.configImports,
        workspaceConfigImports: sweep.workspaceConfigImports,
        packageDirs: new Set(all.map((p) => p.dir)),
        fenceDirs: fenceDirs(all),
      }
    },
    // Under --frozen every cycle's configs are the lock's, so a re-lock is
    // the one edit that changes what a cycle runs; unheard, the loop ran
    // the old lock until a restart (item 971).
    claimedRootFiles: claimsOf(ws.plugins),
    // The RESOLVED cache dir, not the `.vx` literal — see `makeWatchIgnore`.
    cacheDir: opts.cacheDir ?? ws.cacheDir,
  })
}

interface WatchLoopArgs {
  opts: RunOptions
  /** The persistent tasks the initial run left running; the next cycle stops them before it starts. */
  held: HeldPersistent | undefined
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
  /** The directory each `<dir>/*` package glob names at start; a member coming or going there is a cycle. */
  memberBases: readonly string[]
  /** Every package's directory, in scope or not: a member base's other entries are packages still to come. */
  packageDirs: ReadonlySet<string>
  /** Every project, in scope or not: a project's key leaves out what lies in one nested under it. */
  fenceDirs: readonly string[]
  /** The watched set again, after a cycle that followed an event which can change it. */
  rediscover: () => Promise<Rediscovered>
}

const fenceDirs = (all: readonly ProjectMeta[]): string[] => all.map((p) => p.dir)

interface Rediscovered {
  projects: readonly ProjectMeta[]
  claimedRootFiles: ReadonlySet<string>
  memberBases: readonly string[]
  workspaceWide: boolean
  workspaceInputs: readonly string[]
  outputs: ReadonlyMap<string, readonly string[]>
  inputs: ReadonlyMap<string, ReadonlyArray<readonly string[]>>
  uncached: ReadonlySet<string>
  configImports: readonly string[]
  workspaceConfigImports: readonly string[]
  packageDirs: ReadonlySet<string>
  fenceDirs: readonly string[]
}

async function runWatchLoop(args: WatchLoopArgs): Promise<number> {
  const { opts, stop, workspaceRoot, projects, cacheDir } = args
  // The watched set as of the last cycle: `rearm` replaces these after an
  // event that can change it, and every filter below reads the current one.
  let workspaceWide = args.workspaceWide
  let packageDirs = args.packageDirs
  let memberBases = args.memberBases
  let projectDirs = args.projectDirs
  let workspaceInputs = args.workspaceInputs
  let outputs = args.outputs
  let inputs = args.inputs
  let uncached = args.uncached
  let claimedRootFiles = args.claimedRootFiles
  let configImportFiles = args.configImports
  let wsConfigImportFiles = args.workspaceConfigImports
  // A dev server stays up while the loop idles; the cycle that replaces it
  // stops it first, so the new one never meets the old one's port.
  let held = args.held

  // Reentrancy guard — never two orchestrator runs in flight. Events that
  // land while one is running wait in `changes.pending` and are judged, on
  // settled bytes, one debounce window after it ends.
  let running = false
  /** The cycle in flight, so the stop path can wait for its teardown before resolving. */
  let inFlight: Promise<void> = Promise.resolve()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const trigger = (label: string, abs: string): void => {
    if (!changes.pending.has(abs)) changes.pending.set(abs, label)
    if (running) return
    if (debounceTimer) clearTimeout(debounceTimer)
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
  const runCycle = async (first: string): Promise<void> => {
    try {
      let label: string | undefined = first
      while (label !== undefined && !stop.aborted) {
        process.stdout.write(`\nvx watch: ${label}; re-running...\n\n`)
        try {
          await held?.stop()
          held = undefined
          restartTimings()
          const start = Date.now()
          const cycle = await runOrchestrator(opts)
          held = cycle.persistent
          if (cycle.refused !== undefined) process.stderr.write(`vx watch: ${cycle.refused}\n`)
          changes.lastCycle = { start, end: Date.now() }
          if (reread && !stop.aborted) {
            reread = false
            await rearm()
          }
        } catch (err) {
          // A re-run can fail catastrophically when the workspace
          // itself moved out from under us — e.g. the user deleted
          // the project dir, or git lost its repo (the watch loop
          // outlives its own cwd in test teardown). Surface the
          // message but DON'T let it crash the watch loop; the next
          // FS event (if any) will retry. The dispose() on SIGINT
          // is the canonical exit; we don't unilaterally abort here.
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`vx watch: cycle failed: ${message}\n`)
        }
        // What landed mid-run is judged on settled state, one window
        // after the run, under the label of what actually arrived.
        if (changes.pending.size === 0 || stop.aborted) break
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
  let isIgnoredPath = makeWatchIgnore(cacheDir, outputs, inputs)
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
  const pool = new WatcherPool((dir, rel) => isIgnoredPath(dir, rel))
  const arm = (dir: string, recursive: boolean, onEvent: (filename: string) => void): WatchHandle =>
    pool.arm(dir, recursive, onEvent)

  /** The instant the watchers go live, on the mtime clock (see `fsClockNow`): a path last modified before it is the initial run's, not an edit. */
  const armedAt = fsClockNow(cacheDir)
  /** What existed at the arm, so a file born and gone since is no deletion (watch-judge.ts). */
  const existedAtArm = gitFiles(workspaceRoot)
  /** Which settled paths are changes (watch-judge.ts); `pending` holds what fired since. */
  const changes = new ChangeJudge({
    workspaceRoot,
    armedAt,
    held: () => held !== undefined,
    uncached: () => uncached,
    fenced: (ownDir, abs) => fenced(ownDir, abs),
    ...(existedAtArm !== undefined ? { existedAtArm } : {}),
  })
  /** Per-project arms by directory, so `rearm` can add and drop them. */
  const perProject = new Map<string, WatchHandle>()
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
  /** The root arm: recursive when workspace-wide, else the root's own files only. */
  let rootArm: WatchHandle = CLOSED
  const armProject = (proj: ProjectMeta): void => {
    try {
      const handle = arm(proj.dir, true, (filename) => {
        const abs = path.join(proj.dir, filename)
        if (isIgnoredPath(proj.dir, filename) || fenced(proj.dir, abs)) return
        // A module the config imports from inside the project is the config
        // too: its edit can add an output or a `workspaceFiles` input.
        if (shapesWatchedSet(filename) || configImportFiles.includes(abs)) reread = true
        trigger(`${proj.name} ${filename}`, abs)
      })
      perProject.set(proj.dir, handle)
      armedAs.set(proj.dir, inodeOf(proj.dir) ?? '')
    } catch (err) {
      sayCannot(`cannot watch ${proj.dir}`, err)
    }
  }
  const armRoot = (): void => {
    try {
      rootArm = workspaceWide
        ? // workspaceFiles inputs in play: a root-relative glob can name a
          // file anywhere, so one recursive root watcher replaces the
          // per-project ones (it also covers lockfile / pnpm-workspace.yaml
          // edits). `matters` keeps the events a key can see — project
          // trees, root fingerprint files, the declared globs — and drops
          // the rest of the tree; the ignore filter then keeps node_modules
          // / .git / .vx and declared outputs out of what remains.
          arm(workspaceRoot, true, (filename) => {
            if (!matters(filename) || isIgnoredPath(workspaceRoot, filename)) return
            const abs = path.join(workspaceRoot, filename)
            if (
              shapesWatchedSet(filename) ||
              filename === LOCKFILE_NAME ||
              configImportFiles.includes(abs)
            )
              reread = true
            trigger(`root ${filename}`, abs)
          })
        : // The root itself, non-recursive, beside the per-project arms, so
          // lockfile + pnpm-workspace.yaml edits trigger re-runs even when
          // no project dir saw the change.
          arm(workspaceRoot, false, (filename) => {
            if (
              isWorkspaceFingerprintFile(filename) ||
              isWorkspaceConfigFile(filename) ||
              filename === 'package.json' ||
              claimedRootFiles.has(filename)
            ) {
              if (shapesWatchedSet(filename) || filename === LOCKFILE_NAME) reread = true
              trigger(`root ${filename}`, path.join(workspaceRoot, filename))
            }
          })
    } catch (err) {
      sayCannot(`cannot watch workspace root`, err)
    }
  }
  // One recursive watcher per project, unless workspace-wide: each project
  // owns its own subtree; the root is never watched recursively for them
  // (it would cover every project + node_modules + caches).
  const armMode = (watched: readonly ProjectMeta[]): void => {
    if (!workspaceWide) for (const proj of watched) armProject(proj)
    armRoot()
  }
  const dropMode = (): void => {
    for (const handle of perProject.values()) handle.close()
    perProject.clear()
    rootArm.close()
    rootArm = CLOSED
  }

  /**
   * A directory under a member base with no package in it yet. The base's
   * own watcher is not recursive, so the `package.json` that makes it a
   * package is an event only here; an editor or `git checkout` that makes
   * the directory first and the manifest after left the package unwatched
   * for good (item 891). On a rearm a new entry is armed before its
   * manifest is checked, so one that landed after the re-read is an event
   * or is seen by the check. At start there is no re-read to race, and a
   * manifest already there is a directory the globs exclude.
   */
  const pending = new Map<string, WatchHandle>()
  const armPending = (afterReread: boolean): void => {
    const want = new Set<string>()
    for (const base of memberBases)
      for (const name of memberEntries(base)) {
        const dir = path.join(base, name)
        if (!packageDirs.has(dir)) want.add(dir)
      }
    for (const [dir, handle] of pending) {
      if (want.has(dir) && !stale(dir)) continue
      handle.close()
      pending.delete(dir)
    }
    for (const dir of want) {
      if (pending.has(dir)) continue
      const manifest = path.join(dir, 'package.json')
      const arrived = (): void => {
        reread = true
        trigger(path.relative(workspaceRoot, manifest), manifest)
      }
      try {
        pending.set(
          dir,
          arm(dir, false, (filename) => {
            if (filename === 'package.json') arrived()
          }),
        )
        armedAs.set(dir, inodeOf(dir) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${dir}`, err)
        continue
      }
      if (afterReread && fs.existsSync(manifest)) arrived()
    }
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

  const watchingLine = (count: number): string =>
    workspaceWide
      ? 'vx watch: watching the workspace root (workspaceFiles inputs in use)'
      : `vx watch: watching ${count} project(s)`

  const rearm = async (): Promise<void> => {
    let next: Rediscovered
    try {
      next = await args.rediscover()
    } catch (err) {
      sayCannot(`cannot re-read the workspace`, err)
      return
    }
    projectDirs = next.projects.map((p) => p.dir)
    workspaceInputs = next.workspaceInputs
    outputs = next.outputs
    inputs = next.inputs
    uncached = next.uncached
    claimedRootFiles = next.claimedRootFiles
    configImportFiles = next.configImports
    wsConfigImportFiles = next.workspaceConfigImports
    packageDirs = next.packageDirs
    memberBases = next.memberBases
    armBases()
    isIgnoredPath = makeWatchIgnore(cacheDir, outputs, inputs)
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
      const keep = new Set(projectDirs)
      for (const [dir, handle] of perProject) {
        if (keep.has(dir) && !stale(dir)) continue
        handle.close()
        perProject.delete(dir)
      }
      for (const proj of next.projects) if (!perProject.has(proj.dir)) armProject(proj)
    }
    armPending(true)
    armImports()
    // A new arm proves delivery like the first ones: an edit in the new
    // package right after this cycle is seen, not lost in the gap.
    await pool.proved()
    process.stdout.write(`${watchingLine(next.projects.length)}\n`)
  }

  armMode(projects)

  // A package added while the loop runs is a directory entry appearing
  // under the glob's directory (`packages/` for `packages/*`); one
  // non-recursive watcher there hears it come or go, and the cycle it
  // triggers re-reads the workspace (`rearm`) so the new package's own
  // edits are cycles from then on. Until 2026-09-10 the watched set was
  // fixed when the loop armed: the next cycle ran the new package, and
  // every edit inside it after that was silence. The bases themselves are
  // re-read with the set: a glob added to the list watched nothing new
  // until a restart (item 1018).
  const baseArms = new Map<string, WatchHandle>()
  // A base removed and made again is no event to its own watch (it holds
  // the deleted directory) nor to the root arm, which drops every name but
  // its own files: `watching 0 project(s)` and silence until a restart. So
  // each base, and each directory a config imports from, is watched from
  // its nearest directory that exists, for the next name on the way down:
  // its parent while it is there, an ancestor when the parent went too
  // (`apps/` removed under `apps/web/*`).
  const ancestorArms = new Map<string, WatchHandle>()
  let ancestorNames = new Map<string, Set<string>>()
  const armAncestors = (): void => {
    ancestorNames = new Map()
    for (const base of [...memberBases, ...importNames.keys()]) {
      let dir = path.dirname(base)
      let name = path.basename(base)
      while (inodeOf(dir) === undefined && dir !== workspaceRoot && dir !== path.dirname(dir)) {
        name = path.basename(dir)
        dir = path.dirname(dir)
      }
      ancestorNames.set(dir, (ancestorNames.get(dir) ?? new Set()).add(name))
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
            if (!ancestorNames.get(dir)?.has(filename)) return
            reread = true
            const abs = path.join(dir, filename)
            trigger(path.relative(workspaceRoot, abs), abs)
          }),
        )
        armedAs.set(dir, inodeOf(dir) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${dir}`, err)
      }
    }
  }
  const armBases = (): void => {
    armAncestors()
    const want = new Set(memberBases)
    for (const [base, handle] of baseArms) {
      if (want.has(base) && !stale(base)) continue
      handle.close()
      baseArms.delete(base)
    }
    for (const base of want) {
      if (baseArms.has(base)) continue
      // Gone for now: its parent's arm hears it come back.
      if (inodeOf(base) === undefined) continue
      let members = memberEntries(base)
      try {
        baseArms.set(
          base,
          arm(base, false, (filename) => {
            if (isIgnoredWatchPath(filename)) return
            // Only a member coming or going. On macOS a non-recursive watcher
            // also reports a member whose CONTENTS changed (FSEvents names the
            // directory a write landed in), so a task writing into its own
            // project — or the arm's own probe file — read as a member event
            // and cost an uncached task one execution per cycle (CI,
            // 2026-09-10).
            const now = memberEntries(base)
            // The same names, but a directory still without a package made
            // again (or replaced by a rename): its pending watch holds the
            // deleted one, and the `package.json` that lands next is heard
            // only by a new arm.
            const entry = path.join(base, filename)
            if (sameMembers(members, now) && !(pending.has(entry) && stale(entry))) return
            members = now
            reread = true
            trigger(`${path.relative(workspaceRoot, base)}/${filename}`, path.join(base, filename))
          }),
        )
        armedAs.set(base, inodeOf(base) ?? '')
      } catch (err) {
        sayCannot(`cannot watch ${base}`, err)
      }
    }
  }
  armBases()
  armPending(false)
  armImports()

  // The orchestrator's own writes never kick the loop: `makeWatchIgnore`
  // closes over the RESOLVED cache dir (relocated or not) and the tasks'
  // declared outputs.

  // "watching" is a promise that an edit from now on is seen; every
  // watcher has proved (or been given 2 s to prove) delivery first.
  await pool.proved()

  process.stdout.write(`\n${watchingLine(projects.length)}; press Ctrl+C to stop\n`)

  return await new Promise<number>((resolve) => {
    const cleanup = async (): Promise<void> => {
      pool.closeAll()
      if (debounceTimer) clearTimeout(debounceTimer)
      // The aborted cycle is tearing its children down; resolve only once
      // it has returned, so the process never exits over a live child.
      await inFlight
      await held?.stop(forwardedSignal(stop.reason))
      resolve(0)
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
