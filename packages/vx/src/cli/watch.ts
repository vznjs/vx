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

import path from 'node:path'
import { parseRunArgs, resolveRunOptions, type RunArgs, spacedHint } from './run.js'
import { refuse, seeHelp } from './help.js'
import { fsClockNow } from '../memo/index.js'
import {
  commandWindows,
  fingerprintClaims,
  forwardedSignal,
  runCore as runOrchestrator,
  type HeldPersistent,
  type CoreRunOptions,
  shellQuote,
} from '../orchestrator/index.js'
import { findWorkspaceRoot, LOCKFILE_NAME, NO_LOCK, type ProjectMeta } from '../workspace/index.js'
import { type CliLoadOptions, discoverCliProjects, loadCliWorkspace } from './workspace-config.js'
import { resolveSetting } from '../settings.js'
import { lockedExtras } from './watch-filter.js'
import { watchCycle } from './watch-cycle.js'
import { hangupIgnored } from '../util/index.js'
import * as ui from '../ui/index.js'
import { sayNotice } from '../ui/index.js'
import { sweepConfigs, watchedProjects } from './watch-set.js'
import {
  fenceDirs,
  type InitialCycle,
  type InitialRun,
  lockStamp,
  runWatchLoop,
  sayAllCached,
} from './watch-loop.js'

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
  if (parsed.error) return refuse('watch', args, `${parsed.error}${seeHelp('watch')}`, 'VX_E_USAGE')

  const refused = watchRefusal(parsed)
  if (refused !== null)
    return refuse(
      'watch',
      args,
      `${refused.replace(/^vx watch: /, '')}${seeHelp('watch')}`,
      'VX_E_USAGE',
    )
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
    const hint = resolved.code === 'VX_E_UNKNOWN_TASK' ? await spacedHint(parsed, cwd) : ''
    sayNotice('error', 'vx watch', `${resolved.error}${hint}`)
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
  // Installed BEFORE the initial run: with the loop, the handlers went
  // in too late, so a SIGTERM during the initial run took Bun's
  // default (exit 143) and left the cycle's children running under init.
  const stop = new AbortController()
  const opts: CoreRunOptions = {
    ...resolved,
    handleSignals: false,
    signal: stop.signal,
    // Its own: the deletes below and each cycle's additions stay off the resolved run's.
    handoff: { ...resolved.handoff, holdPersistent: true, watch: true },
  }
  // Every cycle's `invocations` row names the verb, as `vx run`'s does;
  // run()'s process.argv fallback put the bin's absolute path there, so
  // `vx last --list` showed `$ /…/bin.ts watch build` beside `$ vx run build`.
  opts.command = ['vx', 'watch', ...args.map(shellQuote)].join(' ')
  // A staged load and a discovery from the selection pass are one run's
  // worth; every cycle after an edit must load and list live.
  delete opts.handoff?.staged
  delete opts.handoff?.discovered
  // `on`, not `once`: a second signal during the teardown is absorbed (an
  // abort is once), where `once` left it to Bun's default, exit 130 with
  // the cycle's children mid-grace.
  process.on('SIGINT', () => stop.abort('SIGINT'))
  // Said once the loop is down, the last line: written as the signal
  // landed, the aborted cycle's summary printed below it.
  const stopped = (): number => {
    if (stop.signal.reason === 'SIGINT') {
      ui.print('out', ui.gap())
      ui.say('info', 'vx watch: stopped', 'out')
    }
    return 0
  }
  process.on('SIGTERM', () => stop.abort('SIGTERM'))
  // A task runs in its own session (exec/kill-tree.ts): the terminal
  // closing reaches the loop alone, and the loop passes it on — unless vx
  // was started with it ignored (nohup).
  if (!hangupIgnored()) process.on('SIGHUP', () => stop.abort('SIGHUP'))

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
  // The watch's own reads say no plugin warning: each cycle's run says it.
  const quiet = (): void => {}
  const stageLoad: CliLoadOptions = {
    warn: quiet,
    ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
  }
  const allProjects = await discoverCliProjects(workspaceRoot, stageLoad).catch((err: unknown) => {
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
  // it (prepare.ts): taken literally, no project was in scope and
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
  // Watchers do not exist yet, so the OS drops the event of an edit made WHILE
  // this run is executing. Known and deliberate: the obvious fix (install
  // watchers first) forces `anyTaskUsesWorkspaceFiles` ahead of the run to
  // decide which watchers to install, and that marks every config loaded — so
  // the initial run's own loads become REPEATs and pay a worker round-trip each
  // (see config-eval.ts). The edit is found instead: one to the inputs of a
  // task the run was running leaves that task unsaved, and the loop starts on
  // it (`drifted`); any other is a file the arm finds written since the run
  // started by none of its commands (`InitialRun`). The exception: once the run
  // waits on a server's readiness alone, every config is loaded, and the loop
  // arms with the run as its cycle in flight. Unarmed, a server that never got
  // ready held the initial run for good, and the fix to it was never heard.
  let loop: Promise<void> | undefined
  const initialRun: InitialRun = {
    from: fsClockNow(opts.cacheDir ?? path.join(workspaceRoot, '.vx')),
    windows: commandWindows(),
    lock: lockStamp(workspaceRoot),
  }
  const initial: InitialCycle = {
    cycle: watchCycle(
      { ...opts, handoff: { ...opts.handoff, commandWindows: initialRun.windows } },
      stop.signal,
      () => {
        if (initial.onWaiting !== undefined) initial.onWaiting()
        else if (loop === undefined && (scope.length > 0 || unlocked) && !stop.signal.aborted)
          loop = armLoop(initial)
      },
    ),
    held: Promise.resolve(undefined),
  }
  const openingTasks = (): number | undefined => initial.cycle.tasks
  // A run that throws (a config that does not parse) is a failed cycle, as
  // it is once the loop runs: watch keeps watching, so the fix re-runs.
  // Uncaught, it ended watch at start while the same break mid-watch did
  // not.
  let refusedToStart = false
  /** A task whose inputs the user edited while the initial run ran it: no watcher heard the edit. */
  let drifted: string | undefined
  initial.held = runOrchestrator(initial.cycle.opts).then(
    async (run) => {
      drifted = run.outcomes.find((o) => o.cache?.unkeyed === true)?.node.id
      if (run.refused !== undefined) {
        const hint = run.refused.startsWith('no projects declare')
          ? await spacedHint(parsed, cwd)
          : ''
        sayNotice('error', 'vx watch', `${run.refused}${hint}`)
      }
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
  await armLoop(undefined, held, drifted)
  return stopped()

  async function armLoop(
    initial?: InitialCycle,
    held?: HeldPersistent,
    drifted?: string,
  ): Promise<void> {
    // `--affected`'s diff is the tree at start; judged again, it held every
    // later edit out of the scope it picked. A cycle is an edit, and the
    // cache keys decide what in the scope it re-runs.
    delete opts.affected
    delete opts.handoff?.selectedOutright

    const load = stageLoad
    const swept = await sweepConfigs(allProjects, workspaceRoot, load, opts.tasks)
    const watched = await watchedProjects(workspaceRoot, allProjects, scope, load, swept.staged)
    const ws = await loadCliWorkspace(workspaceRoot, quiet)
    const claimsOf = (plugins: Parameters<typeof fingerprintClaims>[0]): Set<string> =>
      new Set([...fingerprintClaims(plugins).keys(), LOCKFILE_NAME])
    await runWatchLoop({
      opts,
      held,
      initial,
      initialRun,
      tasks: openingTasks,
      drifted,
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
        const all = await discoverCliProjects(workspaceRoot, load)
        const sweep = await sweepConfigs(all, workspaceRoot, load, opts.tasks)
        const now = await watchedProjects(workspaceRoot, all, inScope(all), load, sweep.staged)
        const wsNow = await loadCliWorkspace(workspaceRoot, quiet)
        return {
          projects: now,
          // A plugin the workspace config gained since claims its file from
          // the cycle that loaded it; read once, its edits started nothing
          // until a restart.
          claimedRootFiles: claimsOf(wsNow.plugins),
          // A re-lock that records a new `file:` directory or patch.
          extraFiles: lockedExtras(workspaceRoot),
          // The dir the cycle just wrote its store to: kept from the start,
          // a `cache.dir` edit let those writes start the next cycle.
          cacheDir: opts.cacheDir ?? wsNow.cacheDir,
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
      // the old lock until a restart.
      claimedRootFiles: claimsOf(ws.plugins),
      extraFiles: lockedExtras(workspaceRoot),
      // The RESOLVED cache dir, not the `.vx` literal — see `makeWatchIgnore`.
      cacheDir: opts.cacheDir ?? ws.cacheDir,
      poll: resolveSetting('watch.poll', ws.workspaceConfig, parsed.poll).value === true,
    })
  }
}
