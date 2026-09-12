// `vx info` — workspace doctor printout. One screen of environment +
// workspace + cache facts for bug reports and quick sanity checks.
// `vx stats` is a deprecated alias (info absorbed it).

import { Cache, CACHE_VERSION, noteSchemaReset, SCHEMA_VERSION } from '../cache/index.js'
import { flakyTasks, type FlakyTask, type VxPlugin } from '../orchestrator/index.js'
import { seeHelp } from './help.js'
import { VERSION } from '../version.js'
import {
  loadCliProjects,
  loadCliWorkspace,
  parseCacheDirFlag,
  warnToStderr,
} from './workspace-config.js'
import os from 'node:os'
import path from 'node:path'
import {
  cgroupCpuQuota,
  cgroupMemoryLimitBytes,
  machineMemoryBytes,
  machineParallelism,
} from '../util/index.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  lockfilePath,
  type ProjectMeta,
} from '../workspace/index.js'
import { formatBytes } from './format.js'

export interface InfoArgs {
  format: 'pretty' | 'json'
  /** `--cache-dir`: report on the cache a run with the same flag uses. */
  cacheDir?: string
  error?: string
}

export function parseInfoArgs(args: readonly string[]): InfoArgs {
  const out: InfoArgs = { format: 'pretty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--format' || a?.startsWith('--format=')) {
      const v = a === '--format' ? args[++i] : a.slice('--format='.length)
      if (v !== 'pretty' && v !== 'json') {
        return { ...out, error: `--format must be pretty or json${seeHelp('info')}` }
      }
      out.format = v
      continue
    }
    const cd = parseCacheDirFlag(args, i)
    if (cd !== null) {
      if ('error' in cd) return { ...out, error: cd.error }
      out.cacheDir = cd.cacheDir
      i = cd.next
      continue
    }
    return { ...out, error: `unknown argument: ${a}${seeHelp('info')}` }
  }
  return out
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

export async function infoCmd(args: readonly string[]): Promise<number> {
  const parsed = parseInfoArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx info: ${parsed.error}\n`)
    return 1
  }
  const facts = await collectInfo(process.cwd(), parsed.cacheDir)
  process.stdout.write(
    parsed.format === 'json' ? `${JSON.stringify(facts, null, 2)}\n` : `${renderInfo(facts)}\n`,
  )
  return 0
}

export async function collectInfo(cwd: string, cacheDirOverride?: string): Promise<InfoFacts> {
  const root = await findWorkspaceRoot(cwd)
  const metas = await listProjects(await loadWorkspace(root))
  const ws = await loadCliWorkspace(root)
  const { plugins } = ws
  const cacheDir =
    cacheDirOverride === undefined ? ws.cacheDir : path.resolve(cwd, cacheDirOverride)
  const cache = new Cache(cacheDir)
  noteSchemaReset(cache, warnToStderr)
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
      const loaded = await loadCliProjects(root, metas, 'all', { cacheDir })
      for (const p of loaded.values()) taskCount += Object.keys(p.config.tasks ?? {}).length
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
    workers: workersFact(ws.workspaceConfig?.concurrency),
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

export function renderInfo(f: InfoFacts): string {
  const rows: [string, string][] = [
    ['vx', f.vx],
    ['bun', f.bun],
    ['git', f.git ?? '(not found)'],
    ['git status cache', renderGitStatusCache(f.gitStatusCache)],
    ['workspace root', f.workspaceRoot],
    ['projects', `${f.projects} (${f.tasks} task${f.tasks === 1 ? '' : 's'})`],
    ['plugins', describePlugins(f.plugins)],
    ['workers', describeWorkers(f.workers)],
    ['memory', describeMemory(f.memory)],
    ['cache dir', f.cacheDir],
    ['cache versions', `keys ${f.cacheVersion} · index schema ${f.schemaVersion}`],
    ['cache entries', `${f.cacheEntries} (${formatBytes(f.cacheBytes)})`],
    // Only when there is something to say.
    ...(f.orphans.artifacts > 0
      ? ([
          [
            'orphans',
            `${f.orphans.artifacts} artifact${f.orphans.artifacts === 1 ? '' : 's'} (${formatBytes(f.orphans.bytes)}) the index does not know — \`vx cache prune\` reaps them`,
          ],
        ] as [string, string][])
      : []),
    ['runs (24h)', `${f.runs24h} (${f.hits24h} cache hits)`],
    ['flaky tasks', describeFlakyTasks(f.flakyTasks)],
    ['vx-lock.json', f.lockfile ? 'yes' : 'no'],
  ]
  const labelW = Math.max(...rows.map(([label]) => label.length))
  return rows.map(([label, value]) => `${`${label}:`.padEnd(labelW + 1)} ${value}`).join('\n')
}

/** The seams a plugin can fill, in pipeline order (docs/design/pipeline-2026-09.md). */
const SEAMS = [
  'config',
  'project',
  'graph',
  'key',
  'fingerprint',
  'schedule',
  'admit',
  'executor',
  'cache',
  'telemetry',
  'setup',
  'commands',
] as const

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

/** `4 — the CPU count`, `2 — cgroup CPU quota 2 of 8 cores`, `8 — vx.workspace.ts (4 cores)`. */
export function describeWorkers(w: InfoFacts['workers']): string {
  const quota = w.cpuQuota === null ? '' : `, cgroup CPU quota ${trimCores(w.cpuQuota)}`
  if (w.source === 'workspace') return `${w.count} — vx.workspace.ts (${w.cores} cores${quota})`
  if (w.source === 'cgroup')
    return `${w.count} — cgroup CPU quota ${trimCores(w.cpuQuota ?? w.count)} of ${w.cores} cores`
  return `${w.count} — the CPU count${quota}`
}

/** `13 GB usable — cgroup limit; the machine has 16 GB`, or `16 GB`. */
export function describeMemory(m: InfoFacts['memory']): string {
  if (m.cgroupLimitBytes !== null && m.usableBytes < m.totalBytes) {
    return `${formatBytes(m.usableBytes)} usable — cgroup limit; the machine has ${formatBytes(m.totalBytes)}`
  }
  return formatBytes(m.totalBytes)
}

function trimCores(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '')
}

/** `2 — app#test (3 of 7 runs failed on unchanged inputs); api#e2e (1 of 4)`, or `none`. */
export function describeFlakyTasks(tasks: readonly FlakyTask[]): string {
  if (tasks.length === 0) return 'none'
  const parts = tasks.map(
    (t, i) =>
      `${t.taskId} (${t.failures} of ${t.passes + t.failures} runs failed${i === 0 ? ' on unchanged inputs' : ''})`,
  )
  return `${tasks.length} — ${parts.join('; ')}`
}

export function describePlugins(
  plugins: ReadonlyArray<{ name: string; seams: readonly string[] }>,
): string {
  if (plugins.length === 0) return 'none'
  const parts = plugins.map(
    (p) => `${p.name} (${p.seams.length === 0 ? 'no seams' : p.seams.join(', ')})`,
  )
  return `${plugins.length} — ${parts.join('; ')}`
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

function renderGitStatusCache(c: InfoFacts['gitStatusCache']): string {
  if (c === null) return '(unknown)'
  if (c.fsmonitor && c.untrackedCache) return 'fsmonitor + untrackedCache on'
  const missing = [
    ...(c.fsmonitor ? [] : ['core.fsmonitor']),
    ...(c.untrackedCache ? [] : ['core.untrackedCache']),
  ]
  return `${missing.join(', ')} off`
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
