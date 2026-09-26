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
  executablePath,
  isUnsupportedBun,
  machineMemoryBytes,
  machineParallelism,
} from '../util/index.js'
import { VERSION } from '../version.js'
import { probeSandbox, resetSandbox } from '../exec/index.js'
import {
  buildPackageGraph,
  computeWorkspaceFingerprint,
  findWorkspaceRoot,
  type LoadReads,
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
  /**
   * False when `bun` is below `MIN_BUN`. A separate field on purpose: `bun`
   * is a machine surface (`vx info --format json`, and a test holds it to
   * `Bun.version` exactly), so the verdict is a boolean here and prose only
   * in the rendered row. What an unsupported runtime breaks is measured in
   * `util/bun-version.ts`.
   */
  bunSupported: boolean
  git: string | null
  /** null when git could not answer. */
  gitStatusCache: { fsmonitor: boolean; untrackedCache: boolean } | null
  workspaceRoot: string
  projects: number
  tasks: number
  /**
   * The project configs that did not load, each with the loader's own
   * message (the path stripped). A broken config counts as zero tasks
   * rather than failing the doctor — and the doctor says which, since a
   * `0 tasks` that hides a typo is the one fact a bug report needs.
   */
  configErrors: Array<{ path: string; message: string }>
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
  /**
   * Whether this host can run a task's `exec.sandbox`, and how many loaded
   * tasks declare one. A declared sandbox whose runtime cannot start is a
   * hard failure at run time, not a downgrade — so the doctor says so
   * first (root inside a container, a missing bubblewrap, a nested
   * seatbelt), with the probe's own reason.
   */
  sandbox: { available: boolean; reason: string; declared: number }
}

export interface CollectInfoOptions {
  /** `--cache-dir`: report on the cache a run with the same flag uses. */
  readonly cacheDir?: string
  /** Where a warning (a schema reset, a plugin's note) goes. Default: stderr. */
  readonly warn?: (message: string) => void
}

export async function collectInfo(cwd: string, opts: CollectInfoOptions = {}): Promise<InfoFacts> {
  const warn = opts.warn ?? warnToStderr
  const reads: LoadReads = new Map()
  const root = await findWorkspaceRoot(cwd, reads)
  const metas = await listProjects(await loadWorkspace(root, reads))
  const { workspaceConfig, plugins } = await loadWorkspacePlugins(root, warn)
  const cacheDir =
    opts.cacheDir === undefined
      ? resolveCacheDir(root, workspaceConfig)
      : path.resolve(cwd, opts.cacheDir)
  const cache = Cache.inspect(cacheDir)
  noteSchemaReset(cache, warn)
  let stats
  let orphans
  let flaky: FlakyTask[]
  let taskCount = 0
  let sandboxed = 0
  let configErrors: InfoFacts['configErrors'] = []
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
        evalCache: {
          store: cache,
          workspaceFingerprint: await computeWorkspaceFingerprint(root, reads),
        },
        warn,
      })
      for (const p of loaded.projects.values()) {
        const tasks = p.config.tasks ?? {}
        taskCount += Object.keys(tasks).length
        for (const t of Object.values(tasks)) if (t?.exec?.sandbox !== undefined) sandboxed++
      }
    } catch {
      // A config that will not load counts as zero, for both numbers: the
      // sandbox row's "N tasks declare" must not read 0 because one other
      // project's config is broken while this one's declares a sandbox.
      ;({
        tasks: taskCount,
        sandboxed,
        errors: configErrors,
      } = await countLoadableTasks(metas, root))
    }
  } finally {
    cache.close()
  }

  const lockPresent = await Bun.file(lockfilePath(root)).exists()
  const sandbox = await sandboxFact(sandboxed)
  return {
    vx: VERSION,
    // An unsupported Bun does not stop a run, it makes the run's ANSWERS
    // wrong (util/bun-version.ts measures which). The row a reader already
    // consults for "is my setup sane" is where that belongs: a warning on
    // every invocation would put a line on stderr that a clean run must not
    // have, which is a property 19 tests hold on purpose.
    bun: Bun.version,
    bunSupported: !isUnsupportedBun(Bun.version),
    git: gitVersion(),
    // The one `git status` walk per run is the warm path's critical path on
    // a large tree (~55 ms at 1000 projects, measured 2026-09-02). git's
    // own caches make it near-free after the first run, and they are OFF by
    // default — say so, since nothing else in a run would.
    gitStatusCache: gitStatusCache(root),
    workspaceRoot: root,
    projects: metas.length,
    tasks: taskCount,
    configErrors,
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
    sandbox,
  }
}

/**
 * The runtime probe's verdict — one sandboxed `true` (memoized) — and the
 * count of loaded tasks that would meet it. The probe initializes the
 * Linux runtime, whose proxy sockets would keep a standalone process
 * alive; reset after asking, since the doctor runs nothing.
 */
async function sandboxFact(declared: number): Promise<InfoFacts['sandbox']> {
  try {
    const verdict = await probeSandbox()
    return { available: verdict.available, reason: stableSandboxReason(verdict.reason), declared }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { available: false, reason: stableSandboxReason(message), declared }
  } finally {
    await resetSandbox()
  }
}

/**
 * The doctor's output is pasted into bug reports and compared between
 * invocations (`vx stats` is pinned byte-identical to `vx info`), so a
 * reason must not carry this process's id. The Linux runtime names its
 * mux socket after the pid (`srt-mux-<pid>-<n>.sock`), and a listen that
 * fails — a nested sandbox, a read-only tmpdir — quotes that path.
 */
export function stableSandboxReason(reason: string): string {
  return reason.replace(/srt-mux-\d+-\d+\.sock/g, 'srt-mux-<pid>.sock')
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
      cmd: [executablePath('git'), 'config', '--get-regexp', '^core\\.(fsmonitor|untrackedcache)$'],
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
    const p = Bun.spawnSync({
      cmd: [executablePath('git'), '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) return null
    return new TextDecoder()
      .decode(p.stdout)
      .trim()
      .replace(/^git version /, '')
  } catch {
    return null
  }
}

async function countLoadableTasks(
  metas: readonly ProjectMeta[],
  root: string,
): Promise<{ tasks: number; sandboxed: number; errors: InfoFacts['configErrors'] }> {
  let tasks = 0
  let sandboxed = 0
  const errors: InfoFacts['configErrors'] = []
  await Promise.all(
    metas.map(async (meta) => {
      if (meta.configPath === null) return
      try {
        const config = await loadProjectConfig(meta.configPath)
        const declared = Object.values(config.tasks ?? {})
        tasks += declared.length
        for (const t of declared) if (t?.exec?.sandbox !== undefined) sandboxed++
      } catch (err) {
        // Counted as zero, and named: the loader's message opens with the
        // absolute path — bare for a schema refusal, behind `Project config`
        // for an import that failed — which the row carries
        // workspace-relative instead, once (the second form named the file
        // twice, 2026-09-16).
        const raw = err instanceof Error ? err.message : String(err)
        let message = raw
        for (const prefix of [`${meta.configPath}: `, `Project config ${meta.configPath}: `]) {
          if (raw.startsWith(prefix)) {
            message = raw.slice(prefix.length)
            break
          }
        }
        errors.push({
          path: path.relative(root, meta.configPath).split(path.sep).join('/'),
          message,
        })
      }
    }),
  )
  errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { tasks, sandboxed, errors }
}
