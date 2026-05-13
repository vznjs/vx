// Shared setup for `run()` and `planRun()`. Both entry points perform
// the same workspace-discovery → config-load → graph-build → cache-
// open sequence; this module centralises it so the two callers stay
// thin.
//
// The caller owns the returned `cache.close()` lifetime: `run()`
// closes at the bottom of execution, `planRun()` does so via
// try/finally around its plan() call.

import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { Cache, type CacheLayer } from '../cache/cache.js'
import { buildPackageGraph, type PackageGraph } from '../workspace/package-graph.js'
import { loadProjectConfig, loadWorkspaceConfig } from '../workspace/project-loader.js'
import {
  buildTaskGraph,
  expandRequested,
  type ProjectEntry,
  type TaskNode,
} from '../graph/task-graph.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  resolveCacheDir,
} from '../workspace/workspace.js'
import { computeNestedProjectDirs } from './nested-dirs.js'
import { computeWorkspaceFingerprint } from './fingerprint.js'
import { wrapWithRemoteCache } from './remote-cache-setup.js'
import type { Logger } from './logger.js'
import type { Observer, HistoryTable } from './observer.js'
import type { RunOptions } from '../orchestrator.js'

export interface PreparedRun {
  workspaceRoot: string
  workspaceConfig: WorkspaceConfig | null
  cacheDir: string
  cache: CacheLayer
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  nodes: Map<string, TaskNode>
  workspaceFingerprint: string
  nestedDirsByProject: Map<string, string[]>
  /**
   * Per-task historical aggregates pulled from the `runs` table. Cheap
   * (one batched SQL transaction) and useful to every downstream:
   * TUI progress bars / ETAs, `--summarize` JSON enrichment, future
   * `vx ui` historical browser. Empty map on the no-tasks paths so
   * consumers never have to null-check.
   */
  historyTable: HistoryTable
  /**
   * Reason `nodes` is empty. `null` when the prepared run is ready to
   * execute. Either:
   *   - `'no-tasks-declared'` — `requested.length === 0` after the
   *     user's task names were resolved against `projects`. Typically
   *     a typo'd task name; `run()` treats this as a CI footgun and
   *     returns NOT-ok.
   *   - `'empty-graph'`       — `requested` was non-empty but the
   *     graph builder still produced no nodes. Defensive; unreachable
   *     under current `buildTaskGraph` semantics.
   */
  empty: null | 'no-tasks-declared' | 'empty-graph'
}

/**
 * Build the prepared-run context: workspace discovery, project-config
 * load, package + task graph, cache handle (local, optionally wrapped
 * in a remote layer). Caller owns `cache.close()`.
 *
 * Returns even when nothing can run — the `empty` field tells the
 * caller why. We never throw on "no tasks"; behavior on that case is
 * caller-specific (run logs + returns NOT-ok; planRun returns an
 * empty plan).
 */
export async function prepareRun(
  options: RunOptions,
  log: Logger,
  // Threaded to the LayeredCache wrapper so remote-cache GETs/PUTs
  // emit `remoteCache` events as they happen. The TUI's RemoteCache
  // panel reads them directly; non-TUI runs ignore them.
  observer?: Observer,
): Promise<PreparedRun> {
  const workspaceRoot = await findWorkspaceRoot(options.cwd)
  const workspace = await loadWorkspace(workspaceRoot)
  const workspaceConfig = await loadWorkspaceConfig(workspaceRoot)
  const projectMetas = await listProjects(workspace)

  const projects = new Map<string, ProjectEntry>()
  for (const meta of projectMetas) {
    if (!meta.configPath) continue
    const config: ProjectConfig = await loadProjectConfig(meta.configPath)
    projects.set(meta.name, { name: meta.name, dir: meta.dir, config })
  }

  const packageGraph = buildPackageGraph(projectMetas)
  const nestedDirsByProject = computeNestedProjectDirs([...projects.values()])

  const candidateProjects = options.projects
    ? options.projects.filter((p) => projects.has(p))
    : [...projects.keys()]

  const requested = expandRequested(options.tasks, candidateProjects, projects)

  const cacheDir = resolveCacheDir(workspaceRoot, workspaceConfig)
  const localCache = new Cache(cacheDir)
  const cache = wrapWithRemoteCache(localCache, log, observer)
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspaceRoot)

  // Empty-cases bookkeeping. We still construct the cache + fingerprint
  // so the caller's try/finally pattern can close it uniformly.
  if (requested.length === 0) {
    return {
      workspaceRoot,
      workspaceConfig,
      cacheDir,
      cache,
      projects,
      packageGraph,
      nodes: new Map(),
      workspaceFingerprint,
      nestedDirsByProject,
      historyTable: new Map(),
      empty: 'no-tasks-declared',
    }
  }

  const nodes = buildTaskGraph({
    projects,
    packageGraph,
    requested,
    ...(options.excludeDependencies !== undefined
      ? { excludeDependencies: options.excludeDependencies }
      : {}),
  })

  // One batched SQL pass to populate ETA / progress / Bottlenecks data
  // for everything we're about to run. Cheap and safe to do here so
  // downstream consumers (TUI, --summarize) don't each re-query.
  const historyTable = cache.getTaskHistory([...nodes.keys()])

  return {
    workspaceRoot,
    workspaceConfig,
    cacheDir,
    cache,
    projects,
    packageGraph,
    nodes,
    workspaceFingerprint,
    nestedDirsByProject,
    historyTable,
    empty: nodes.size === 0 ? 'empty-graph' : null,
  }
}
