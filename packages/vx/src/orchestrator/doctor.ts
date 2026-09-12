// The workspace doctor's facts — what `vx info` prints and `vx mcp`'s
// `getWorkspaceInfo` returns: versions, the git status cache, the
// workspace's shape, the plugins and the seams each fills, what a run
// will use (workers, memory) and where those come from, the cache's
// versions and state, the flaky tasks, the lock. One collector, so the
// verb and the agent tool cannot disagree; the CLI renders, this gathers.

import os from 'node:os'
import path from 'node:path'
import { Cache, CACHE_VERSION, noteSchemaReset, SCHEMA_VERSION } from '../cache/index.js'
import { PLUGIN_HOOKS } from '../config.js'
import {
  cgroupCpuQuota,
  cgroupMemoryLimitBytes,
  machineMemoryBytes,
  machineParallelism,
} from '../util/index.js'
import { VERSION } from '../version.js'
import {
  buildPackageGraph,
  computeWorkspaceFingerprint,
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  lockfilePath,
  type ProjectMeta,
  resolveCacheDir,
} from '../workspace/index.js'
import { flakyTasks, type FlakyTask } from './failure-mode.js'
import type { VxPlugin } from './plugin.js'
import { loadProjects, loadWorkspacePlugins } from './projects.js'

const warnToStderr = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

/** The doctor's facts, typed: what `--format json` prints and the pretty rows render. */
export interface InfoFacts {
  vx: string
  bun: string
  git: string | null
  /** null when git could not answer. */
  gitStatusCache: { fsmonitor: boolean; untrackedCache: boolean } | null
  workspaceRoot: string
  projects: number
  tasks: number
  plugins: Array<{ name: string; seams: string[] }>
  /**
   * The worker count a run defaults to and where it comes from: the
   * workspace's `concurrency`, else the cores this process may use — the
   * CPU count capped by a cgroup quota (`cpuQuota`, in cores, null when
   * none binds).
   */
  workers: {
    count: number
    source: 'workspace' | 'cgroup' | 'cores'
    cores: number
    cpuQuota: number | null
  }
  /**
   * What a memory-packing policy budgets: the machine's total capped by
   * the cgroup limit (`cgroupLimitBytes`, null when none binds).
   */
  memory: { usableBytes: number; totalBytes: number; cgroupLimitBytes: number | null }
  cacheDir: string
  cacheVersion: string
  schemaVersion: string
  cacheEntries: number
  cacheBytes: number
  orphans: { artifacts: number; bytes: number }
  runs24h: number
  hits24h: number
  /** Tasks the retained history shows both passing and failing on unchanged inputs. */
  flakyTasks: FlakyTask[]
  lockfile: boolean
}

export interface CollectInfoOptions {
  /** `--cache-dir`: report on the cache a run with the same flag uses. */
  readonly cacheDir?: string
  /** Where a warning (a schema reset, a plugin's note) goes. Default: stderr. */
  readonly warn?: (message: string) => void
}

export async function collectInfo(cwd: string, opts: CollectInfoOptions = {}): Promise<InfoFacts> {
  const warn = opts.warn ?? warnToStderr
  const root = await findWorkspaceRoot(cwd)
  const metas = await listProjects(await loadWorkspace(root))
  const { workspaceConfig, plugins } = await loadWorkspacePlugins(root, warn)
  const cacheDir =
    opts.cacheDir === undefined
      ? resolveCacheDir(root, workspaceConfig)
      : path.resolve(cwd, opts.cacheDir)
  const cache = new Cache(cacheDir)
  noteSchemaReset(cache, warn)
  let stats
  let orphans
  let flaky: FlakyTask[]
  let taskCount = 0
  try {
    stats = cache.stats()
    orphans = await cache.orphanStats()
    flaky = flakyTasks(cache.dbHandle())
    // The run path's load — a plugin's `project` stage counts — so the
    // doctor's task count is the number a run would see. A broken config
    // must not take the doctor down with it: the count then falls back to
    // the configs that do load, one by one, the broken ones as zero.
    try {
      const loaded = await loadProjects({
        workspaceRoot: root,
        cacheDir,
        plugins,
        projectMetas: metas,
        packageGraph: buildPackageGraph([...metas]),
        seeds: 'all',
        closure: false,
        lock: null,
        evalCache: { store: cache, workspaceFingerprint: await computeWorkspaceFingerprint(root) },
        warn,
      })
      for (const p of loaded.projects.values()) {
        taskCount += Object.keys(p.config.tasks ?? {}).length
      }
    } catch {
      taskCount = await countLoadableTasks(metas)
    }
  } finally {
    cache.close()
  }

  const lockPresent = await Bun.file(lockfilePath(root)).exists()
  return {
    vx: VERSION,
    bun: Bun.version,
    git: gitVersion(),
    // The one `git status` walk per run is the warm path's critical path on
    // a large tree (~55 ms at 1000 projects, measured 2026-09-02). git's
    // own caches make it near-free after the first run, and they are OFF by
    // default — say so, since nothing else in a run would.
    gitStatusCache: gitStatusCache(root),
    workspaceRoot: root,
    projects: metas.length,
    tasks: taskCount,
    // Which plugins loaded and which seams each fills, in pipeline order —
    // the answer to "why did this task run there / cache there / not at
    // all" before reading any config. A declined seam still costs nothing;
    // this names the declarations, not what a run consulted.
    plugins: plugins.map((p) => ({ name: p.name, seams: filledSeams(p) })),
    workers: workersFact(workspaceConfig?.concurrency),
    memory: memoryFact(),
    cacheDir,
    // The two versions a bug report needs and the reset notice names: the
    // key prefix (a bump orphans every entry) and the index schema (a
    // mismatch drops every table).
    cacheVersion: CACHE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    cacheEntries: stats.entryCount,
    cacheBytes: stats.totalBytes,
    // The index is authoritative, so a row-less artifact is bytes nothing
    // will ever hit — and only `vx cache prune` reclaims them (after an
    // upgrade's schema reset, most often).
    orphans: { artifacts: orphans.orphans, bytes: orphans.orphanBytes },
    runs24h: stats.runCountLast24h,
    hits24h: stats.hitCountLast24h,
    // Same inputs, both outcomes — the history's definition of flaky, over
    // the 30 days it keeps. A run names its own findings in its footer;
    // this is the workspace's standing list.
    flakyTasks: flaky,
    lockfile: lockPresent,
  }
}

/** The seams a plugin can fill, in pipeline order: the one hook list, less the lifecycle end. */
const SEAMS = PLUGIN_HOOKS.filter((h) => h !== 'teardown')

function filledSeams(p: VxPlugin): string[] {
  return SEAMS.filter((s) => p[s as keyof VxPlugin] !== undefined)
}

/**
 * Inside a container the CPU count and `os.totalmem()` are the HOST's; the
 * cgroup is what the kernel enforces, and a run that used the host's
 * numbers would be the OOM killer's. The doctor says which one a run
 * reads, because nothing else would.
 */
function workersFact(workspaceConcurrency: number | undefined): InfoFacts['workers'] {
  const cores = Math.max(1, navigator.hardwareConcurrency)
  const quota = process.platform === 'linux' ? (cgroupCpuQuota() ?? null) : null
  if (workspaceConcurrency !== undefined) {
    return { count: workspaceConcurrency, source: 'workspace', cores, cpuQuota: quota }
  }
  const machine = machineParallelism()
  return { count: machine, source: machine < cores ? 'cgroup' : 'cores', cores, cpuQuota: quota }
}

function memoryFact(): InfoFacts['memory'] {
  const totalBytes = os.totalmem()
  const limit = process.platform === 'linux' ? (cgroupMemoryLimitBytes() ?? null) : null
  return { usableBytes: machineMemoryBytes(), totalBytes, cgroupLimitBytes: limit }
}

/**
 * Whether git's fsmonitor / untracked cache are on. Reported as a fact,
 * not a remedy: interleaved A/B at 1000 projects measured neither moving
 * the warm run (STATUS, waves 5 and the 2026-09-03 refutations) — the
 * status walk's cost is git's own, and vx already overlaps it.
 */
function gitStatusCache(root: string): InfoFacts['gitStatusCache'] {
  try {
    const p = Bun.spawnSync({
      cmd: ['git', 'config', '--get-regexp', '^core\\.(fsmonitor|untrackedcache)$'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // exit 1 is git's "no key matched": both off, still an answer.
    if (p.exitCode !== 0 && p.exitCode !== 1) return null
    const out = p.exitCode === 0 ? new TextDecoder().decode(p.stdout) : ''
    const on = (key: string): boolean =>
      new RegExp(`^core\\.${key} (true|1|yes|on)$`, 'im').test(out)
    return { fsmonitor: on('fsmonitor'), untrackedCache: on('untrackedcache') }
  } catch {
    return null
  }
}

function gitVersion(): string | null {
  try {
    const p = Bun.spawnSync({ cmd: ['git', '--version'], stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) return null
    return new TextDecoder()
      .decode(p.stdout)
      .trim()
      .replace(/^git version /, '')
  } catch {
    return null
  }
}

async function countLoadableTasks(metas: readonly ProjectMeta[]): Promise<number> {
  let count = 0
  await Promise.all(
    metas.map(async (meta) => {
      if (meta.configPath === null) return
      try {
        const config = await loadProjectConfig(meta.configPath)
        count += Object.keys(config.tasks ?? {}).length
      } catch {
        // counted as zero
      }
    }),
  )
  return count
}
