// The workspace doctor's facts — what `vx info` prints and its JSON
// returns: versions, the git status cache, the
// workspace's shape, the plugins and the seams each fills, what a run
// will use (workers, memory) and where those come from, the cache's
// versions and state, the flaky tasks, the lock. One collector, so the
// verb and the agent tool cannot disagree; the CLI renders, this gathers.

import os from 'node:os'
import path from 'node:path'
import { Cache, CACHE_VERSION, SCHEMA_VERSION } from '../cache/index.js'
import { PLUGIN_HOOKS, type WorkspaceConfig } from '../config.js'
import {
  cgroupCpuQuota,
  cgroupMemoryLimitBytes,
  executablePath,
  gitEnv,
  isUnsupportedBun,
  isUserError,
  machineMemoryBytes,
  machineParallelism,
  treeBytes,
} from '../util/index.js'
import { vxPath } from '../handoff.js'
import { VERSION } from '../version.js'
import { probeSandbox, resetSandbox, untracedReason } from '../exec/index.js'
import {
  findWorkspaceRoot,
  lockfilePath,
  resolveCacheDir,
  resolveStoreRoot,
} from '../workspace/index.js'
import { flakyTasks, type FlakyTask } from '../history/index.js'
import type { VxPlugin } from './plugin.js'
import { discoverProjects, loadProjects, loadWorkspacePlugins, lockReader } from './projects.js'
import { atPath, envName, resolveSetting, SETTINGS, type SettingSource } from '../settings.js'

const warnToStderr = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

/** The doctor's facts, typed: what `--format json` prints and the pretty rows render. */
export interface InfoFacts {
  vx: string
  /** The file that ran: the compiled binary, or the source entry. */
  vxPath: string
  /** The vx that handed this call to the project's own (`VX_HANDED_OFF`), else null. */
  handedOffFrom: string | null
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
  plugins: Array<{ name: string; seams: string[] }>
  /**
   * The worker count a run defaults to and where it comes from:
   * `run.concurrency` (variable, then workspace), else the cores this process may use — the
   * CPU count capped by a cgroup quota (`cpuQuota`, in cores, null when
   * none binds).
   */
  workers: {
    count: number
    source: 'env' | 'workspace' | 'cgroup' | 'cores'
    cores: number
    cpuQuota: number | null
  }
  /**
   * What a memory-packing policy budgets: the machine's total capped by
   * the cgroup limit (`cgroupLimitBytes`, null when none binds).
   */
  memory: { usableBytes: number; totalBytes: number; cgroupLimitBytes: number | null }
  cacheDir: string
  /** Bytes on disk under `cacheDir`: the index and run history, and the entries when no store holds them. */
  cacheDirBytes: number
  /** The shared store holding the entries, or null when `cacheDir` holds them. */
  cacheStore: string | null
  /** Bytes on disk under `cacheStore`, shared by the repo's checkouts; null with no store. */
  cacheStoreBytes: number | null
  cacheVersion: string
  schemaVersion: string
  cacheEntries: number
  cacheBytes: number
  /**
   * Why the cache index cannot be read (a file SQLite cannot open, and its
   * fix); null when it reads. While set, the counts it holds read zero.
   */
  cacheIndexError: string | null
  /**
   * Every setting (src/settings.ts) as a run with no flags takes it: its
   * variable's value, else the workspace's (after the `config` stage),
   * else null with source `default` (docs/schema.md names each default).
   */
  settings: Record<
    string,
    { value: string | number | boolean | null; source: 'env' | 'workspace' | 'default' }
  >
  orphans: { artifacts: number; bytes: number }
  runs24h: number
  hits24h: number
  /** Of `hits24h`, the hits that restored outputs; the rest were up to date. */
  restored24h: number
  /** Tasks the retained history shows failing on a key that had passed. */
  flakyTasks: FlakyTask[]
  lockfile: boolean
  /**
   * Whether this host can run a task's `exec.sandbox`, and how many loaded
   * tasks declare one. A declared sandbox whose runtime cannot start is a
   * hard failure at run time, not a downgrade — so the doctor says so
   * first (root inside a container, a missing bubblewrap, a nested
   * seatbelt), with the probe's own reason. `untraced` is why an available
   * Linux sandbox cannot report the reads it denied (no `strace`, or one
   * that may not attach), else null: the sandbox still enforces, and a task
   * that tolerates a denied read passes with no word of it.
   */
  sandbox: { available: boolean; reason: string; declared: number; untraced: string | null }
}

export interface CollectInfoOptions {
  /** `--cache-dir`: report on the cache a run with the same flag uses. */
  readonly cacheDir?: string
  /** Where a warning (a schema reset, a plugin's note) goes. Default: stderr. */
  readonly warn?: (message: string) => void
}

export async function collectInfo(cwd: string, opts: CollectInfoOptions = {}): Promise<InfoFacts> {
  const warn = opts.warn ?? warnToStderr
  // Both first: outside a workspace, or under a workspace config that does
  // not load, the doctor refuses at once, with no probe (~180 ms) ahead.
  const root = await findWorkspaceRoot(cwd)
  const workspace = await loadWorkspacePlugins(root, warn)
  // The sandbox probe asks nothing of the workspace, so it runs under the
  // loads below instead of after them. Awaited on every path: it resets
  // the runtime it brought up, whose sockets would hold the process open.
  const probing = sandboxProbe()
  // Rejects only if the reset does; awaited below, never unhandled.
  probing.catch(() => {})
  try {
    return await collectWorkspaceInfo(cwd, root, workspace, opts, probing)
  } catch (err) {
    // The workspace's refusal is the error worth reporting.
    await probing.catch(() => {})
    throw err
  }
}

async function collectWorkspaceInfo(
  cwd: string,
  root: string,
  { workspaceConfig, plugins }: Awaited<ReturnType<typeof loadWorkspacePlugins>>,
  opts: CollectInfoOptions,
  probing: Promise<Omit<InfoFacts['sandbox'], 'declared'>>,
): Promise<InfoFacts> {
  const warn = opts.warn ?? warnToStderr
  const cacheDir =
    opts.cacheDir === undefined
      ? resolveCacheDir(root, workspaceConfig)
      : path.resolve(cwd, opts.cacheDir)
  // The lock's projects: none without a lock, or with one a run would
  // refuse, which is `vx lock`'s to report.
  const lock = lockReader(root)
  const held = await lock().then(
    () => true,
    (err: unknown) => {
      if (!isUserError(err)) throw err
      return false
    },
  )
  const metas = held ? await discoverProjects(root, lock, plugins, cacheDir, warn) : []
  const storeRoot =
    opts.cacheDir === undefined ? await resolveStoreRoot(root, workspaceConfig) : null
  // The index is read first and alone: one SQLite cannot read is a fact
  // of the report, with its fix, not a refusal of it — the doctor is where
  // a broken setup is diagnosed.
  let stats: ReturnType<Cache['stats']> = {
    entryCount: 0,
    totalBytes: 0,
    runCountLast24h: 0,
    hitCountLast24h: 0,
    restoredCountLast24h: 0,
  }
  let orphans = { orphans: 0, orphanBytes: 0 }
  let flaky: FlakyTask[] = []
  let indexError: string | null = null
  let indexStore: string | undefined
  try {
    const cache = new Cache(cacheDir, undefined, undefined, undefined, 'inspect', storeRoot)
    try {
      indexStore = cache.storeDir
      stats = cache.stats()
      orphans = await cache.orphanStats()
      flaky = flakyTasks(cache.dbHandle())
    } finally {
      cache.close()
    }
  } catch (err) {
    if (!isUserError(err)) throw err
    indexError = err.message
  }
  let taskCount = 0
  let sandboxed = 0
  // The run path's load — the lock, a plugin's `project` stage counted —
  // so the doctor's task count is the number a run would see. No lock, or
  // one a run would refuse, counts zero: broken configs are `vx lock`'s
  // to report.
  try {
    const loaded = await loadProjects({
      workspaceRoot: root,
      cacheDir,
      plugins,
      projectMetas: metas,
      seeds: 'all',
      closure: false,
      configs: lock,
      warn,
    })
    for (const p of loaded.projects.values()) {
      const tasks = p.config.tasks ?? {}
      taskCount += Object.keys(tasks).length
      for (const t of Object.values(tasks)) if (t?.exec?.sandbox !== undefined) sandboxed++
    }
  } catch (err) {
    if (!isUserError(err)) throw err
    taskCount = 0
    sandboxed = 0
  }

  const lockPresent = await Bun.file(lockfilePath(root)).exists()
  // Asked while the probe runs: each is a synchronous spawn.
  const git = gitVersion()
  const statusCache = gitStatusCache(root)
  const sandbox = { ...(await probing), declared: sandboxed }
  const cacheStore = indexStore ?? storeRoot
  return {
    vx: VERSION,
    vxPath: vxPath(),
    handedOffFrom: process.env['VX_HANDED_OFF'] ?? null,
    // An unsupported Bun does not stop a run, it makes the run's ANSWERS
    // wrong (util/bun-version.ts measures which). The row a reader already
    // consults for "is my setup sane" is where that belongs: a warning on
    // every invocation would put a line on stderr that a clean run must not
    // have, which is a property 19 tests hold on purpose.
    bun: Bun.version,
    bunSupported: !isUnsupportedBun(Bun.version),
    git,
    // The one `git status` walk per run is the warm path's critical path on
    // a large tree (~55 ms at 1000 projects, measured 2026-09-02). git's
    // own caches make it near-free after the first run, and they are OFF by
    // default — say so, since nothing else in a run would.
    gitStatusCache: statusCache,
    workspaceRoot: root,
    projects: metas.length,
    tasks: taskCount,
    // Which plugins loaded and which seams each fills, in pipeline order —
    // the answer to "why did this task run there / cache there / not at
    // all" before reading any config. A declined seam still costs nothing;
    // this names the declarations, not what a run consulted.
    plugins: plugins.map((p) => ({ name: p.name, seams: filledSeams(p) })),
    workers: workersFact(resolveSetting('run.concurrency', workspaceConfig)),
    memory: memoryFact(),
    cacheDir,
    // On disk, not the index's sum: the size `vx cache clean` would free.
    cacheDirBytes: treeBytes(cacheDir),
    // The store the index records, else the one a first run would open.
    cacheStore,
    cacheStoreBytes: cacheStore === null ? null : treeBytes(cacheStore),
    // The two versions a bug report needs and the reset notice names: the
    // key prefix (a bump orphans every entry) and the index schema (a
    // mismatch drops every table).
    cacheVersion: CACHE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    cacheEntries: stats.entryCount,
    cacheBytes: stats.totalBytes,
    cacheIndexError: indexError,
    settings: settingsFact(workspaceConfig),
    // A row-less artifact is indexed again only when its task asks for its
    // key; the rest only `vx cache clean` reclaims (after an upgrade's
    // schema reset, most often).
    orphans: { artifacts: orphans.orphans, bytes: orphans.orphanBytes },
    runs24h: stats.runCountLast24h,
    hits24h: stats.hitCountLast24h,
    restored24h: stats.restoredCountLast24h,
    // A key that failed after it had passed — the history's definition of flaky, over
    // the 30 days it keeps. A run names its own findings in its footer;
    // this is the workspace's standing list.
    flakyTasks: flaky,
    lockfile: lockPresent,
    sandbox,
  }
}

/**
 * The runtime probe's verdict — one sandboxed `true` (memoized). The probe
 * initializes the Linux runtime, whose proxy sockets would keep a
 * standalone process alive; reset after asking, since the doctor runs
 * nothing.
 */
async function sandboxProbe(): Promise<Omit<InfoFacts['sandbox'], 'declared'>> {
  try {
    const verdict = await probeSandbox()
    const untraced = verdict.available ? await untracedReason() : null
    return { available: verdict.available, reason: stableSandboxReason(verdict.reason), untraced }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { available: false, reason: stableSandboxReason(message), untraced: null }
  } finally {
    await resetSandbox()
  }
}

/**
 * The doctor's output is pasted into bug reports and compared between
 * invocations, so a
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
function workersFact(set: { value: unknown; source: SettingSource }): InfoFacts['workers'] {
  const cores = Math.max(1, navigator.hardwareConcurrency)
  const quota = process.platform === 'linux' ? (cgroupCpuQuota() ?? null) : null
  if (set.source === 'env' || set.source === 'workspace') {
    return { count: set.value as number, source: set.source, cores, cpuQuota: quota }
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
export function gitStatusCache(root: string): InfoFacts['gitStatusCache'] {
  try {
    const p = Bun.spawnSync({
      cmd: [executablePath('git'), 'config', '--get-regexp', '^core\\.(fsmonitor|untrackedcache)$'],
      env: gitEnv(),
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // exit 1 is git's "no key matched": both off, still an answer.
    if (p.exitCode !== 0 && p.exitCode !== 1) return null
    const out = p.exitCode === 0 ? new TextDecoder().decode(p.stdout) : ''
    // The last value set wins, as git reads it (a global `true` under a
    // repo's `false` is off), and a key with no `=` is true.
    const last = new Map<string, string | null>()
    for (const line of out.split('\n')) {
      if (line === '') continue
      const sp = line.indexOf(' ')
      last.set(
        (sp === -1 ? line : line.slice(0, sp)).toLowerCase(),
        sp === -1 ? null : line.slice(sp + 1),
      )
    }
    const on = (key: string, hook: boolean): boolean => {
      const v = last.get(`core.${key}`)
      if (v === undefined) return false
      if (v === null || /^(true|yes|on|1)$/i.test(v)) return true
      // core.fsmonitor may name a hook command instead of a boolean.
      return hook && v !== '' && !/^(false|no|off|0)$/i.test(v)
    }
    return { fsmonitor: on('fsmonitor', true), untrackedCache: on('untrackedcache', false) }
  } catch {
    return null
  }
}

function gitVersion(): string | null {
  try {
    const p = Bun.spawnSync({
      cmd: [executablePath('git'), '--version'],
      env: gitEnv(),
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

function settingsFact(config: WorkspaceConfig | null): InfoFacts['settings'] {
  const out: InfoFacts['settings'] = {}
  for (const s of SETTINGS) {
    const env = s.env === false ? undefined : process.env[envName(s.path)]
    const declared = s.config === false ? undefined : atPath(config, s.path)
    out[s.path] =
      env !== undefined && env !== ''
        ? { value: env, source: 'env' }
        : declared !== undefined
          ? { value: declared as string | number | boolean, source: 'workspace' }
          : { value: null, source: 'default' }
  }
  return out
}
