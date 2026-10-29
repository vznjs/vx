// The workspace as every verb must see it: the config with the plugin
// `config` stage applied, and the cache dir derived from THAT. The stage
// is documented to shape `cacheDir`; a verb that read the file raw opened
// a directory the run never used — `vx last` found no runs, `vx cache
// prune` pruned nothing, `vx watch` ignored the wrong path.

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceConfig } from '../config.js'
import { UserError, sayLine } from '../util/index.js'
import {
  discoverProjects,
  loadProjects,
  loadWorkspacePlugins,
  lockOfDiscovery,
  lockReader,
} from '../orchestrator/index.js'
import type { BranchFacts, VxPlugin } from '../orchestrator/index.js'
import {
  buildPackageGraph,
  type ProjectEntry,
  type ProjectMeta,
  resolveCacheDir,
  resolveStoreRoot,
} from '../workspace/index.js'

interface CliWorkspace {
  workspaceConfig: WorkspaceConfig | null
  plugins: readonly VxPlugin[]
  /** What a plugin's `config` stage said of the branch: its cache scope and base commit. */
  branch: BranchFacts
  cacheDir: string
  /**
   * The shared store a run opens `cacheDir` with (`resolveStoreRoot`), asked
   * on first call: with no remote, the answer is a git spawn, and a verb that
   * never opens the store (help, show, last) paid it.
   */
  storeRoot: () => Promise<string | null>
}

export const warnToStderr = (message: string): void => {
  sayLine('warn', message)
}

export async function loadCliWorkspace(workspaceRoot: string): Promise<CliWorkspace> {
  const { workspaceConfig, plugins, branch } = await loadWorkspacePlugins(
    workspaceRoot,
    warnToStderr,
  )
  return {
    workspaceConfig,
    plugins,
    branch,
    cacheDir: resolveCacheDir(workspaceRoot, workspaceConfig),
    storeRoot: () => resolveStoreRoot(workspaceRoot, workspaceConfig),
  }
}

/**
 * The workspace's projects as a run discovers them: the lock's, then the
 * plugin `discover` stage, with the cache dir the run uses. No lock is
 * `NO_LOCK`.
 */
export async function discoverCliProjects(
  root: string,
  load: CliLoadOptions = {},
): Promise<ProjectMeta[]> {
  const ws = await loadCliWorkspace(root)
  return await discoverProjects(
    root,
    lockReader(root),
    ws.plugins,
    stageCacheDir(ws, load),
    warnToStderr,
  )
}

/**
 * The cache dir a plugin stage is told: `--cache-dir` resolved against the
 * working directory as the run resolves it (prepare.ts), else the
 * workspace's. The run reuses what these stages answered.
 */
export function stageCacheDir(ws: { cacheDir: string }, load: CliLoadOptions): string {
  return load.cacheDir === undefined ? ws.cacheDir : path.resolve(process.cwd(), load.cacheDir)
}

/**
 * `//#task`, Turbo's root package, as the root project's id: the name
 * discovery gives it (D-39), for a verb that reads history by task id.
 */
export async function rootSpelled(root: string, target: string): Promise<string> {
  if (!target.startsWith('//#')) return target
  const name = await discoverCliProjects(root).then(
    (metas) => metas.find((m) => m.dir === root)?.name,
    () => undefined,
  )
  return name === undefined ? target : `${name}#${target.slice(3)}`
}

/**
 * `--cache-dir <path>` / `--cache-dir=<path>` for a verb that reads the
 * cache a run wrote — `why`, `last`, `info`, `cache clean`. Same rules as
 * `vx run`'s: a value is required, and the space form refuses a value
 * that looks like a flag (an unquoted empty shell variable would otherwise
 * swallow the next flag as the path). Returns null when `args[i]` is not
 * this flag; `next` is the index of the last argv slot consumed.
 */
export function parseCacheDirFlag(
  args: readonly string[],
  i: number,
): { cacheDir: string; next: number } | { error: string } | null {
  const a = args[i]!
  if (a !== '--cache-dir' && !a.startsWith('--cache-dir=')) return null
  const v = a === '--cache-dir' ? args[i + 1] : a.slice('--cache-dir='.length)
  if (v === undefined || v === '') return { error: '--cache-dir requires a path' }
  if (a === '--cache-dir' && v.startsWith('-')) {
    return {
      error: `--cache-dir requires a path (got flag ${v}; a path that starts with - needs --cache-dir=${v})`,
    }
  }
  return { cacheDir: v, next: a === '--cache-dir' ? i + 1 : i }
}

/**
 * A reading verb's `--cache-dir`, resolved against the working directory.
 * Named explicitly, a directory that is not there is a typo to report, not
 * an empty cache to read (item 900).
 */
export function namedCacheDir(override: string): string {
  const dir = path.resolve(process.cwd(), override)
  if (!existsSync(dir)) {
    throw new UserError(`--cache-dir ${override}: no such directory (${dir})`, 'VX_E_USAGE')
  }
  return dir
}

/**
 * The cache directory a reading verb opens: `--cache-dir` resolved against
 * cwd exactly as `vx run` resolves it (prepare.ts), else the workspace's —
 * so `vx run --cache-dir X` and `vx last --cache-dir X` read one history.
 */
export async function cliCacheDir(
  workspaceRoot: string,
  override: string | undefined,
): Promise<string> {
  if (override !== undefined) return namedCacheDir(override)
  return (await loadCliWorkspace(workspaceRoot)).cacheDir
}

/** The run flags a verb's staged load must honour to see what the run sees. */
export interface CliLoadOptions {
  /** `--cache-dir`: the cache dir a plugin's `project` stage is told. */
  cacheDir?: string
  /**
   * Load what each seed's package closure reaches too, as a run does: a
   * config-less package a configured one depends on gets the default
   * `build` there, and a reader that skipped it showed less than a run.
   */
  closure?: boolean
}

/**
 * The run path's project-config load (`loadProjects`) for a verb that only
 * reads: configs from the lock, the plugin `project` stage applied. `scope`
 * is every project or a list of names; their closure only with `closure`.
 * No lock is `NO_LOCK`, whatever the scope: only `vx lock` evaluates.
 */
export async function loadCliProjects(
  workspaceRoot: string,
  metas: readonly ProjectMeta[],
  scope: 'all' | readonly string[] = 'all',
  opts: CliLoadOptions = {},
): Promise<Map<string, ProjectEntry>> {
  const ws = await loadCliWorkspace(workspaceRoot)
  const { plugins } = ws
  const cacheDir = stageCacheDir(ws, opts)
  const loaded = await loadProjects({
    workspaceRoot,
    cacheDir,
    plugins,
    projectMetas: metas,
    seeds: scope,
    ...(opts.closure === true
      ? { closure: true as const, packageGraph: buildPackageGraph([...metas]) }
      : { closure: false as const }),
    configs: lockOfDiscovery(metas) ?? lockReader(workspaceRoot),
    warn: warnToStderr,
  })
  return loaded.projects
}
