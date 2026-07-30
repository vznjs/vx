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
import { parseRunArgs, resolveRunOptions } from './run.js'
import { run as runOrchestrator, type RunOptions } from '../orchestrator/index.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  WORKSPACE_FINGERPRINT_FILES,
  type ProjectMeta,
} from '../workspace/index.js'

/** Wait this long after the last filesystem event before re-running. */
const DEBOUNCE_MS = 150

/** Paths whose changes never trigger a re-run. */
const IGNORED_SEGMENTS = ['node_modules', '.git', '.vx']
const IGNORED_SUFFIXES = ['.tsbuildinfo', '~']

/**
 * True for a path the ignore filter drops. Every project dir is watched
 * RECURSIVELY, so without this a `bun install` would re-run the graph on every
 * file it writes, and vx's own `.vx/cache` writes would trigger a cycle that
 * writes to `.vx/cache` again.
 *
 * Segment-wise, not prefix-wise: `node_modules` is ignored wherever it appears
 * in the path, not only at the root.
 */
export function isIgnoredWatchPath(rel: string): boolean {
  const segments = rel.split(path.sep)
  if (segments.some((s) => IGNORED_SEGMENTS.includes(s))) return true
  if (IGNORED_SUFFIXES.some((suf) => rel.endsWith(suf))) return true
  return false
}

export async function watchCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx watch: ${parsed.error}\n`)
    return 1
  }

  if (parsed.dry !== undefined || parsed.graph !== undefined) {
    process.stderr.write(`vx watch: --dry / --graph are not supported in watch mode\n`)
    return 1
  }
  if (parsed.summarize !== undefined || parsed.profile !== undefined) {
    process.stderr.write(
      `vx watch: --summarize / --profile are not supported in watch mode (would overwrite per cycle)\n`,
    )
    return 1
  }
  // All three format ONE run's result and are consumed by `runCmd` alone, so
  // a watch loop silently ignored them. `--verbosity 0` is not rejected: it
  // asks for the output watch already gives.
  if (parsed.report !== undefined || parsed.reportFile !== undefined || parsed.verbosity > 0) {
    process.stderr.write(
      `vx watch: --report / --report-file / --verbosity are not supported in watch mode (they report a single run)\n`,
    )
    return 1
  }
  if (parsed.tasks.length === 0) {
    process.stderr.write(`vx watch: missing task name\n`)
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
  // The watch loop owns SIGINT/SIGTERM for its whole lifetime (the
  // process.once handlers below close watchers and resolve 0). A
  // cycle's run() must not install its exit-the-process handlers —
  // Ctrl-C mid-cycle would kill the loop with 130 instead of the
  // loop's own clean shutdown.
  const opts: RunOptions = { ...resolved, handleSignals: false }

  // Enumerate projects-in-scope so we know what dirs to watch.
  // `opts.projects` is the resolved scope; undefined means "every
  // project". We watch only those (plus the workspace root, for
  // lockfile changes).
  const workspaceRoot = await findWorkspaceRoot(cwd)
  const allProjects = await listProjects(await loadWorkspace(workspaceRoot))
  const scope =
    opts.projects === undefined
      ? allProjects
      : allProjects.filter((p) => opts.projects!.includes(p.name))

  if (scope.length === 0) {
    process.stderr.write(`vx watch: no projects in scope\n`)
    return 1
  }

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
  await runOrchestrator(opts)

  return await runWatchLoop({
    opts,
    workspaceRoot,
    projects: scope,
    workspaceWide: await anyTaskUsesWorkspaceFiles(allProjects),
  })
}

/**
 * `inputs.workspaceFiles` globs have no project boundary — any file in
 * the workspace can be an input. When any config declares them, the
 * per-project watchers can't see all triggering paths, so the loop
 * switches to one recursive root watcher. Checked across ALL projects
 * (not just the scope) because dependsOn can pull tasks from anywhere;
 * a broken out-of-scope config is skipped, matching scoped-run
 * semantics (it surfaces when that project enters scope).
 */
async function anyTaskUsesWorkspaceFiles(projects: readonly ProjectMeta[]): Promise<boolean> {
  // Concurrent, not sequential: the run that just happened already
  // loaded the in-scope configs, so these are REPEAT loads that
  // re-evaluate in a worker. Issuing them together lets one worker
  // serve the whole sweep instead of one per project.
  const uses = await Promise.all(
    projects.map(async (p): Promise<boolean> => {
      if (p.configPath === null) return false
      try {
        const config = await loadProjectConfig(p.configPath)
        return Object.values(config.tasks ?? {}).some(
          (task) => (task.cache?.inputs?.workspaceFiles?.length ?? 0) > 0,
        )
      } catch {
        // broken config — out of this concern's scope
        return false
      }
    }),
  )
  return uses.includes(true)
}

interface WatchLoopArgs {
  opts: RunOptions
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  workspaceWide: boolean
}

async function runWatchLoop(args: WatchLoopArgs): Promise<number> {
  const { opts, workspaceRoot, projects, workspaceWide } = args

  // Reentrancy guard — never two orchestrator runs in flight. While
  // one is running, any further events set `pending = true` and the
  // loop drains it after the current run finishes.
  let running = false
  let pending = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const trigger = (label: string): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void cycle(label)
    }, DEBOUNCE_MS)
  }

  const cycle = async (label: string): Promise<void> => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      do {
        pending = false
        process.stdout.write(`\nvx watch: ${label}; re-running...\n\n`)
        try {
          await runOrchestrator(opts)
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
        // If a change arrived mid-run, loop again immediately.
      } while (pending)
    } finally {
      running = false
    }
  }

  // Filter out events for paths we don't care about. We watch each
  // project's dir recursively, so a `node_modules` write under a
  // project would otherwise trigger every save during `bun install`.
  const isIgnoredPath = isIgnoredWatchPath

  const watchers: fs.FSWatcher[] = []

  if (workspaceWide) {
    // workspaceFiles inputs in play: any file in the workspace can be
    // an input, so one recursive root watcher replaces the per-project
    // ones (it also covers lockfile / pnpm-workspace.yaml edits). The
    // ignore filter keeps node_modules / .git / .vx churn out; edits
    // outside any task's inputs still cost only a cache-hit cycle.
    try {
      const w = fs.watch(
        workspaceRoot,
        { recursive: true, persistent: true },
        (_event, filename) => {
          if (filename == null || typeof filename !== 'string') return
          if (isIgnoredPath(filename)) return
          trigger(`root ${filename}`)
        },
      )
      watchers.push(w)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx watch: cannot watch workspace root: ${msg}\n`)
    }
  } else {
    // One recursive watcher per project. Each project owns its own
    // subtree; we don't watch the workspace root recursively (would
    // cover every project + node_modules + caches).
    for (const proj of projects) {
      try {
        const w = fs.watch(proj.dir, { recursive: true, persistent: true }, (_event, filename) => {
          if (filename == null) return
          if (typeof filename !== 'string') return
          if (isIgnoredPath(filename)) return
          trigger(`${proj.name} ${filename}`)
        })
        watchers.push(w)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`vx watch: cannot watch ${proj.dir}: ${msg}\n`)
      }
    }

    // Plus the workspace root itself (non-recursive) so lockfile +
    // pnpm-workspace.yaml edits trigger re-runs even when no project
    // dir saw the change.
    try {
      const w = fs.watch(
        workspaceRoot,
        { recursive: false, persistent: true },
        (_event, filename) => {
          if (filename == null || typeof filename !== 'string') return
          if (isWorkspaceFingerprintFile(filename)) trigger(`root ${filename}`)
        },
      )
      watchers.push(w)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx watch: cannot watch workspace root: ${msg}\n`)
    }
  }

  // The orchestrator's writes into `.vx/cache/` don't trigger
  // re-runs because IGNORED_SEGMENTS includes `.vx`. Users who
  // relocate the cache dir outside `.vx/` need their own filtering.

  process.stdout.write(
    workspaceWide
      ? `\nvx watch: watching the workspace root (workspaceFiles inputs in use); press Ctrl+C to stop\n`
      : `\nvx watch: watching ${projects.length} project(s); press Ctrl+C to stop\n`,
  )

  return await new Promise<number>((resolve) => {
    const cleanup = (): void => {
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // ignore
        }
      }
      if (debounceTimer) clearTimeout(debounceTimer)
      resolve(0)
    }
    process.once('SIGINT', () => {
      process.stdout.write('\nvx watch: stopped\n')
      cleanup()
    })
    process.once('SIGTERM', cleanup)
  })
}

/**
 * True for a root file that re-keys EVERY task, so a change to one must trigger
 * a cycle even though it lives in no project dir.
 *
 * Reads the SHARED constant the fingerprint itself walks — this used to be a
 * third hand-rolled copy of that list, which is precisely the drift the
 * `--affected` wave exported the constant to prevent. A name added there but
 * not here would re-key every task while `vx watch` silently never re-ran on
 * it: the loop looks alive, and the one edit that invalidates the whole
 * workspace is the one it ignores.
 */
const FINGERPRINT_FILES: ReadonlySet<string> = new Set(WORKSPACE_FINGERPRINT_FILES)

function isWorkspaceFingerprintFile(name: string): boolean {
  return FINGERPRINT_FILES.has(name)
}
