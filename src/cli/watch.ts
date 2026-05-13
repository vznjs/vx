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
import { run as runOrchestrator, type RunOptions } from '../orchestrator.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  resolveCacheDir,
  type ProjectMeta,
} from '../workspace/workspace.js'
import { loadWorkspaceConfig } from '../workspace/project-loader.js'

/** Wait this long after the last filesystem event before re-running. */
const DEBOUNCE_MS = 150

/** Paths whose changes never trigger a re-run. */
const IGNORED_SEGMENTS = ['node_modules', '.git', '.vx']
const IGNORED_SUFFIXES = ['.tsbuildinfo', '~']

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
  const opts = resolved

  // Enumerate projects-in-scope so we know what dirs to watch.
  // `opts.projects` is the resolved scope; undefined means "every
  // project". We watch only those (plus the workspace root, for
  // lockfile changes).
  const workspaceRoot = await findWorkspaceRoot(cwd)
  const workspaceConfig = await loadWorkspaceConfig(workspaceRoot)
  const cacheDir = resolveCacheDir(workspaceRoot, workspaceConfig)
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
  process.stdout.write('vx watch: initial run...\n\n')
  await runOrchestrator(opts)

  return await runWatchLoop({ opts, workspaceRoot, cacheDir, projects: scope })
}

interface WatchLoopArgs {
  opts: RunOptions
  workspaceRoot: string
  cacheDir: string
  projects: readonly ProjectMeta[]
}

async function runWatchLoop(args: WatchLoopArgs): Promise<number> {
  const { opts, workspaceRoot, cacheDir, projects } = args

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
        await runOrchestrator(opts)
        // If a change arrived mid-run, loop again immediately.
      } while (pending)
    } finally {
      running = false
    }
  }

  // Filter out events for paths we don't care about. We watch each
  // project's dir recursively, so a `node_modules` write under a
  // project would otherwise trigger every save during `bun install`.
  const isIgnoredPath = (rel: string): boolean => {
    const segments = rel.split(path.sep)
    if (segments.some((s) => IGNORED_SEGMENTS.includes(s))) return true
    if (IGNORED_SUFFIXES.some((suf) => rel.endsWith(suf))) return true
    return false
  }

  const watchers: fs.FSWatcher[] = []

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

  // Avoid the case where the cacheDir lives inside a project dir
  // (e.g. `<project>/.vx/cache/`): our own writes would trigger
  // an immediate cascade. We can't reliably ignore by path because
  // cacheDir is resolved at orchestrator level, so we just log and
  // hope IGNORED_SEGMENTS('.vx') covers it. The default config does
  // place cacheDir under `.vx/`, so the segment filter takes care of
  // it for now.
  void cacheDir

  process.stdout.write(`\nvx watch: watching ${projects.length} project(s); press Ctrl+C to stop\n`)

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

function isWorkspaceFingerprintFile(name: string): boolean {
  return (
    name === 'pnpm-lock.yaml' ||
    name === 'package-lock.json' ||
    name === 'npm-shrinkwrap.json' ||
    name === 'yarn.lock' ||
    name === 'bun.lock' ||
    name === 'bun.lockb' ||
    name === 'pnpm-workspace.yaml'
  )
}
