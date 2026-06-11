// Shared setup for `run()` and `planRun()`. Both entry points perform
// the same workspace-discovery → config-load → graph-build → cache-
// open sequence; this module centralises it so the two callers stay
// thin.
//
// The caller owns the returned `cache.close()` lifetime: `run()`
// closes at the bottom of execution, `planRun()` does so via
// try/finally around its plan() call.

import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { Cache, type CacheLayer, GitFilesCache, populateGitFilesCache } from '../cache/index.js'
import {
  buildPackageGraph,
  computeNestedProjectDirs,
  computeWorkspaceFingerprint,
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  loadWorkspaceConfig,
  resolveCacheDir,
  type ProjectEntry,
} from '../workspace/index.js'
import { buildTaskGraph, expandRequested, type TaskNode } from '../graph/index.js'
import { wrapWithRemoteCache } from './remote-cache-setup.js'
import { createHashCache, type HashCache } from './task-hash.js'
import type { Logger } from './logger.js'
import type { RunOptions } from './options.js'

export interface PreparedRun {
  workspaceRoot: string
  workspaceConfig: WorkspaceConfig | null
  cacheDir: string
  cache: CacheLayer
  nodes: Map<string, TaskNode>
  workspaceFingerprint: string
  nestedDirsByProject: Map<string, string[]>
  /**
   * Per-run memo for `git ls-files` output, keyed by project dir.
   * Without this, every task in a project re-spawns git just to
   * enumerate its input file set (3× per project for build / test /
   * lint, etc.) — observable in cache-hit run times.
   */
  gitFilesCache: GitFilesCache
  /**
   * Per-run memo for derived hashes — project package.json bytes
   * keyed by projectDir, task-config hash keyed by config object
   * identity. Shared across every task's `computeTaskHash` call so
   * the same project's package.json (and the same task config
   * object) aren't re-hashed on every task in that project.
   */
  hashCache: HashCache
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
export async function prepareRun(options: RunOptions, log: Logger): Promise<PreparedRun> {
  const workspaceRoot = await findWorkspaceRoot(options.cwd)
  const workspace = await loadWorkspace(workspaceRoot)
  const workspaceConfig = await loadWorkspaceConfig(workspaceRoot)
  const projectMetas = await listProjects(workspace)

  // Load every project's `vx.config.*` in parallel. Each load is a
  // `jiti`/Bun import call; bunched across 100 projects this is the
  // biggest single overhead in startup.
  const projects = new Map<string, ProjectEntry>()
  const projectsWithConfigs = projectMetas.filter(
    (m): m is typeof m & { configPath: string } =>
      typeof m.configPath === 'string' && m.configPath.length > 0,
  )
  const configs = await Promise.all(projectsWithConfigs.map((m) => loadProjectConfig(m.configPath)))
  for (let i = 0; i < projectsWithConfigs.length; i++) {
    const meta = projectsWithConfigs[i]!
    const config = configs[i] as ProjectConfig
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
  const cache = wrapWithRemoteCache(localCache, log)
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspaceRoot)

  const gitFilesCache = new GitFilesCache()
  // Bulk-populate via a single `git ls-files` at the workspace root —
  // partitions the output by project. Avoids one fork+exec per project
  // (~5-10ms each on Linux; the dominant cold-start cost on big
  // monorepos).
  populateGitFilesCache(
    workspaceRoot,
    [...projects.values()].map((p) => p.dir),
    gitFilesCache,
  )
  const hashCache = createHashCache()

  // Empty-cases bookkeeping. We still construct the cache + fingerprint
  // so the caller's try/finally pattern can close it uniformly.
  if (requested.length === 0) {
    return {
      workspaceRoot,
      workspaceConfig,
      cacheDir,
      cache,
      nodes: new Map(),
      workspaceFingerprint,
      nestedDirsByProject,
      gitFilesCache,
      hashCache,
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

  return {
    workspaceRoot,
    workspaceConfig,
    cacheDir,
    cache,
    nodes,
    workspaceFingerprint,
    nestedDirsByProject,
    gitFilesCache,
    hashCache,
    empty: nodes.size === 0 ? 'empty-graph' : null,
  }
}
